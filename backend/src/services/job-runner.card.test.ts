/**
 * Runner-level tests for run → card membership (`rootChatId`).
 *
 * A run belongs to the card of the lineage root of the chat that spawned it:
 * spawnJobRun stamps `run.rootChatId` (resolved by the caller — the spawn_job
 * MCP tool walks the calling chat's tree), the "job" step passes the parent
 * run's root down to child runs, and the runner's sendMessage jobContext
 * carries it so step chats fold under the root's card via
 * metadata.rootChatId. There is no attach-a-card tool anymore — membership is
 * lineage, fixed at spawn.
 *
 * Same harness as job-runner.subjob.test.ts: fake claude.ts deps are
 * injected so step sessions start/end deterministically, and each test loads
 * a fresh module graph against its own throwaway CALLBOARD_DATA_DIR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as JobStoreModule from "./job-store.js";
import type * as JobRunnerModule from "./job-runner.js";
import type * as JobStepToolsModule from "./job-step-tools.js";

type Store = typeof JobStoreModule;
type Runner = typeof JobRunnerModule;
type StepTools = typeof JobStepToolsModule;

let dataDir: string;
let store: Store;
let runner: Runner;
let stepTools: StepTools;

let activeSessions: Set<string>;
let sentJobContexts: Array<{ runId: string; rootChatId?: string }>;
let chatCounter: number;
let jobCounter: number;

async function load(dir: string): Promise<void> {
  process.env.CALLBOARD_DATA_DIR = dir;
  vi.resetModules();
  store = await import("./job-store.js");
  // The registry's change events are what advance the run when a step
  // session stops — load it for its side effects even though these tests
  // drive the runner only as far as session start.
  await import("./session-registry.js");
  runner = await import("./job-runner.js");
  stepTools = await import("./job-step-tools.js");

  activeSessions = new Set();
  sentJobContexts = [];
  chatCounter = 0;
  jobCounter = 0;

  runner.setJobRunnerDeps({
    sendMessage: async (params) => {
      sentJobContexts.push({ runId: params.jobContext!.runId, rootChatId: params.jobContext!.rootChatId });
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

/** Child job with one agent step reporting `result`, surfaced as a run-level output. */
function makeChildJob(): string {
  return makeJob({
    steps: [{ id: "work", type: "agent", prompt: "Do it", outputs: ["result"] }],
    outputs: { result: "{{steps.work.outputs.result}}" },
  });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "callboard-runner-"));
  await load(dataDir);
});

afterEach(() => {
  runner.shutdownJobRunner();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("run rootChatId stamping", () => {
  it("stamps rootChatId at spawn and threads it into every step chat's jobContext", async () => {
    const jobId = makeJob({ steps: [{ id: "work", type: "agent", prompt: "Do it" }] });
    const runId = runner.spawnJobRun(jobId, {}, undefined, { rootChatId: "root-chat-1" }).runId;

    expect(store.getRun(runId)!.rootChatId).toBe("root-chat-1");

    await flush(() => !!store.getRun(runId)?.activeStep?.chatId);
    const context = sentJobContexts.find((c) => c.runId === runId);
    expect(context?.rootChatId).toBe("root-chat-1");
  });

  it("child runs inherit the parent run's rootChatId through the job step", async () => {
    const childA = makeChildJob();
    const parentJobId = makeJob({
      steps: [{ id: "first", type: "job", jobId: childA, outputs: ["result"] }],
    });
    const parentRunId = runner.spawnJobRun(parentJobId, {}, undefined, { rootChatId: "root-chat-2" }).runId;

    await flush(() => {
      const childRunId = store.getRun(parentRunId)?.activeStep?.childRunId;
      return !!childRunId && !!store.getRun(childRunId)?.activeStep?.chatId;
    });
    const childRunId = store.getRun(parentRunId)!.activeStep!.childRunId!;

    // The inheritance the old assignCardToRunTree used to provide mid-run,
    // now by construction at spawn: the parent's root flows to the child run
    // AND to the child's step chats.
    expect(store.getRun(childRunId)!.rootChatId).toBe("root-chat-2");
    const childContext = sentJobContexts.find((c) => c.runId === childRunId);
    expect(childContext?.rootChatId).toBe("root-chat-2");
  });

  it("runs spawned with no chat context carry no root, and stay rootless through child runs", async () => {
    // Matches the jobs-page spawn: no chat, no card. The old model behaved
    // the same way (no cardId unless explicitly attached).
    const childA = makeChildJob();
    const parentJobId = makeJob({ steps: [{ id: "first", type: "job", jobId: childA, outputs: ["result"] }] });
    const parentRunId = runner.spawnJobRun(parentJobId, {}).runId;
    expect(store.getRun(parentRunId)!.rootChatId).toBeUndefined();

    await flush(() => {
      const childRunId = store.getRun(parentRunId)?.activeStep?.childRunId;
      return !!childRunId && !!store.getRun(childRunId)?.activeStep?.chatId;
    });
    const childRunId = store.getRun(parentRunId)!.activeStep!.childRunId!;
    expect(store.getRun(childRunId)!.rootChatId).toBeUndefined();
    expect(sentJobContexts.find((c) => c.runId === childRunId)?.rootChatId).toBeUndefined();
  });
});

describe("the removed attach-a-card surface", () => {
  it("the job-step tool server no longer exposes assign_run_to_card", () => {
    // Membership is lineage and fixed at spawn; a mid-run attach tool would
    // fight the derivation. complete_job_step and set_job_run_title remain.
    const spec = stepTools.buildJobStepToolsSpec(() => ({ runId: "run-x", stepId: "work" }));
    expect(spec.tools.map((t) => t.name).sort()).toEqual(["complete_job_step", "set_job_run_title"]);
  });
});
