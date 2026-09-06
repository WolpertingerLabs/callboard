import { beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("./agent-file-service.js", () => ({ getAgentWorkspacePath: (alias: string) => `/workspace/${alias}` }));
vi.mock("./agent-settings.js", async (original) => ({ ...(await original<typeof import("./agent-settings.js")>()), getAgentSettings: () => settings.value }));
const validate = vi.hoisted(() => vi.fn(async (_input: unknown) => {}));
vi.mock("./reasoning-capabilities.js", () => ({ assertReasoningEffort: validate }));
import { assertJobReasoningEfforts } from "./job-reasoning-validation.js";

beforeEach(() => {
  validate.mockReset();
  settings.value = {};
});
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
      { provider: "codex", model: "astra", effort: "ultra", cwd: homedir() },
      { provider: "codex", model: "luna", effort: "max", cwd: homedir() },
      { provider: "pi", model: "other", effort: "high", cwd: homedir() },
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

it.each([
  [{ agentAlias: "default-agent" }, {}, "/workspace/default-agent"],
  [{ agentAlias: "default-agent" }, { agentAlias: "step-agent" }, "/workspace/step-agent"],
  [{ folder: "/default-folder", agentAlias: "default-agent" }, { agentAlias: "step-agent" }, "/default-folder"],
  [{ folder: "/default-folder", agentAlias: "default-agent" }, { folder: "/step-folder" }, "/step-folder"],
  [{}, {}, homedir()],
])("uses execution folder precedence for defaults %j / step %j", async (defaults, fields, cwd) => {
  // Global/daemon model rejects ultra, while the selected workspace permits it.
  validate.mockImplementation(async (input) => {
    if ((input as { cwd?: string }).cwd !== cwd) throw new Error("global model rejects ultra");
  });
  await expect(
    assertJobReasoningEfforts({ defaults: { provider: "codex", ...defaults }, steps: [{ id: "one", type: "agent", effort: "ultra", ...fields }] }),
  ).resolves.toBeUndefined();
  expect(validate).toHaveBeenCalledWith(expect.objectContaining({ cwd, effort: "ultra" }));
});

it("defers native Codex model validation until a templated folder is interpolated, never daemon cwd", async () => {
  validate.mockRejectedValue(new Error("daemon project rejects ultra"));
  await expect(
    assertJobReasoningEfforts({ defaults: { provider: "codex", folder: "{{inputs.repo}}" }, steps: [{ id: "one", type: "agent", effort: "ultra" }] }),
  ).resolves.toBeUndefined();
  expect(validate).not.toHaveBeenCalled();
});
it("rejects unknown effort vocabulary even while the folder is unresolved", async () => {
  await expect(
    assertJobReasoningEfforts({ steps: [{ id: "bad", type: "agent", provider: "codex", folder: "{{inputs.repo}}", effort: "bogus" }] }),
  ).rejects.toThrow("Unknown reasoning effort");
});
it("validates known injected OR routing without a project, even for templated folders", async () => {
  settings.value = { codexUseOpenRouter: true, codexOpenRouterApiKey: "fake", codexOpenRouterModel: "openai/example" };
  const definition = { steps: [{ id: "bad", type: "agent", provider: "codex", folder: "{{inputs.repo}}", effort: "ultra" }] };
  await expect(assertJobReasoningEfforts(definition)).rejects.toThrow("not supported by OpenRouter");
  definition.steps[0].effort = "high";
  await assertJobReasoningEfforts(definition);
  expect(validate).toHaveBeenCalledWith({ provider: "codex", model: undefined, effort: "high" });
});
