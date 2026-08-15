/**
 * Runner-level handling of a job step that targets a harness this build
 * removed — the third seam Phase 4 of plans/remove-openrouter-engine.md names.
 *
 * A job definition is persisted data: one authored while the OpenRouter harness
 * existed can still name it, and `job-store`'s model-validity checks were
 * deliberately left admitting the value (removing it there would fail every such
 * job at *validation* time, which is a worse error than failing it at run time
 * with a message that says what to do). So the refusal lands in `sendMessage`,
 * and what has to hold here is that a throw out of the spawn is a *step*
 * failure with the message intact — not a crashed run, not a silent hang, and
 * not a step that quietly succeeds on Claude Code instead.
 *
 * Same harness as job-runner.folder.test.ts: claude.ts deps are injected, each
 * test gets a throwaway CALLBOARD_DATA_DIR and a fresh module graph.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as JobStoreModule from "./job-store.js";
import type * as JobRunnerModule from "./job-runner.js";

type Store = typeof JobStoreModule;
type Runner = typeof JobRunnerModule;

let dataDir: string;
let store: Store;
let runner: Runner;

let spawnedProviders: (string | undefined)[];
let chatCounter: number;
let jobCounter: number;

/** The refusal services/claude.ts raises for a retired kind, verbatim in shape. */
const REFUSAL =
  "This job or cron action targets the OpenRouter agent harness, which has been removed. " +
  "Re-point it at another harness — to keep using OpenRouter credentials, route a native harness through them in Settings → API.";

class FakeRetiredProviderError extends Error {}

async function load(dir: string): Promise<void> {
  process.env.CALLBOARD_DATA_DIR = dir;
  vi.resetModules();
  store = await import("./job-store.js");
  runner = await import("./job-runner.js");

  spawnedProviders = [];
  chatCounter = 0;
  jobCounter = 0;

  runner.setJobRunnerDeps({
    sendMessage: async (params) => {
      spawnedProviders.push(params.provider as string | undefined);
      // Stands in for the real guard, which is the first statement of
      // sendMessage and therefore throws before any chat record is written.
      if ((params.provider as string) === "openrouter") throw new FakeRetiredProviderError(REFUSAL);
      const chatId = `chat-${++chatCounter}`;
      const emitter = new EventEmitter();
      setImmediate(() => emitter.emit("event", { type: "chat_created", chatId }));
      return emitter;
    },
    stopSession: () => true,
    getActiveSession: () => undefined,
  });
  runner.initJobRunner();
}

async function flush(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error("flush(): condition not met within timeout");
}

function makeJob(def: Record<string, unknown>): string {
  const job = store.createJob({ name: `job-${++jobCounter}`, ...def } as never);
  return job.id;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "callboard-runner-retired-"));
  await load(dataDir);
});

afterEach(() => {
  runner.shutdownJobRunner();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("a job step on a removed harness", () => {
  it("fails the run with the refusal message instead of crashing or hanging", async () => {
    const jobId = makeJob({
      defaults: { folder: dataDir },
      steps: [{ id: "work", type: "agent", prompt: "Do it", provider: "openrouter", retries: 0 }],
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;

    await flush(() => store.getRun(runId)!.status === "failed");
    // The message is what makes the failure actionable — a bare "spawn failed"
    // would leave the user with a job that stops working and no reason why.
    expect(store.getRun(runId)!.error).toContain("OpenRouter agent harness");
    expect(spawnedProviders).toEqual(["openrouter"]);
  });

  it("names the offending step in the run error", async () => {
    // `handleAttemptSpawnFailure` writes no history entry for a session that
    // never started (there is no attempt to close out), so the step id has to
    // ride in the run error or the failure is unattributable. That shape is
    // shared with every other spawn failure — pinned here because it is what
    // the user actually reads when a legacy job stops running.
    const jobId = makeJob({
      defaults: { folder: dataDir },
      steps: [{ id: "legacy-step", type: "agent", prompt: "Do it", provider: "openrouter", retries: 0 }],
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;

    await flush(() => store.getRun(runId)!.status === "failed");
    const error = store.getRun(runId)!.error!;
    expect(error).toContain('Step "legacy-step"');
    expect(error).toContain("Re-point it at another harness");
  });

  it("does not silently re-route the step onto Claude Code", async () => {
    // The failure mode the refusal exists to prevent: a run that reports
    // success while having executed on an engine the job never named.
    const jobId = makeJob({
      defaults: { folder: dataDir },
      steps: [{ id: "work", type: "agent", prompt: "Do it", provider: "openrouter", retries: 0 }],
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;

    await flush(() => store.getRun(runId)!.status === "failed");
    expect(spawnedProviders).not.toContain("claude-code");
    expect(chatCounter).toBe(0);
  });

  it("leaves steps on live harnesses untouched", async () => {
    const jobId = makeJob({
      defaults: { folder: dataDir },
      steps: [{ id: "work", type: "agent", prompt: "Do it", provider: "claude-code" }],
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;

    await flush(() => chatCounter > 0);
    expect(store.getRun(runId)!.status).toBe("running");
  });
});
