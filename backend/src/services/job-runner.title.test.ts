/**
 * Runner-level tests for deterministic step-chat titles.
 *
 * Job-step chats are `triggered`, which deliberately skips LLM title
 * generation — so without a preset title they render as "untitled" anywhere
 * that reads stored chat records (card rollup, board). The runner stamps
 * `chatTitle` ("<run title or job name> — <step>") into sendMessage so every
 * step chat is identifiable.
 *
 * Same harness as job-runner.folder.test.ts: fake claude.ts deps injected,
 * fresh module graph per test against a throwaway CALLBOARD_DATA_DIR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStepResult } from "shared";

import type * as JobStoreModule from "./job-store.js";
import type * as JobRunnerModule from "./job-runner.js";
import type { sessionRegistry as SessionRegistryType } from "./session-registry.js";

type Store = typeof JobStoreModule;
type Runner = typeof JobRunnerModule;
type Registry = typeof SessionRegistryType;

let dataDir: string;
let store: Store;
let runner: Runner;
let registry: Registry;

let activeSessions: Set<string>;
let sentTitles: Array<string | undefined>;
let chatCounter: number;
let jobCounter: number;

async function load(dir: string): Promise<void> {
  process.env.CALLBOARD_DATA_DIR = dir;
  vi.resetModules();
  store = await import("./job-store.js");
  registry = (await import("./session-registry.js")).sessionRegistry;
  runner = await import("./job-runner.js");

  activeSessions = new Set();
  sentTitles = [];
  chatCounter = 0;
  jobCounter = 0;

  runner.setJobRunnerDeps({
    sendMessage: async (params) => {
      sentTitles.push(params.chatTitle);
      const chatId = `chat-${++chatCounter}`;
      activeSessions.add(chatId);
      const emitter = new EventEmitter();
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
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error("flush(): condition not met within timeout");
}

function makeJob(def: Record<string, unknown>): string {
  const job = store.createJob({ name: `job-${++jobCounter}`, ...def } as never);
  return job.id;
}

/** Simulate the active step session of `runId` finishing: persist its result, emit the stop. */
function endStep(runId: string, stepId: string, result?: JobStepResult): void {
  const chatId = store.getRun(runId)!.activeStep!.chatId!;
  if (result) store.recordStepResult(runId, stepId, result);
  activeSessions.delete(chatId);
  registry.emit("change", { event: "session_stopped", chatId });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "callboard-runner-"));
  await load(dataDir);
});

afterEach(() => {
  runner.shutdownJobRunner();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("step chat titles", () => {
  it('stamps "<job name> — <step id>" on step sessions by default', async () => {
    const jobId = makeJob({
      name: "Repo Branch Prep",
      steps: [{ id: "prep", type: "agent", prompt: "Do it" }],
    });
    runner.spawnJobRun(jobId, {});
    await flush(() => sentTitles.length === 1);
    expect(sentTitles[0]).toBe("Repo Branch Prep — prep");
  });

  it("prefers the step display name and the run title once set", async () => {
    const jobId = makeJob({
      name: "Pipeline",
      steps: [
        { id: "a", type: "agent", prompt: "First", name: "First step", next: "b" },
        { id: "b", type: "agent", prompt: "Second", name: "Second step" },
      ],
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => !!store.getRun(runId)?.activeStep?.chatId);
    expect(sentTitles[0]).toBe("Pipeline — First step");

    // A run title set mid-run (set_job_run_title) names later step chats.
    store.setRunTitle(runId, "Deploy v2.3.1");
    endStep(runId, "a");
    await flush(() => sentTitles.length === 2);
    expect(sentTitles[1]).toBe("Deploy v2.3.1 — Second step");
  });
});
