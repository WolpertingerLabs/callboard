import { describe, it, expect } from "vitest";
import type { GateJobStep } from "shared";
import { evaluateGate, interpolate, type JobRunContext } from "./job-template.js";

function ctx(): JobRunContext {
  return {
    inputs: { topic: "permissions" },
    steps: { plan: { outputs: { items: ["a", "b"], nested: { ok: true } }, verdict: "pass" } },
    run: { id: "run-1", jobId: "job-1" },
  };
}

function gate(ref: string, op: "exists" | "not_exists"): GateJobStep {
  return { condition: { all: [{ ref, op }] } } as unknown as GateJobStep;
}

describe("interpolate — own keys only", () => {
  it("still resolves own keys, nested objects, array indices and array length", () => {
    expect(interpolate("{{inputs.topic}}", ctx())).toBe("permissions");
    expect(interpolate("{{steps.plan.outputs.nested.ok}}", ctx())).toBe("true");
    expect(interpolate("{{steps.plan.outputs.items.1}}", ctx())).toBe("b");
    expect(interpolate("{{steps.plan.outputs.items.length}}", ctx())).toBe("2");
  });

  it.each(["inputs.toString", "inputs.constructor", "inputs.__proto__", "inputs.hasOwnProperty", "steps.plan.outputs.items.map", "run.valueOf"])(
    "throws on the inherited property {{%s}} instead of interpolating it",
    (ref) => {
      expect(() => interpolate(`{{${ref}}}`, ctx())).toThrow(`Unresolved template reference(s): {{${ref}}}`);
    },
  );

  it("does not walk into a string's properties", () => {
    expect(() => interpolate("{{inputs.topic.length}}", ctx())).toThrow("Unresolved template reference");
  });
});

describe("evaluateGate — own keys only", () => {
  it("an exists gate on an inherited property is false, and not_exists is true", () => {
    expect(evaluateGate(gate("inputs.constructor", "exists"), ctx())).toBe(false);
    expect(evaluateGate(gate("inputs.toString", "not_exists"), ctx())).toBe(true);
  });

  it("an exists gate on an own key is still true", () => {
    expect(evaluateGate(gate("inputs.topic", "exists"), ctx())).toBe(true);
    expect(evaluateGate(gate("steps.plan.verdict", "exists"), ctx())).toBe(true);
  });
});
