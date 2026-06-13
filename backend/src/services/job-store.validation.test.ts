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
