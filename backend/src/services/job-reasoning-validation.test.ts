import { beforeEach, describe, expect, it, vi } from "vitest";
const validate = vi.hoisted(() => vi.fn(async (_input: unknown) => {}));
vi.mock("./reasoning-capabilities.js", () => ({ assertReasoningEffort: validate }));
import { assertJobReasoningEfforts } from "./job-reasoning-validation.js";

beforeEach(() => validate.mockReset());
describe("job reasoning configuration", () => {
  it("merges defaults, overrides and parallel branches exactly as execution", async () => {
    await assertJobReasoningEfforts({
      defaults: { provider: "codex", model: "astra" },
      steps: [
        { id: "a", type: "agent", effort: "ultra" },
        { id: "p", type: "poll", model: "luna", effort: "max" },
        { type: "parallel", branches: [{ id: "b", type: "agent", provider: "pi", model: "other", effort: "high" }] },
      ],
    });
    expect(validate.mock.calls.map(([input]) => input)).toEqual([
      { provider: "codex", model: "astra", effort: "ultra" },
      { provider: "codex", model: "luna", effort: "max" },
      { provider: "pi", model: "other", effort: "high" },
    ]);
  });
  it("reports the invalid step without mutating input", async () => {
    const definition = { steps: [{ id: "bad", type: "agent", effort: "ultra" }] };
    const original = JSON.stringify(definition);
    validate.mockRejectedValueOnce(new Error("unsupported effort"));
    await expect(assertJobReasoningEfforts(definition)).rejects.toThrow('Step "bad": unsupported effort');
    expect(JSON.stringify(definition)).toBe(original);
  });
  it("leaves structural errors for job-store", async () => {
    await assertJobReasoningEfforts({ steps: [null, 4, { type: "gate" }] });
    expect(validate).not.toHaveBeenCalled();
  });
});
