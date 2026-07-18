/**
 * Runner-level tests for mid-run card adoption (assign_run_to_card).
 *
 * A workflow that creates its tracking card DURING the run (e.g. a
 * create-tracking-card child job) has no cardId at spawn time, so nothing
 * used to stamp step chats onto the card. assign_run_to_card lets any step
 * session attach its whole run tree — ancestors and descendants — after the
 * fact, and the runner's existing propagation (run.cardId → child spawns →
 * jobContext.cardId) takes over for everything spawned later.
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
import type { JobStepResult } from "shared";

import type * as JobStoreModule from "./job-store.js";
import type * as JobRunnerModule from "./job-runner.js";
import type * as JobStepToolsModule from "./job-step-tools.js";
import type * as CardStoreModule from "./card-store.js";
import type { sessionRegistry as SessionRegistryType } from "./session-registry.js";

type Store = typeof JobStoreModule;
type Runner = typeof JobRunnerModule;
type StepTools = typeof JobStepToolsModule;
type CardStore = typeof CardStoreModule;
type Registry = typeof SessionRegistryType;

let dataDir: string;
let store: Store;
let runner: Runner;
let stepTools: StepTools;
let cardStore: CardStore;
let registry: Registry;

let activeSessions: Set<string>;
let sentJobContexts: Array<{ runId: string; cardId?: string }>;
let chatCounter: number;
let jobCounter: number;

async function load(dir: string): Promise<void> {
  process.env.CALLBOARD_DATA_DIR = dir;
  vi.resetModules();
  store = await import("./job-store.js");
  registry = (await import("./session-registry.js")).sessionRegistry;
  runner = await import("./job-runner.js");
  stepTools = await import("./job-step-tools.js");
  cardStore = await import("./card-store.js");

  activeSessions = new Set();
  sentJobContexts = [];
  chatCounter = 0;
  jobCounter = 0;

  runner.setJobRunnerDeps({
    sendMessage: async (params) => {
      sentJobContexts.push({ runId: params.jobContext!.runId, cardId: params.jobContext!.cardId });
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

/** Simulate the active step session of `runId` finishing: persist its result, emit the stop. */
function endStep(runId: string, stepId: string, result?: JobStepResult): void {
  const chatId = store.getRun(runId)!.activeStep!.chatId!;
  if (result) store.recordStepResult(runId, stepId, result);
  activeSessions.delete(chatId);
  registry.emit("change", { event: "session_stopped", chatId });
}

/** Invoke a job-tools tool handler as a step session of `runId` would. */
async function callStepTool(runId: string, stepId: string, toolName: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const spec = stepTools.buildJobStepToolsSpec(() => ({ runId, stepId }));
  const tool = spec.tools.find((t) => t.name === toolName)!;
  expect(tool).toBeDefined();
  const result = await tool.handler(args);
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "callboard-runner-"));
  await load(dataDir);
});

afterEach(() => {
  runner.shutdownJobRunner();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("assign_run_to_card", () => {
  it("assigns the whole tree from a child step and propagates to later child runs and sessions", async () => {
    const childA = makeChildJob();
    const childB = makeChildJob();
    const parentJobId = makeJob({
      steps: [
        { id: "first", type: "job", jobId: childA, outputs: ["result"], next: "second" },
        { id: "second", type: "job", jobId: childB, outputs: ["result"] },
      ],
    });
    const parentRunId = runner.spawnJobRun(parentJobId, {}).runId;
    await flush(() => {
      const childRunId = store.getRun(parentRunId)?.activeStep?.childRunId;
      return !!childRunId && !!store.getRun(childRunId)?.activeStep?.chatId;
    });
    const childARunId = store.getRun(parentRunId)!.activeStep!.childRunId!;

    // The child-A session creates a card mid-run and adopts it for the tree.
    const card = cardStore.createCard({ title: "Tracking card" });
    const response = await callStepTool(childARunId, "work", "assign_run_to_card", { card_id: card.id });
    expect(response.success).toBe(true);
    expect(response.runsAssigned).toBe(2); // child A + parent (walked up)

    expect(store.getRun(childARunId)!.cardId).toBe(card.id);
    expect(store.getRun(parentRunId)!.cardId).toBe(card.id);

    // Finish child A; child B must inherit the card at spawn, and its step
    // session must get the card in its jobContext.
    endStep(childARunId, "work", { outputs: { result: "ok" } });
    await flush(() => {
      const childRunId = store.getRun(parentRunId)?.activeStep?.childRunId;
      return !!childRunId && childRunId !== childARunId && !!store.getRun(childRunId)?.activeStep?.chatId;
    });
    const childBRunId = store.getRun(parentRunId)!.activeStep!.childRunId!;
    expect(store.getRun(childBRunId)!.cardId).toBe(card.id);
    const childBContext = sentJobContexts.find((c) => c.runId === childBRunId);
    expect(childBContext?.cardId).toBe(card.id);
  });

  it("walks down to already-finished sibling runs and collects their step chats", async () => {
    const childA = makeChildJob();
    const childB = makeChildJob();
    const parentJobId = makeJob({
      steps: [
        { id: "first", type: "job", jobId: childA, outputs: ["result"], next: "second" },
        { id: "second", type: "job", jobId: childB, outputs: ["result"] },
      ],
    });
    const parentRunId = runner.spawnJobRun(parentJobId, {}).runId;
    await flush(() => {
      const childRunId = store.getRun(parentRunId)?.activeStep?.childRunId;
      return !!childRunId && !!store.getRun(childRunId)?.activeStep?.chatId;
    });
    const childARunId = store.getRun(parentRunId)!.activeStep!.childRunId!;
    const childAChatId = store.getRun(childARunId)!.activeStep!.chatId!;

    endStep(childARunId, "work", { outputs: { result: "ok" } });
    await flush(() => {
      const childRunId = store.getRun(parentRunId)?.activeStep?.childRunId;
      return !!childRunId && childRunId !== childARunId && !!store.getRun(childRunId)?.activeStep?.chatId;
    });
    const childBRunId = store.getRun(parentRunId)!.activeStep!.childRunId!;

    // Assigning from child B must also cover the finished child A run.
    const assigned = store.assignCardToRunTree(childBRunId, "card-test")!;
    expect(assigned.runIds).toHaveLength(3);
    expect(assigned.runIds).toEqual(expect.arrayContaining([parentRunId, childARunId, childBRunId]));
    expect(assigned.chatIds).toContain(childAChatId);
    expect(store.getRun(childARunId)!.cardId).toBe("card-test");
  });

  it("rejects unknown and closed cards without touching the run", async () => {
    const jobId = makeJob({ steps: [{ id: "work", type: "agent", prompt: "Do it" }] });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => !!store.getRun(runId)?.activeStep?.chatId);

    const missing = await callStepTool(runId, "work", "assign_run_to_card", { card_id: "card-nope" });
    expect(missing.error).toContain("not found");

    const card = cardStore.createCard({ title: "Closed card" });
    cardStore.updateCard(card.id, { lifecycle: "closed" });
    const closed = await callStepTool(runId, "work", "assign_run_to_card", { card_id: card.id });
    expect(closed.error).toContain("closed");

    expect(store.getRun(runId)!.cardId).toBeUndefined();
  });
});
