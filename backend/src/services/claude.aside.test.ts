/**
 * An aside chat's system prompt carries the aside instruction on every turn —
 * built from the stored `chatRole`, so a resumed aside gets it too — and no
 * other chat gets it.
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
  setAgentProviderForTesting(provider);
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
const appendOf = () => (provider.queryRecords[0].request as any).options?.systemPrompt?.append ?? "";

afterEach(() => setAgentProviderForTesting(null));
afterAll(() => {
  for (const dir of [dataDir, workDir]) rmSync(dir, { recursive: true, force: true });
});

describe("sendMessage — aside instruction", () => {
  it("is appended on a turn of an existing aside (resume)", async () => {
    const chat = chatFileService.createChat(workDir, "stored-aside", JSON.stringify({ chatRole: "aside", session_ids: ["stored-aside"] }));
    await run({ chatId: chat.id });
    expect(appendOf()).toContain(ASIDE_INSTRUCTION);
  });

  it("is absent from a fork and from a new chat", async () => {
    const fork = chatFileService.createChat(workDir, "stored-fork", JSON.stringify({ chatRole: "fork", session_ids: ["stored-fork"] }));
    await run({ chatId: fork.id });
    expect(appendOf()).not.toContain(ASIDE_INSTRUCTION);
    await run({ folder: workDir });
    expect(appendOf()).not.toContain(ASIDE_INSTRUCTION);
  });
});
