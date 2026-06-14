/**
 * Lifecycle tests for {@link CodexAgentQuery} focused on the tool-bridge slice:
 * the query owns the tool-server handles built for its run and must close them
 * (stop sockets, remove temp dirs) once the run ends by ANY path — normal
 * completion (iterate's finally) or an early/abort `close()`. These guard against
 * leaking listening sockets per Codex turn.
 *
 * The Codex SDK itself is stubbed so the tests never spawn the real `codex exec`
 * CLI; only the close-handle plumbing is exercised (per `lesson-sdk-callback-mocks`
 * we drive the event stream the SDK would emit rather than invoking internal
 * callbacks).
 */
import { describe, expect, it } from "vitest";
import type { Codex } from "@openai/codex-sdk";
import { CodexAgentQuery } from "./CodexAgentQuery.js";
import type { CodexToolServerHandle } from "./toolAdapter.js";

/** A handle whose close() flips a flag and counts calls, so a test can assert it
 *  was closed exactly once. */
function countingHandle(name: string): CodexToolServerHandle & { closeCount: number } {
  const handle = {
    name,
    version: "1.0.0",
    socketPath: `/tmp/${name}.sock`,
    closeCount: 0,
    toMcpServerConfig: () => ({ command: "node", args: ["/shim.js", `/tmp/${name}.sock`] }),
    close: async () => {
      handle.closeCount += 1;
    },
  };
  return handle;
}

/** A Codex stub whose thread emits no events and completes immediately. */
function stubCodex(): Codex {
  const thread = {
    runStreamed: async () => ({
      events: (async function* () {
        /* no events — turn completes immediately */
      })(),
    }),
  };
  return { startThread: () => thread, resumeThread: () => thread } as unknown as Codex;
}

const MODELS = [{ value: "gpt-5.5", displayName: "GPT-5.5", description: "" }];

describe("CodexAgentQuery — tool-server lifecycle", () => {
  it("closes tool servers after a normal run completes", async () => {
    const h1 = countingHandle("a");
    const h2 = countingHandle("b");
    const query = new CodexAgentQuery({
      codex: stubCodex(),
      resumeId: null,
      threadOptions: {},
      prompt: "hi",
      toolServerHandles: [h1, h2],
      models: MODELS,
    });

    // Drain the (empty) event stream — iterate()'s finally runs the cleanup.
    for await (const _ of query) {
      void _;
    }

    expect(h1.closeCount).toBe(1);
    expect(h2.closeCount).toBe(1);
  });

  it("closes tool servers on close() even before iteration", async () => {
    const h1 = countingHandle("a");
    const query = new CodexAgentQuery({
      codex: stubCodex(),
      resumeId: null,
      threadOptions: {},
      prompt: "hi",
      toolServerHandles: [h1],
      models: MODELS,
    });

    await query.close();
    expect(h1.closeCount).toBe(1);
  });

  it("does not double-close when close() follows a completed run", async () => {
    const h1 = countingHandle("a");
    const query = new CodexAgentQuery({
      codex: stubCodex(),
      resumeId: null,
      threadOptions: {},
      prompt: "hi",
      toolServerHandles: [h1],
      models: MODELS,
    });

    for await (const _ of query) {
      void _;
    }
    await query.close();
    expect(h1.closeCount).toBe(1);
  });

  it("no handles → close() is a harmless no-op", async () => {
    const query = new CodexAgentQuery({
      codex: stubCodex(),
      resumeId: null,
      threadOptions: {},
      prompt: "hi",
      models: MODELS,
    });
    await expect(query.close()).resolves.toBeUndefined();
  });
});
