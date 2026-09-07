/**
 * Cron/trigger execution of an action whose stored reasoning effort cannot be
 * verified at fire time.
 *
 * The action's effort was validated fail-closed when it was saved. At fire
 * time it is a *stored* value: a Codex route probe that times out, or a
 * workspace briefly unavailable, must not skip the run — sendMessage already
 * revalidates it on the execution path and refuses only what the catalog
 * knows to be unsupported. Before this the executor ran the strict check
 * itself, turned a probe hiccup into "cron execution failed", and spawned the
 * CLI a second time when sendMessage probed again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const mocks = vi.hoisted(() => ({
  strict: vi.fn(async (_input: unknown) => {}),
  stored: vi.fn(async (_input: unknown) => {}),
  activity: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("./reasoning-capabilities.js", () => ({ assertReasoningEffort: mocks.strict, assertStoredReasoningEffort: mocks.stored }));
vi.mock("./agent-file-service.js", () => ({
  getAgent: () => ({ alias: "ops", enabled: true }),
  getAgentWorkspacePath: () => "/agent-workspace/ops",
}));
vi.mock("./claude-compiler.js", () => ({ compileSystemPrompt: () => ({ prompt: "identity" }) }));
vi.mock("./agent-activity.js", () => ({ appendActivity: mocks.activity }));

const { executeAgent, setExecutorMessageSender } = await import("./agent-executor.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendMessage.mockImplementation(async () => {
    const emitter = new EventEmitter();
    setImmediate(() => emitter.emit("event", { type: "chat_created", chatId: "chat-1" }));
    return emitter;
  });
  setExecutorMessageSender(mocks.sendMessage);
});

describe("executeAgent with a stored effort", () => {
  it("starts the run even when the fail-closed check would refuse an unverifiable effort", async () => {
    mocks.strict.mockImplementation(async () => {
      throw new Error('Reasoning effort "high" is not supported for codex/unknown model "(runtime default)"');
    });
    const result = await executeAgent({ agentAlias: "ops", prompt: "go", triggeredBy: "cron", provider: "codex", effort: "high" });
    expect(result).toEqual({ chatId: "chat-1" });
    // Execution leaves the stored-value check to sendMessage, which also owns
    // the single Codex route probe for this message.
    expect(mocks.strict).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex", effort: "high", folder: "/agent-workspace/ops" }));
    expect(mocks.activity).toHaveBeenCalledWith("ops", expect.objectContaining({ message: "cron session started" }));
  });
  it("still reports a run that sendMessage refuses", async () => {
    mocks.sendMessage.mockImplementation(async () => {
      throw new Error('Reasoning effort "ultra" is not supported for codex/codex model "gpt-5.5"');
    });
    expect(await executeAgent({ agentAlias: "ops", prompt: "go", triggeredBy: "cron", provider: "codex", effort: "ultra" })).toBeNull();
    expect(mocks.activity).toHaveBeenCalledWith("ops", expect.objectContaining({ message: expect.stringContaining("cron execution failed") }));
  });
});
