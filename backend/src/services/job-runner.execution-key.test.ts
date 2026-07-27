/**
 * Runner-level tests for idempotent execution keys (plans/idempotent-execution-ids.md).
 *
 * Same harness as job-runner.subjob.test.ts / job-runner.parallel.test.ts:
 * fake claude.ts deps so step sessions start and end deterministically, and a
 * fresh module graph per test against its own throwaway CALLBOARD_DATA_DIR —
 * which is also how a backend reboot is simulated (re-import the runner over
 * the same on-disk run files).
 *
 * A crash is simulated the way the existing adoption test does it: by writing
 * the run file into the state a hard kill would have left it in. The windows
 * that matter are (1) after the intent write and before the spawn, and (2)
 * after the spawn and before the linkage write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobStepResult } from "shared";

import type * as JobStoreModule from "./job-store.js";
import type * as JobRunnerModule from "./job-runner.js";
import type * as ChatFileServiceModule from "./chat-file-service.js";
import type { sessionRegistry as SessionRegistryType } from "./session-registry.js";

type Store = typeof JobStoreModule;
type Runner = typeof JobRunnerModule;
type Registry = typeof SessionRegistryType;

let dataDir: string;
let store: Store;
let runner: Runner;
let registry: Registry;
let chats: typeof ChatFileServiceModule.chatFileService;

let activeSessions: Set<string>;
/** Chat/job counters live across load() calls so sessions spawned before and
 *  after a simulated reboot never collide on an id. */
let chatCounter: number;
let jobCounter: number;

async function load(dir: string): Promise<void> {
  process.env.CALLBOARD_DATA_DIR = dir;
  vi.resetModules();
  store = await import("./job-store.js");
  registry = (await import("./session-registry.js")).sessionRegistry;
  chats = (await import("./chat-file-service.js")).chatFileService;
  runner = await import("./job-runner.js");

  activeSessions = new Set();

  runner.setJobRunnerDeps({
    sendMessage: async () => {
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

/** Standard child job: one agent step reporting `result`, surfaced as a run-level output. */
function makeChildJob(): string {
  return makeJob({
    inputs: [{ key: "task", required: false, default: "" }],
    steps: [{ id: "work", type: "agent", prompt: "Do {{inputs.task}}", outputs: ["result"] }],
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

function endBranch(runId: string, stepId: string, branchId: string, result?: JobStepResult): void {
  const chatId = store.getRun(runId)!.activeStep!.parallel!.branches[branchId].chatId!;
  if (result) store.recordStepResult(runId, stepId, result, branchId);
  activeSessions.delete(chatId);
  registry.emit("change", { event: "session_stopped", chatId });
}

/** Spawn the parent and wait until its job step has a child whose agent session is live. */
async function spawnParentAndChild(parentJobId: string, inputs: Record<string, string> = {}): Promise<{ parentRunId: string; childRunId: string }> {
  const parentRunId = runner.spawnJobRun(parentJobId, inputs).runId;
  await flush(() => {
    const childRunId = store.getRun(parentRunId)?.activeStep?.childRunId;
    return !!childRunId && !!store.getRun(childRunId)?.activeStep?.chatId;
  });
  return { parentRunId, childRunId: store.getRun(parentRunId)!.activeStep!.childRunId! };
}

/** Child runs of a parent, in creation order. */
function childrenOf(parentRunId: string): string[] {
  return store
    .listRuns({})
    .filter((r) => r.parentRunId === parentRunId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => r.runId);
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "callboard-runner-"));
  chatCounter = 0;
  jobCounter = 0;
  await load(dataDir);
});

afterEach(() => {
  runner.shutdownJobRunner();
  rmSync(dataDir, { recursive: true, force: true });
});

// ── Key minting ─────────────────────────────────────────────────────────

describe("execution keys — minting", () => {
  it("writes the key onto the run and the child it spawns, before the linkage", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({ steps: [{ id: "sub", type: "job", jobId: childId, outputs: ["result"] }] });
    const { parentRunId, childRunId } = await spawnParentAndChild(parentId);

    const parent = store.getRun(parentRunId)!;
    expect(parent.activeStep!.executionKey).toBe(`${parentRunId}:sub:1`);
    expect(store.getRun(childRunId)!.executionKey).toBe(`${parentRunId}:sub:1`);
    expect(store.findRunByExecutionKey(`${parentRunId}:sub:1`)?.runId).toBe(childRunId);
  });

  it("gives each attempt at a step its own key — a loop re-entry never reuses the previous one", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [{ id: "sub", type: "job", jobId: childId, outputs: ["result"], onFailure: "sub", maxLoops: 2 }],
    });
    const { parentRunId, childRunId: first } = await spawnParentAndChild(parentId);
    expect(store.getRun(parentRunId)!.activeStep!.executionKey).toBe(`${parentRunId}:sub:1`);

    // Fail attempt 1 → onFailure jumps back into the same step.
    endStep(first, "work", { summary: "no result" });
    await flush(() => store.getRun(parentRunId)!.activeStep?.childRunId !== first);

    // `attempt` still reads 1 on a fresh entry — the key is what separates
    // the two attempts, which is exactly why it is not keyed on `attempt`.
    const parent = store.getRun(parentRunId)!;
    expect(parent.activeStep!.attempt).toBe(1);
    expect(parent.activeStep!.executionKey).toBe(`${parentRunId}:sub:2`);
    expect(store.getRun(parent.activeStep!.childRunId!)!.executionKey).toBe(`${parentRunId}:sub:2`);
  });
});

