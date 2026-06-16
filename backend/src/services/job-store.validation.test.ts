/**
 * Unit tests for validateJobDefinition()'s template-reference reachability
 * analysis: a {{steps.X.outputs.*}} ref must be rejected at definition time
 * unless X is guaranteed to run before the referencing step on every
 * control-flow path (otherwise it fails mid-run — see job-template.ts).
 *
 * validateJobDefinition is a pure function; importing job-store only creates
 * the (idempotent) data directories.
 */
import { describe, expect, it } from "vitest";

import { validateJobDefinition } from "./job-store.js";
import type { JobDefinitionInput } from "./job-store.js";

function validate(steps: JobDefinitionInput["steps"], extra?: Partial<JobDefinitionInput>): string[] {
  return validateJobDefinition({ id: "test-job", name: "Test Job", steps, ...extra });
}

/** Errors specifically about an unresolvable forward/unreachable ref. */
function refErrors(errors: string[]): string[] {
  return errors.filter((e) => e.includes("not guaranteed to run before"));
}

describe("validateJobDefinition — template reference reachability", () => {
  it("accepts a backward (earlier-step) reference on the sequential path", () => {
    const errors = validate([
      { id: "plan", type: "agent", prompt: "Plan it", outputs: ["plan_md"] },
      { id: "work", type: "agent", prompt: "Do {{steps.plan.outputs.plan_md}}" },
    ]);
    expect(errors).toEqual([]);
  });

  it("rejects a forward reference to a step that only runs later (the repro)", () => {
    // `work` references `review`, but `review` runs AFTER `work` with no path
    // back — the original runtime failure, now caught at definition time.
    const errors = validate([
      { id: "work", type: "agent", prompt: "Use {{steps.review.outputs.notes}}" },
      { id: "review", type: "agent", prompt: "Review the work", outputs: ["notes"] },
    ]);
    const refs = refErrors(errors);
    expect(refs.length).toBe(1);
    expect(refs[0]).toContain('step "work"');
    expect(refs[0]).toContain("{{steps.review.outputs.notes}}");
    expect(refs[0]).toContain("Unresolved template reference(s)");
  });

  it("accepts a rework step that loops back and references an earlier review", () => {
    // plan-executor v4 shape: `work` skips `rework` on the first pass; the
    // gate's onFail loops back to `rework`, which is only reachable after
    // `review` has run — so its {{steps.review.outputs.notes}} ref is valid
    // even though `review` appears later in the array.
    const errors = validate(
      [
        { id: "plan", type: "agent", prompt: "Plan: {{inputs.task}}", outputs: ["plan_md"] },
        { id: "work", type: "agent", prompt: "Do {{steps.plan.outputs.plan_md}}", outputs: ["result"], next: "review" },
        { id: "rework", type: "agent", prompt: "Address {{steps.review.outputs.notes}}", outputs: ["result"], next: "review" },
        { id: "review", type: "agent", prompt: "Review {{steps.work.outputs.result}}", outputs: ["verdict", "notes"] },
        {
          id: "gate",
          type: "gate",
          condition: { all: [{ ref: "steps.review.outputs.verdict", op: "eq", value: "approved" }] },
          onPass: "end",
          onFail: "rework",
          maxLoops: 5,
        },
      ] as JobDefinitionInput["steps"],
      { inputs: [{ key: "task" }] },
    );
    expect(refErrors(errors)).toEqual([]);
  });

  it("rejects a self-reference (a step cannot read its own outputs)", () => {
    const errors = validate([{ id: "work", type: "agent", prompt: "Loop on {{steps.work.outputs.x}}", outputs: ["x"] }]);
    expect(refErrors(errors).length).toBe(1);
    expect(refErrors(errors)[0]).toContain('step "work"');
  });

  it("rejects a reference that resolves on one gate branch but not the other", () => {
    // `produce` runs only on the gate's onPass branch, so `consume` reached
    // via onFail would have no output to read — not dominated, so rejected.
    const errors = validate([
      { id: "start", type: "agent", prompt: "start", outputs: ["v"] },
      {
        id: "gate",
        type: "gate",
        condition: { all: [{ ref: "steps.start.outputs.v", op: "exists" }] },
        onPass: "produce",
        onFail: "consume",
      },
      { id: "produce", type: "agent", prompt: "produce", outputs: ["data"], next: "consume" },
      { id: "consume", type: "agent", prompt: "Use {{steps.produce.outputs.data}}" },
    ]);
    expect(refErrors(errors).length).toBe(1);
    expect(refErrors(errors)[0]).toContain('step "consume"');
  });

  it("still flags references to entirely unknown steps", () => {
    const errors = validate([{ id: "work", type: "agent", prompt: "Use {{steps.ghost.outputs.x}}" }]);
    expect(errors.some((e) => e.includes("unknown step"))).toBe(true);
  });
});

