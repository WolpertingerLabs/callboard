/**
 * Integration tests for stopSession() — the chat-level stop button's backend.
 *
 * The contract under test is "cancel the request", not "stop reading the
 * stream": a stop must abort the run's signal, hard-terminate the provider
 * query that is actually executing, and end the run with a terminal event that
 * says it was aborted — for every adapter, including the ones whose event
 * stream ends quietly on abort instead of throwing.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../agents/ports/AgentProvider.js";
import type { StreamEvent } from "shared/types/index.js";

// Isolate all chat-record writes into a throwaway data dir. Must be set
// before the dynamic imports below — DATA_DIR is resolved at module load.
const dataDir = mkdtempSync(join(tmpdir(), "callboard-stop-session-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-stop-session-work-"));

const { sendMessage, stopSession } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { sessionRegistry } = await import("./session-registry.js");

/**
 * A provider whose run parks indefinitely after emitting some output — the
 * shape a stop actually has to deal with (a live turn, not a finished one).
 * It never emits `session_started`, so the run stays keyed by the caller's
 * tracking id: the startup window that used to be uncancellable.
 *
 * `closed` records whether the run was hard-terminated. `endStreamOnClose`
 * picks how the adapter surfaces the abort — by throwing (Claude Code) or by
 * simply ending the stream (OpenRouter / Codex).
 */
function parkedProvider(opts: { endStreamOnClose?: boolean } = {}): AgentProvider & { closed: () => boolean } {
  let closed = false;
  let release: (() => void) | null = null;
  return {
    kind: "mock",
    closed: () => closed,
    query(_req: AgentQueryRequest): AgentQuery {
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "text", content: "working on it" } as AgentEvent;
          // Park until close() lets go — a turn in progress.
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          if (!opts.endStreamOnClose) throw Object.assign(new Error("aborted"), { name: "AbortError" });
          // Otherwise the stream just ends, with no terminal `result`.
        },
        accountInfo: async () => null,
        supportedModels: async () => [],
        close: async () => {
          closed = true;
          release?.();
        },
      };
    },
    buildToolServer: () => ({ mock: true }),
  };
}

/** Resolves with the run's terminal event (done or error). */
function terminalEvent(emitter: { on: (e: string, cb: (v: StreamEvent) => void) => void }): Promise<StreamEvent> {
  return new Promise<StreamEvent>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session did not finish within 10s")), 10_000);
    emitter.on("event", (e: StreamEvent) => {
      if (e.type === "done" || e.type === "error") {
        clearTimeout(timer);
        resolve(e);
      }
    });
  });
}

/** Wait for the run to register and start streaming before stopping it. */
async function waitForEvent(emitter: { on: (e: string, cb: (v: StreamEvent) => void) => void }, type: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} event within 5s`)), 5_000);
    emitter.on("event", (e: StreamEvent) => {
      if (e.type === type) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

afterEach(() => {
  setAgentProviderForTesting(null);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("stopSession", () => {
  it("terminates the live provider query, not just the event stream", async () => {
    const provider = parkedProvider();
    setAgentProviderForTesting(provider);

    const emitter = await sendMessage({ prompt: "long task", folder: workDir, triggered: true, clientTrackingId: "new-stop-1" });
    const terminal = terminalEvent(emitter);
    await waitForEvent(emitter, "text");

    expect(stopSession("new-stop-1")).toBe(true);

    const done = await terminal;
    expect(done.type).toBe("done");
    expect(done.reason).toBe("aborted");
    // The point of the whole exercise: the run itself was killed.
    expect(provider.closed()).toBe(true);
    expect(sessionRegistry.has("new-stop-1")).toBe(false);
  });

  it("reports the abort even when the provider's stream ends quietly instead of throwing", async () => {
    // OpenRouter and Codex surface an abort as a terminal stream event, which
    // the query loop's `signal.aborted` guard skips — without explicit
    // handling the run would look like a normal completion and the UI would
    // show no interruption at all.
    const provider = parkedProvider({ endStreamOnClose: true });
    setAgentProviderForTesting(provider);

    const emitter = await sendMessage({ prompt: "long task", folder: workDir, triggered: true, clientTrackingId: "new-stop-2" });
    const terminal = terminalEvent(emitter);
    await waitForEvent(emitter, "text");

    stopSession("new-stop-2");

    const done = await terminal;
    expect(done.type).toBe("done");
    expect(done.reason).toBe("aborted");
    expect(provider.closed()).toBe(true);
  });

  it("returns false when there is nothing to stop", () => {
    expect(stopSession("no-such-chat")).toBe(false);
  });

  it("keys a new chat by the caller's tracking id so it is stoppable before the chat exists", async () => {
    const provider = parkedProvider();
    setAgentProviderForTesting(provider);

    const emitter = await sendMessage({ prompt: "long task", folder: workDir, triggered: true, clientTrackingId: "new-stop-3" });
    const terminal = terminalEvent(emitter);
    // Registered under the client's id from the very first moment — before any
    // session_started/chat_created has told the client a real chat id.
    expect(sessionRegistry.has("new-stop-3")).toBe(true);

    stopSession("new-stop-3");
    await terminal;
  });

  it("ignores a tracking id already in use rather than evicting the live session", async () => {
    const first = parkedProvider();
    setAgentProviderForTesting(first);
    const firstEmitter = await sendMessage({ prompt: "first", folder: workDir, triggered: true, clientTrackingId: "new-stop-4" });
    const firstTerminal = terminalEvent(firstEmitter);
    await waitForEvent(firstEmitter, "text");

    const second = parkedProvider();
    setAgentProviderForTesting(second);
    const secondEmitter = await sendMessage({ prompt: "second", folder: workDir, triggered: true, clientTrackingId: "new-stop-4" });
    const secondTerminal = terminalEvent(secondEmitter);
    await waitForEvent(secondEmitter, "text");

    // The collision fell back to a generated id; stopping "new-stop-4" hits
    // the original session only.
    expect(stopSession("new-stop-4")).toBe(true);
    const firstDone = await firstTerminal;
    expect(firstDone.reason).toBe("aborted");
    expect(first.closed()).toBe(true);
    expect(second.closed()).toBe(false);

    // Clean up the second run.
    const stray = Object.keys(sessionRegistry.getAll()).find((k) => k.startsWith("new-"));
    if (stray) stopSession(stray);
    await secondTerminal;
  });
});