// ── The headline case ───────────────────────────────────────────────────

describe("execution keys — a retried step never adopts the previous attempt's child", () => {
  it("spawns attempt 2's own child instead of adopting attempt 1's orphan (the case the newest-wins scan gets wrong)", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [
        { id: "sub", type: "job", jobId: childId, outputs: ["result"], onFailure: "sub", maxLoops: 2 },
        { id: "after", type: "agent", prompt: "After" },
      ],
    });
    const { parentRunId, childRunId: attempt1Child } = await spawnParentAndChild(parentId);
    store.recordStepResult(attempt1Child, "work", { outputs: { result: "from attempt 1" } });

    // The on-disk state after two kills: attempt 1's child was spawned but its
    // linkage never landed (so it is not in history either), and attempt 2 was
    // killed between its intent write and its spawn — the key is durable, the
    // child it names does not exist.
    const parent = store.getRun(parentRunId)!;
    parent.status = "waiting_child";
    parent.activeStep = { stepId: "sub", attempt: 1, startedAt: new Date().toISOString(), executionKey: `${parentRunId}:sub:2` };
    parent.executionCounts = { sub: 2 };
    parent.loopCounts = { sub: 1 };
    store.saveRun(parent);

    // The pre-execution-key heuristic — newest unharvested child of
    // (parentRunId, "sub") — would hand attempt 2 the stale attempt-1 child,
    // and attribute its outputs to attempt 2.
    expect(store.findChildRun(parentRunId, "sub", new Set())?.runId).toBe(attempt1Child);

    await load(dataDir); // reboot

    // Settle: either attempt 2 spawned its own child (correct) or the stale
    // one was adopted and harvested into attempt 2 (what the scan does).
    await flush(() => !!store.getRun(parentRunId)!.activeStep?.childRunId || store.getRun(parentRunId)!.currentStepId === "after");

    const recovered = store.getRun(parentRunId)!;
    expect(recovered.history.some((h) => h.childRunId === attempt1Child)).toBe(false); // attempt 1's child was not harvested into attempt 2
    expect(recovered.currentStepId).toBe("sub");
    const attempt2Child = recovered.activeStep!.childRunId!;
    expect(attempt2Child).not.toBe(attempt1Child);
    expect(store.getRun(attempt2Child)!.executionKey).toBe(`${parentRunId}:sub:3`);

    // And the outputs harvested into attempt 2 are attempt 2's child's.
    await flush(() => !!store.getRun(attempt2Child)?.activeStep?.chatId);
    endStep(attempt2Child, "work", { outputs: { result: "from attempt 2" } });
    await flush(() => store.getRun(parentRunId)!.currentStepId === "after");

    const entry = store.getRun(parentRunId)!.history.find((h) => h.stepId === "sub" && h.result === "completed");
    expect(entry?.childRunId).toBe(attempt2Child);
    expect(entry?.outputs).toEqual({ result: "from attempt 2" });
  });

  it("adopts the retried attempt's child when the crash lands after that spawn", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [
        { id: "sub", type: "job", jobId: childId, outputs: ["result"], onFailure: "sub", maxLoops: 2 },
        { id: "after", type: "agent", prompt: "After" },
      ],
    });
    const { parentRunId, childRunId: attempt1Child } = await spawnParentAndChild(parentId);

    // Attempt 1 fails and the step loops back into itself, spawning attempt 2.
    endStep(attempt1Child, "work", { summary: "no result" });
    await flush(() => {
      const linked = store.getRun(parentRunId)!.activeStep?.childRunId;
      return !!linked && linked !== attempt1Child;
    });
    const attempt2Child = store.getRun(parentRunId)!.activeStep!.childRunId!;
    await flush(() => !!store.getRun(attempt2Child)?.activeStep?.chatId);
    store.recordStepResult(attempt2Child, "work", { outputs: { result: "from attempt 2" } });

    // Killed in attempt 2's linkage window: the child exists, the parent has
    // not recorded it.
    const parent = store.getRun(parentRunId)!;
    delete parent.activeStep!.childRunId;
    store.saveRun(parent);

    await load(dataDir);
    await flush(() => store.getRun(parentRunId)!.currentStepId === "after");

    // Attempt 2's child was adopted and harvested — attempt 1's was not
    // reused, and no third child was spawned.
    const entry = store.getRun(parentRunId)!.history.find((h) => h.stepId === "sub" && h.result === "completed");
    expect(entry?.childRunId).toBe(attempt2Child);
    expect(entry?.outputs).toEqual({ result: "from attempt 2" });
    expect(childrenOf(parentRunId)).toEqual([attempt1Child, attempt2Child]);
  });
});

