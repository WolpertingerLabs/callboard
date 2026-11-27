/**
 * A step session that ends on a provider error must fail its step — not be
 * harvested as `completed_unstructured` with an empty `_final`, which is what
 * happened to every Codex step whose model was not in the client's catalog: the
 * session errored instantly, the run carried on, and nothing said so.
 *
 * Same harness as job-runner.parallel.test.ts: fake runner deps, sessions end
 * via sessionRegistry "session_stopped". The session's failure arrives the way
 * claude.ts reports it — an `error` event on the run's emitter, before the stop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as JobStoreModule from "./job-store.js";
import type * as JobRunnerModule from "./job-runner.js";
import type { sessionRegistry as SessionRegistryType } from "./session-registry.js";
import { codexModelNotFoundMessage } from "../agents/adapters/codex/modelNotFound.js";

let dataDir: string;
let store: typeof JobStoreModule;
let runner: typeof JobRunnerModule;
let registry: typeof SessionRegistryType;
let activeSessions: Set<string>;
let emitters: Map<string, EventEmitter>;
let chatCounter: number;

const PAYLOAD =
  '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.5\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found","subreason":"model_not_in_accessible_catalog"}}';
const ACTIONABLE = codexModelNotFoundMessage(PAYLOAD, { codexVersion: "0.153.4" })!;

async function load(dir: string): Promise<void> {
  process.env.CALLBOARD_DATA_DIR = dir;
  vi.resetModules();
  store = await import("./job-store.js");
  registry = (await import("./session-registry.js")).sessionRegistry;
  runner = await import("./job-runner.js");
  activeSessions = new Set();
  emitters = new Map();
  chatCounter = 0;
  runner.setJobRunnerDeps({
    sendMessage: async () => {
      const chatId = `chat-${++chatCounter}`;
      activeSessions.add(chatId);
      const emitter = new EventEmitter();
      emitters.set(chatId, emitter);
      setImmediate(() => emitter.emit("event", { type: "chat_created", chatId }));
      return emitter;
    },
    stopSession: (chatId: string) => activeSessions.delete(chatId),
    getActiveSession: (chatId: string) => (activeSessions.has(chatId) ? {} : undefined),
  });
  runner.initJobRunner();
}

async function flush(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  if (!predicate()) throw new Error("flush(): condition not met within timeout");
}

/** End a session the way claude.ts does on a provider error: `error` event, then the registry stop. */
function failSession(chatId: string, content: string): void {
  emitters.get(chatId)!.emit("event", { type: "error", content });
  activeSessions.delete(chatId);
  registry.emit("change", { event: "session_stopped", chatId });
}

function endSession(chatId: string): void {
  emitters.get(chatId)!.emit("event", { type: "done", content: "" });
  activeSessions.delete(chatId);
  registry.emit("change", { event: "session_stopped", chatId });
}

async function startRun(steps: unknown[]): Promise<{ runId: string; chatId: string }> {
  const job = store.createJob({ name: `job-${Math.round(performance.now() * 1000)}`, steps: steps as never });
  const run = runner.spawnJobRun(job.id, {});
  await flush(() => !!store.getRun(run.runId)?.activeStep?.chatId);
  return { runId: run.runId, chatId: store.getRun(run.runId)!.activeStep!.chatId! };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "callboard-runner-err-"));
  await load(dataDir);
});

