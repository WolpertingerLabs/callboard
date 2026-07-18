/**
 * Runner-level tests for step-session folder resolution.
 *
 * The folder a step session spawns in (step.folder / defaults.folder) is a
 * template like any other job-def string — it must be interpolated against
 * the run context, and a resolved path that doesn't exist must fail the step
 * with an actionable message. (Skipping either check historically spawned
 * claude with a literal "{{inputs.repo_folder}}" cwd, which Node's spawn
 * reports as the *binary* failing to launch.)
 *
 * Same harness as job-runner.subjob.test.ts: fake claude.ts deps are
 * injected so step sessions start deterministically, and each test loads a
 * fresh module graph against its own throwaway CALLBOARD_DATA_DIR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import type * as JobStoreModule from "./job-store.js";
import type * as JobRunnerModule from "./job-runner.js";

type Store = typeof JobStoreModule;
type Runner = typeof JobRunnerModule;

let dataDir: string;
let store: Store;
let runner: Runner;

let sentFolders: string[];
let chatCounter: number;
let jobCounter: number;

async function load(dir: string): Promise<void> {
  process.env.CALLBOARD_DATA_DIR = dir;
  vi.resetModules();
  store = await import("./job-store.js");
  runner = await import("./job-runner.js");

  sentFolders = [];
  chatCounter = 0;
  jobCounter = 0;

  runner.setJobRunnerDeps({
    sendMessage: async (params) => {
      sentFolders.push(params.folder!);
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
  dataDir = mkdtempSync(join(tmpdir(), "callboard-runner-"));
  await load(dataDir);
});

afterEach(() => {
  runner.shutdownJobRunner();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("step session folder resolution", () => {
  it("interpolates a templated defaults.folder against run inputs", async () => {
    const jobId = makeJob({
      inputs: [{ key: "repo_folder", required: true }],
      defaults: { folder: "{{inputs.repo_folder}}" },
      steps: [{ id: "work", type: "agent", prompt: "Do it" }],
    });
    runner.spawnJobRun(jobId, { repo_folder: dataDir });
    await flush(() => sentFolders.length > 0);
    expect(sentFolders).toEqual([dataDir]);
  });

  it("interpolates a per-step folder, which wins over defaults.folder", async () => {
    const jobId = makeJob({
      inputs: [{ key: "repo_folder", required: true }],
      defaults: { folder: "/does/not/exist" },
      steps: [{ id: "work", type: "agent", prompt: "Do it", folder: "{{inputs.repo_folder}}" }],
    });
    runner.spawnJobRun(jobId, { repo_folder: dataDir });
    await flush(() => sentFolders.length > 0);
    expect(sentFolders).toEqual([dataDir]);
  });

  it("leaves a literal folder untouched and still defaults to the home directory", async () => {
    const jobId = makeJob({
      steps: [{ id: "work", type: "agent", prompt: "Do it" }],
    });
    runner.spawnJobRun(jobId, {});
    await flush(() => sentFolders.length > 0);
    expect(sentFolders).toEqual([homedir()]);
  });

  it("fails the run with an actionable error when the resolved folder does not exist", async () => {
    const jobId = makeJob({
      inputs: [{ key: "repo_folder", required: true }],
      defaults: { folder: "{{inputs.repo_folder}}" },
      steps: [{ id: "work", type: "agent", prompt: "Do it" }],
    });
    const missing = join(dataDir, "nope");
    const runId = runner.spawnJobRun(jobId, { repo_folder: missing }).runId;
    await flush(() => store.getRun(runId)!.status === "failed");
    expect(store.getRun(runId)!.error).toContain(`session folder does not exist: ${missing}`);
    expect(sentFolders).toEqual([]);
  });

  it("fails the run when the folder template has unresolved refs", async () => {
    const jobId = makeJob({
      defaults: { folder: "{{inputs.repo_folder}}" },
      steps: [{ id: "work", type: "agent", prompt: "Do it" }],
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => store.getRun(runId)!.status === "failed");
    expect(store.getRun(runId)!.error).toContain("Unresolved template reference(s): {{inputs.repo_folder}}");
    expect(sentFolders).toEqual([]);
  });
});