// ── The two crash windows ───────────────────────────────────────────────

describe("execution keys — crash windows around a sub-job spawn", () => {
  it("spawns exactly once when the crash lands between the intent write and the spawn", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [
        { id: "sub", type: "job", jobId: childId, outputs: ["result"] },
        { id: "after", type: "agent", prompt: "After" },
      ],
    });
    const { parentRunId, childRunId } = await spawnParentAndChild(parentId);

    // Nothing was ever spawned under the intent's key: drop the child and the
    // linkage, keeping the durable intent (status + key) the spawn would have
    // been made under.
    store.deleteRun(childRunId);
    const parent = store.getRun(parentRunId)!;
    delete parent.activeStep!.childRunId;
    store.saveRun(parent);

    await load(dataDir);
    await flush(() => !!store.getRun(parentRunId)!.activeStep?.childRunId);

    const children = childrenOf(parentRunId);
    expect(children).toHaveLength(1);
    expect(children[0]).not.toBe(childRunId);
    expect(store.getRun(parentRunId)!.status).toBe("waiting_child");

    // The re-entered step runs to completion normally.
    await flush(() => !!store.getRun(children[0])?.activeStep?.chatId);
    endStep(children[0], "work", { outputs: { result: "ok" } });
    await flush(() => store.getRun(parentRunId)!.currentStepId === "after");
  });

  it("adopts the existing child when the crash lands between the spawn and the linkage write", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [
        { id: "sub", type: "job", jobId: childId, outputs: ["result"] },
        { id: "after", type: "agent", prompt: "After" },
      ],
    });
    const { parentRunId, childRunId } = await spawnParentAndChild(parentId);
    store.recordStepResult(childRunId, "work", { outputs: { result: "ok" } });

    // waiting_child is already durable (it is written with the intent); only
    // the linkage is missing.
    const parent = store.getRun(parentRunId)!;
    expect(parent.status).toBe("waiting_child");
    delete parent.activeStep!.childRunId;
    store.saveRun(parent);

    await load(dataDir);
    await flush(() => store.getRun(parentRunId)!.currentStepId === "after");

    expect(store.getRun(parentRunId)!.history.find((h) => h.stepId === "sub")?.childRunId).toBe(childRunId);
    expect(childrenOf(parentRunId)).toEqual([childRunId]); // no duplicate
  });
});

