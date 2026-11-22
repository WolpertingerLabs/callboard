/**
 * The "starting" window — what keeps idle-triggered senders (held messages,
 * completion callbacks) from mistaking a supersede for the chat going idle.
 *
 * `sendMessage` on a running chat stops the old run (`stopSession`, which
 * emits `session_stopped`) several awaits before the new run registers. Every
 * harness goes through this one function — Codex and pi are adapters behind
 * it, not separate send paths — so pinning it here covers all of them.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery } from "../agents/ports/AgentProvider.js";
import type { SessionEvent } from "./session-registry.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-starting-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-starting-work-"));

const { sendMessage, stopSession } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { sessionRegistry } = await import("./session-registry.js");
const { chatFileService } = await import("./chat-file-service.js");

/** A provider whose runs park until closed — a turn in progress. */
function parkedProvider(): AgentProvider {
  return {
    kind: "mock",
    query(): AgentQuery {
      let release: (() => void) | null = null;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text", content: "working" } as AgentEvent;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        },
        accountInfo: async () => null,
        supportedModels: async () => [],
        close: async () => {
          release?.();
        },
      };
    },
    buildToolServer: () => ({ mock: true }),
  };
}

afterEach(() => setAgentProviderForTesting(null));
afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("SessionRegistry starting tokens", () => {
  it("stays starting until every token is released, and a token releases once", () => {
    const a = sessionRegistry.markStarting("tok-chat");
    const b = sessionRegistry.markStarting("tok-chat");
    expect(sessionRegistry.isStarting("tok-chat")).toBe(true);
    expect(sessionRegistry.clearStarting("tok-chat", a)).toBe(true);
    expect(sessionRegistry.clearStarting("tok-chat", a)).toBe(false);
    expect(sessionRegistry.isStarting("tok-chat")).toBe(true);
    expect(sessionRegistry.clearStarting("tok-chat", b)).toBe(true);
    expect(sessionRegistry.isStarting("tok-chat")).toBe(false);
  });
});

describe("sendMessage supersede", () => {
  it("fires the superseded run's session_stopped while the chat reads as starting", async () => {
    setAgentProviderForTesting(parkedProvider());
    const id = "supersede-chat-1";
    chatFileService.upsertChat(id, workDir, id, { metadata: JSON.stringify({ provider: "claude-code" }) });

    await sendMessage({ chatId: id, prompt: "first" });
    expect(sessionRegistry.has(id)).toBe(true);

    const seen: boolean[] = [];
    const onChange = (event: SessionEvent) => {
      if (event.event === "session_stopped" && event.chatId === id) seen.push(sessionRegistry.isStarting(id));
    };
    sessionRegistry.on("change", onChange);
    try {
      await sendMessage({ chatId: id, prompt: "second" });
    } finally {
      sessionRegistry.off("change", onChange);
    }

    // The supersede stop happened, and the chat was "starting" when it did.
    expect(seen).toEqual([true]);
    // Registered now: busy through the registry, no longer starting.
    expect(sessionRegistry.has(id)).toBe(true);
    expect(sessionRegistry.isStarting(id)).toBe(false);
    stopSession(id);
  });

  it("emits start_abandoned and clears starting when the start fails before registering", async () => {
    const abandoned: string[] = [];
    const onAbandoned = (chatId: string) => abandoned.push(chatId);
    sessionRegistry.on("start_abandoned", onAbandoned);
    try {
      await expect(sendMessage({ chatId: "no-such-chat", prompt: "hi" })).rejects.toThrow();
    } finally {
      sessionRegistry.off("start_abandoned", onAbandoned);
    }
    expect(abandoned).toEqual(["no-such-chat"]);
    expect(sessionRegistry.isStarting("no-such-chat")).toBe(false);
  });

  it("does not emit start_abandoned for a start that registered", async () => {
    setAgentProviderForTesting(parkedProvider());
    const id = "supersede-chat-2";
    chatFileService.upsertChat(id, workDir, id, { metadata: JSON.stringify({ provider: "claude-code" }) });
    const abandoned: string[] = [];
    const onAbandoned = (chatId: string) => abandoned.push(chatId);
    sessionRegistry.on("start_abandoned", onAbandoned);
    try {
      await sendMessage({ chatId: id, prompt: "go" });
    } finally {
      sessionRegistry.off("start_abandoned", onAbandoned);
    }
    expect(abandoned).toEqual([]);
    stopSession(id);
  });
});
