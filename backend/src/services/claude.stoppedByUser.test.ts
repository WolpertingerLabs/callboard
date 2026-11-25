/**
 * `Chat.stoppedByUserAt` — the Callboard-side record that the human stopped a
 * chat's last run, which the transcript's Continue button keys on.
 *
 * The Stop route sets it (stream.activity.test.ts pins that, and that nothing
 * else on that route does). Here: the stopped run's own unwind must not wipe
 * it, and the chat's next run — whoever starts it — must clear it.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery } from "../agents/ports/AgentProvider.js";
import type { StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-stopped-by-user-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-stopped-by-user-work-"));

const { sendMessage, stopSession } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { MockAgentProvider } = await import("../agents/adapters/mock/MockAgentProvider.js");
const { chatFileService } = await import("./chat-file-service.js");

/** A run that works until it is closed, then throws AbortError like the Claude adapter. */
function parkedProvider(): AgentProvider {
  let release: (() => void) | null = null;
  return {
    kind: "mock",
    query(): AgentQuery {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text", content: "working on it" } as AgentEvent;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        },
        accountInfo: async () => null,
        supportedModels: async () => [],
        close: async () => release?.(),
      };
    },
    buildToolServer: () => ({ mock: true }),
  };
}

function nextEvent(emitter: { on: (e: string, cb: (v: StreamEvent) => void) => void }, types: string[]): Promise<StreamEvent> {
  return new Promise<StreamEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${types.join("/")} event within 10s`)), 10_000);
    emitter.on("event", (e: StreamEvent) => {
      if (types.includes(e.type)) {
        clearTimeout(timer);
        resolve(e);
      }
    });
  });
}

afterEach(() => setAgentProviderForTesting(null));

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("chatFileService stoppedByUser", () => {
  it("records the stop and forgets it, leaving no key behind on disk", () => {
    const chat = chatFileService.createChat(workDir, "sbu-file-1", "{}");
    expect(chatFileService.markStoppedByUser(chat.id)).toBe(true);
    expect(chatFileService.getChat(chat.id)?.stoppedByUserAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    chatFileService.clearStoppedByUser(chat.id);
    expect(chatFileService.getChat(chat.id)?.stoppedByUserAt).toBeUndefined();
    const file = readdirSync(join(dataDir, "chats")).find((f) => f.startsWith("sbu-file-1"))!;
    expect(JSON.parse(readFileSync(join(dataDir, "chats", file), "utf-8"))).not.toHaveProperty("stoppedByUserAt");
  });

  it("is a no-op for a chat with no record, and clearing writes nothing when nothing is recorded", () => {
    expect(chatFileService.markStoppedByUser("no-such-chat")).toBe(false);
    const chat = chatFileService.createChat(workDir, "sbu-file-2", "{}");
    const before = chatFileService.getChat(chat.id)!.updated_at;
    chatFileService.clearStoppedByUser(chat.id);
    expect(chatFileService.getChat(chat.id)!.updated_at).toBe(before);
  });
});

describe("sendMessage and stoppedByUserAt", () => {
  it("survives the stopped run's unwind, and is cleared when the next run starts", async () => {
    const chat = chatFileService.createChat(workDir, "sbu-run-1", "{}");

    setAgentProviderForTesting(parkedProvider());
    const running = await sendMessage({ prompt: "long task", chatId: chat.id });
    const ended = nextEvent(running, ["done", "error"]);
    await nextEvent(running, ["text"]);

    // What the Stop route does.
    expect(stopSession(chat.id)).toBe(true);
    chatFileService.markStoppedByUser(chat.id);
    expect((await ended).reason).toBe("aborted");
    // The unwind writes the record again (updateChat on the way out); the
    // stop has to still be there for the reload to offer Continue.
    expect(chatFileService.getChat(chat.id)?.stoppedByUserAt).toBeDefined();

    setAgentProviderForTesting(
      new MockAgentProvider({
        events: [
          { type: "session_started", sessionId: "sbu-run-1" },
          { type: "text", content: "resumed" },
          { type: "result", status: "success" },
        ],
      }),
    );
    const next = await sendMessage({ prompt: "continue", chatId: chat.id });
    // Cleared as the run starts, not when it ends.
    expect(chatFileService.getChat(chat.id)?.stoppedByUserAt).toBeUndefined();
    await nextEvent(next, ["done", "error"]);
    expect(chatFileService.getChat(chat.id)?.stoppedByUserAt).toBeUndefined();
  });
});