// ── Parallel branches ───────────────────────────────────────────────────

describe("execution keys — parallel branches", () => {
  it("adopts the branches that spawned and starts the one that did not", async () => {
    const jobId = makeJob({
      steps: [
        {
          id: "checks",
          type: "parallel",
          mode: "all",
          branches: [
            { id: "a", type: "agent", prompt: "a", outputs: ["r"] },
            { id: "b", type: "agent", prompt: "b", outputs: ["r"] },
            { id: "c", type: "agent", prompt: "c", outputs: ["r"] },
          ],
        },
      ],
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => Object.values(store.getRun(runId)!.activeStep!.parallel!.branches).every((b) => !!b.chatId));

    const branches = store.getRun(runId)!.activeStep!.parallel!.branches;
    expect(branches.a.executionKey).toBe(`${runId}:checks:1:a`);
    const [chatA, chatB] = [branches.a.chatId!, branches.b.chatId!];

    // a and b reported and their sessions died with the process; c never got
    // as far as creating a session (no chat carries its key).
    store.recordStepResult(runId, "checks", { outputs: { r: "A" } }, "a");
    store.recordStepResult(runId, "checks", { outputs: { r: "B" } }, "b");
    const run = store.getRun(runId)!;
    delete run.activeStep!.parallel!.branches.c.chatId;
    store.saveRun(run);

    await load(dataDir);

    // c is spawned fresh; a and b are harvested from their original sessions.
    await flush(() => !!store.getRun(runId)!.activeStep?.parallel?.branches.c.chatId);
    const chatC = store.getRun(runId)!.activeStep!.parallel!.branches.c.chatId!;
    expect([chatA, chatB]).not.toContain(chatC);

    endBranch(runId, "checks", "c", { outputs: { r: "C" } });
    await flush(() => store.getRun(runId)!.status === "succeeded");

    const history = store.getRun(runId)!.history;
    expect(history.find((h) => h.branchId === "a")?.chatId).toBe(chatA);
    expect(history.find((h) => h.branchId === "b")?.chatId).toBe(chatB);
    expect(history.find((h) => h.branchId === "c")?.chatId).toBe(chatC);
    expect(history.find((h) => h.stepType === "parallel")?.outputs).toMatchObject({ a: { r: "A" }, b: { r: "B" }, c: { r: "C" } });
  });
});

// ── Agent step sessions ─────────────────────────────────────────────────

describe("execution keys — agent step sessions", () => {
  it("recovers a session whose chatId never reached the run file", async () => {
    const jobId = makeJob({ steps: [{ id: "work", type: "agent", prompt: "Do it" }] });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => !!store.getRun(runId)?.activeStep?.chatId);
    const key = store.getRun(runId)!.activeStep!.executionKey!;
    expect(key).toBe(`${runId}:work:1`);

    // The chat record claude.ts writes at session creation, stamped with the
    // key — this is what survives the crash.
    chats.upsertChat("session-orphan", dataDir, "session-orphan", { metadata: JSON.stringify({ jobRunId: runId, jobStepId: "work", jobExecutionKey: key }) });

    // Killed before the chatId hit the run file.
    const run = store.getRun(runId)!;
    delete run.activeStep!.chatId;
    store.saveRun(run);

    await load(dataDir);
    await flush(() => store.getRun(runId)!.status === "succeeded");

    // The stranded session was adopted and harvested, not abandoned for a
    // second one.
    const entry = store.getRun(runId)!.history.find((h) => h.stepId === "work");
    expect(entry?.chatId).toBe("session-orphan");
    expect(entry?.result).toBe("completed_unstructured");
    expect(store.getRun(runId)!.sessionsSpawned).toBe(1); // no replacement session spawned
  });

  it("re-enters the step when the key produced no session at all", async () => {
    const jobId = makeJob({
      steps: [
        { id: "work", type: "agent", prompt: "Do it" },
        { id: "after", type: "agent", prompt: "After" },
      ],
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => !!store.getRun(runId)?.activeStep?.chatId);
    const firstChat = store.getRun(runId)!.activeStep!.chatId!;

    const run = store.getRun(runId)!;
    delete run.activeStep!.chatId;
    store.saveRun(run);

    await load(dataDir);
    await flush(() => !!store.getRun(runId)!.activeStep?.chatId);

    const fresh = store.getRun(runId)!;
    expect(fresh.activeStep!.chatId).not.toBe(firstChat);
    expect(fresh.activeStep!.executionKey).toBe(`${runId}:work:2`); // a new attempt, a new key
  });
});

// ── Idempotent spawn ────────────────────────────────────────────────────

describe("execution keys — idempotent spawnJobRun", () => {
  it("returns the existing run when called twice with the same key", async () => {
    const jobId = makeJob({ steps: [{ id: "work", type: "agent", prompt: "Do it" }] });
    const key = "run-external:step:1";

    const first = runner.spawnJobRun(jobId, {}, undefined, { executionKey: key });
    const second = runner.spawnJobRun(jobId, {}, undefined, { executionKey: key });

    expect(second.runId).toBe(first.runId);
    expect(store.listRuns({ jobId })).toHaveLength(1);
    expect(store.getRun(first.runId)!.executionKey).toBe(key);
  });

  it("does not dedupe against a terminal run", async () => {
    const jobId = makeJob({ steps: [{ id: "work", type: "agent", prompt: "Do it" }] });
    const key = "run-external:step:1";

    const first = runner.spawnJobRun(jobId, {}, undefined, { executionKey: key });
    await flush(() => !!store.getRun(first.runId)?.activeStep?.chatId);
    runner.cancelRun(first.runId);

    const second = runner.spawnJobRun(jobId, {}, undefined, { executionKey: key });
    expect(second.runId).not.toBe(first.runId);
  });
});

// ── Migration ───────────────────────────────────────────────────────────

describe("execution keys — runs persisted before they existed", () => {
  it("falls back to the legacy child scan when the step attempt has no key", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [
        { id: "sub", type: "job", jobId: childId, outputs: ["result"] },
        { id: "after", type: "agent", prompt: "After" },
      ],
    });
    const { parentRunId, childRunId } = await spawnParentAndChild(parentId);
    store.recordStepResult(childRunId, "work", { outputs: { result: "ok" } });

    // Rewrite both runs the way the previous release persisted them: no keys
    // anywhere, and the parent still "running" (the old code wrote
    // waiting_child only after the spawn returned).
    const child = store.getRun(childRunId)!;
    delete child.executionKey;
    store.saveRun(child);
    const parent = store.getRun(parentRunId)!;
    parent.status = "running";
    delete parent.executionCounts;
    parent.activeStep = { stepId: "sub", attempt: 1, startedAt: parent.activeStep!.startedAt };
    store.saveRun(parent);

    await load(dataDir);
    await flush(() => store.getRun(parentRunId)!.currentStepId === "after");

    expect(store.getRun(parentRunId)!.history.find((h) => h.stepId === "sub")?.childRunId).toBe(childRunId);
    expect(childrenOf(parentRunId)).toEqual([childRunId]);
  });
});