afterEach(() => {
  runner.shutdownJobRunner();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("step session that ends on a provider error", () => {
  it("fails the run with the session's error instead of completing unstructured", async () => {
    const { runId, chatId } = await startRun([
      { id: "consolidate", type: "agent", prompt: "Consolidate memory" },
      { id: "after", type: "agent", prompt: "never reached" },
    ]);

    failSession(chatId, ACTIONABLE);
    await flush(() => store.getRun(runId)!.status === "failed");

    const run = store.getRun(runId)!;
    expect(run.error).toContain('Agent step "consolidate"');
    expect(run.error).toContain(ACTIONABLE);
    const entry = run.history.find((h) => h.stepId === "consolidate");
    expect(entry?.result).toBe("error");
    expect(entry?.chatId).toBe(chatId);
    expect(entry?.detail).toContain("Codex model not available");
    expect(run.history.some((h) => h.result === "completed_unstructured")).toBe(false);
  });

  it("retries an errored step when the step has retries left", async () => {
    const { runId, chatId } = await startRun([{ id: "s", type: "agent", prompt: "p", retry: { attempts: 2, backoffSeconds: 3600 } }]);

    failSession(chatId, ACTIONABLE);
    await flush(() => store.getRun(runId)!.history.length === 1);

    const run = store.getRun(runId)!;
    expect(run.status).not.toBe("failed");
    expect(run.history[0].result).toBe("error");
    expect(run.history[0].detail).toContain(ACTIONABLE);
    expect(run.history[0].detail).toContain("retrying");
  });

  it("still honours a result the session reported before it errored", async () => {
    const { runId, chatId } = await startRun([{ id: "s", type: "agent", prompt: "p", outputs: ["answer"] }]);

    store.recordStepResult(runId, "s", { outputs: { answer: "42" } });
    failSession(chatId, "stream disconnected");
    await flush(() => store.getRun(runId)!.status === "succeeded");

    expect(store.getRun(runId)!.history[0].result).toBe("completed");
  });

  it("leaves a cleanly ended session's harvest alone", async () => {
    const { runId, chatId } = await startRun([{ id: "s", type: "agent", prompt: "p" }]);
    endSession(chatId);
    await flush(() => store.getRun(runId)!.status === "succeeded");
    expect(store.getRun(runId)!.history[0].result).toBe("completed_unstructured");
  });

  it("fails a parallel branch whose session errored, with the error as its detail", async () => {
    const job = store.createJob({
      name: "parallel-err",
      steps: [{ id: "fan", type: "parallel", mode: "all", branches: [{ id: "a", type: "agent", prompt: "p" }] }] as never,
    });
    const run = runner.spawnJobRun(job.id, {});
    await flush(() => !!store.getRun(run.runId)?.activeStep?.parallel?.branches.a?.chatId);
    const chatId = store.getRun(run.runId)!.activeStep!.parallel!.branches.a.chatId!;

    failSession(chatId, ACTIONABLE);
    await flush(() => store.getRun(run.runId)!.status === "failed");

    const branchEntry = store.getRun(run.runId)!.history.find((h) => h.branchId === "a");
    expect(branchEntry?.result).toBe("error");
    expect(branchEntry?.detail).toContain(ACTIONABLE);
  });

  it("doesn't keep the error of a session that will never be harvested (run cancelled first)", async () => {
    const { runId, chatId } = await startRun([{ id: "s", type: "agent", prompt: "p" }]);
    runner.cancelRun(runId);
    failSession(chatId, ACTIONABLE);
    await flush(() => true);
    expect(runner.sessionErrorCountForTesting()).toBe(0);
    expect(store.getRun(runId)!.status).toBe("cancelled");
  });

  it("records a poll checker's error in its not_yet detail and sleeps for the next check", async () => {
    const { runId, chatId } = await startRun([{ id: "check", type: "poll", prompt: "is it done?", intervalMinutes: 60, maxAttempts: 3 }]);

    failSession(chatId, ACTIONABLE);
    await flush(() => store.getRun(runId)!.history.length === 1);

    const run = store.getRun(runId)!;
    expect(run.history[0].result).toBe("not_yet");
    expect(run.history[0].detail).toBe(`checker session ended with an error: ${ACTIONABLE} — treating as not_yet`);
    expect(run.status).toBe("sleeping");
  });

  it("records an errored notifier as an error, not 'notified', and still advances", async () => {
    const { runId, chatId } = await startRun([
      { id: "tell", type: "notify", message: "hello" },
      { id: "after", type: "agent", prompt: "next" },
    ]);

    failSession(chatId, ACTIONABLE);
    await flush(() => store.getRun(runId)!.currentStepId === "after");

    const entry = store.getRun(runId)!.history.find((h) => h.stepId === "tell");
    expect(entry?.result).toBe("error");
    expect(entry?.detail).toContain(ACTIONABLE);
  });
});
