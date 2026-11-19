/**
 * An aside chat carries the aside instruction on every turn — built from the
 * stored `chatRole`, so a resumed aside gets it too — on each harness through
 * a channel that ADDS to its own prompt: Claude Code's system-prompt append,
 * Codex's `developer_instructions` (never the replacing instructions file),
 * pi's appended system prompt. No other chat gets it.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentEvent } from "../agents/ports/events.js";
import type { StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-aside-send-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-aside-send-work-"));

vi.mock("./quick-completion.js", () => ({
  generateChatTitle: async () => null,
  generateBranchName: async () => null,
  quickCompletion: async () => ({ text: "" }),
}));

// The codex route probe spawns the CLI; a fixed native route instead.
vi.mock("./codex-execution-route.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./codex-execution-route.js")>()),
  resolveCodexExecutionRoute: async () => ({ route: "codex", injectedOpenRouter: false, uiAliasPresence: { "callboard-ui": false, callboard_ui: false } }),
}));
vi.mock("./reasoning-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reasoning-capabilities.js")>()),
  assertStoredReasoningEffort: async () => undefined,
}));

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { MockAgentProvider } = await import("../agents/adapters/mock/MockAgentProvider.js");
const { chatFileService } = await import("./chat-file-service.js");
const { ASIDE_INSTRUCTION } = await import("./aside.js");

let counter = 0;
let provider: InstanceType<typeof MockAgentProvider>;

async function run(opts: Record<string, unknown>): Promise<void> {
  provider = new MockAgentProvider({
    events: [
      { type: "session_started", sessionId: `aside-sess-${++counter}` },
      { type: "text", content: "ok" },
      { type: "result", status: "success" },
    ] as AgentEvent[],
  });
  // Every slot, so a codex or pi chat runs on the mock too.
  for (const kind of ["claude-code", "codex", "pi"] as const) setAgentProviderForTesting(provider, kind);
  const emitter = await sendMessage({ prompt: "go", ...opts } as never);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 10s")), 10_000);
    emitter.on("event", (e: StreamEvent) => {
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}
const optionsOf = () => (provider.queryRecords[0].request as any).options;
const appendOf = () => optionsOf()?.systemPrompt?.append ?? "";
const storedAside = (provider: string | undefined, id: string) =>
  chatFileService.createChat(workDir, id, JSON.stringify({ chatRole: "aside", session_ids: [id], ...(provider && { provider }) }));

afterEach(() => setAgentProviderForTesting(null));
afterAll(() => {
  for (const dir of [dataDir, workDir]) rmSync(dir, { recursive: true, force: true });
});

describe("sendMessage — aside instruction", () => {
  it("is appended on a turn of an existing aside (resume)", async () => {
    await run({ chatId: storedAside(undefined, "stored-aside").id });
    expect(appendOf()).toContain(ASIDE_INSTRUCTION);
  });

  it("reaches Codex as developer_instructions, not in the replacing instructions append", async () => {
    await run({ chatId: storedAside("codex", "stored-aside-codex").id });
    expect(optionsOf().codex.developerInstructions).toBe(ASIDE_INSTRUCTION);
    expect(appendOf()).not.toContain(ASIDE_INSTRUCTION);
  });

  it("reaches pi as an appended system prompt", async () => {
    await run({ chatId: storedAside("pi", "stored-aside-pi").id });
    expect(optionsOf().pi.appendSystemPrompt).toEqual([ASIDE_INSTRUCTION]);
    expect(appendOf()).not.toContain(ASIDE_INSTRUCTION);
  });

  it("is absent from a fork and from a new chat", async () => {
    const fork = chatFileService.createChat(workDir, "stored-fork", JSON.stringify({ chatRole: "fork", session_ids: ["stored-fork"] }));
    await run({ chatId: fork.id });
    expect(appendOf()).not.toContain(ASIDE_INSTRUCTION);
    const codexFork = chatFileService.createChat(
      workDir,
      "stored-fork-codex",
      JSON.stringify({ chatRole: "fork", provider: "codex", session_ids: ["stored-fork-codex"] }),
    );
    await run({ chatId: codexFork.id });
    expect(optionsOf().codex).not.toHaveProperty("developerInstructions");
    await run({ folder: workDir });
    expect(appendOf()).not.toContain(ASIDE_INSTRUCTION);
  });
});