describe("validateJobDefinition — parallel steps", () => {
  it("accepts basic race and all parallel definitions and later aggregate refs", () => {
    const errors = validate(
      [
        {
          id: "compare",
          type: "parallel",
          mode: "race",
          branches: [
            { id: "opus", type: "agent", prompt: "Solve {{inputs.task}}", outputs: ["answer"] },
            { id: "sonnet", type: "agent", prompt: "Solve {{inputs.task}}", outputs: ["answer"] },
          ],
        },
        {
          id: "checks",
          type: "parallel",
          mode: "all",
          branches: [
            { id: "tests", type: "agent", prompt: "Check {{steps.compare.outputs._winner}}", outputs: ["result"] },
            { id: "lint", type: "agent", prompt: "Check {{steps.compare.outputs._winnerOutputs.answer}}", outputs: ["result"] },
          ],
        },
        { id: "summarize", type: "agent", prompt: "Tests: {{steps.checks.outputs.tests.result}}" },
      ] as JobDefinitionInput["steps"],
      { inputs: [{ key: "task" }] },
    );
    expect(errors).toEqual([]);
  });

  it("rejects invalid v1 branch shapes", () => {
    const errors = validate([
      {
        id: "p",
        type: "parallel",
        mode: "all",
        branches: [
          { id: "a", type: "agent", prompt: "A", next: "done" },
          { id: "a", type: "agent", prompt: "A2" },
          { id: "_winner", type: "agent", prompt: "reserved" },
          { id: "done", type: "agent", prompt: "collision" },
          { id: "poller", type: "poll", prompt: "no", intervalMinutes: 1, maxAttempts: 1 },
          { id: "retry", type: "agent", prompt: "retry", retry: { attempts: 2 } },
        ],
      },
      { id: "done", type: "agent", prompt: "Done" },
    ] as JobDefinitionInput["steps"]);
    expect(errors.some((e) => e.includes("branch-level next"))).toBe(true);
    expect(errors.some((e) => e.includes('duplicate branch id "a"'))).toBe(true);
    expect(errors.some((e) => e.includes("reserved"))).toBe(true);
    expect(errors.some((e) => e.includes("collides with a top-level step id"))).toBe(true);
    expect(errors.some((e) => e.includes('must be type "agent"'))).toBe(true);
    expect(errors.some((e) => e.includes("branch-level retry"))).toBe(true);
  });

  it("rejects branch prompts that reference sibling or parent outputs", () => {
    const errors = validate([
      {
        id: "p",
        type: "parallel",
        mode: "all",
        branches: [
          { id: "a", type: "agent", prompt: "A", outputs: ["x"] },
          { id: "b", type: "agent", prompt: "Use {{steps.p.outputs.a.x}}" },
        ],
      },
    ] as JobDefinitionInput["steps"]);
    expect(refErrors(errors).length).toBe(1);
    expect(refErrors(errors)[0]).toContain('step "p"');
  });
});
