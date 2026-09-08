import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({ stored: vi.fn(async (_input: unknown) => {}) }));
vi.mock("../services/reasoning-capabilities.js", () => ({ assertStoredReasoningEffort: stubs.stored }));
vi.mock("../services/agent-file-service.js", () => ({
  agentExists: () => false,
  getAgentWorkspacePath: () => "/agent-workspace",
  getAgent: () => ({}),
  createAgent: vi.fn(),
  getAgentDataDir: () => "/agent-data",
}));
vi.mock("../services/agent-cron-jobs.js", () => ({ ensureDefaultCronJobs: vi.fn(), listCronJobs: () => [] }));
vi.mock("../services/cron-scheduler.js", () => ({ scheduleJob: vi.fn() }));

const { dropUnsupportedActionEfforts } = await import("./agent-export-import.js");

beforeEach(() => {
  vi.clearAllMocks();
  stubs.stored.mockResolvedValue(undefined);
});

describe("agent import: reasoning effort on imported cron/trigger actions", () => {
  it("uses the stored-value check with the agent workspace as cwd and keeps a verifiable effort", async () => {
    const jobs = [{ id: "j1", name: "nightly", action: { type: "start_session", provider: "codex", effort: "high" } }];
    await dropUnsupportedActionEfforts("forge", "cron-jobs.json", jobs);
    expect(stubs.stored).toHaveBeenCalledTimes(1);
    expect(stubs.stored).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", effort: "high", cwd: "/agent-workspace" }));
    expect(jobs[0].action.effort).toBe("high");
  });

  it("drops an effort the local catalog positively rules out, leaving the rest of the action intact", async () => {
    stubs.stored.mockRejectedValueOnce(new Error('Reasoning effort "ultra" is not supported for codex/codex model "gpt-5.5"'));
    const triggers = [
      { id: "t1", name: "on-mention", action: { type: "start_session", provider: "codex", model: "gpt-5.5", effort: "ultra", prompt: "go" } },
      { id: "t2", name: "plain", action: { type: "start_session" } },
    ];
    await dropUnsupportedActionEfforts("forge", "triggers.json", triggers);
    expect(stubs.stored).toHaveBeenCalledTimes(1); // t2 has no effort, nothing to check
    expect(triggers[0].action).toEqual({ type: "start_session", provider: "codex", model: "gpt-5.5", prompt: "go" });
    expect(triggers[1].action).toEqual({ type: "start_session" });
  });

  it("ignores malformed files and entries without an action", async () => {
    await expect(dropUnsupportedActionEfforts("forge", "cron-jobs.json", { not: "an array" })).resolves.toBeUndefined();
    await expect(dropUnsupportedActionEfforts("forge", "cron-jobs.json", [null, 1, { id: "x" }, { id: "y", action: "nope" }])).resolves.toBeUndefined();
    expect(stubs.stored).not.toHaveBeenCalled();
  });
});
