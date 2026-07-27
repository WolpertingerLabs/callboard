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

/** Every jobContext the runner handed to sendMessage, with the chat it got. */
interface SentSession {
  chatId: string;
  runId: string;
  stepId: string;
  branchId?: string;
  executionKey?: string;
}
let sentSessions: SentSession[];

/**
 * Optional per-test gate on session startup: return a promise and that
 * session's chat_created is withheld until it resolves. That is how the window
 * between a session being spawned and its chatId being persisted — the one the
 * staleness guard has to survive — is held open on demand.
 */
let holdSession: ((ctx: SentSession) => Promise<void> | undefined) | null;

async function load(dir: string): Promise<void> {
  process.env.CALLBOARD_DATA_DIR = dir;
  vi.resetModules();
  store = await import("./job-store.js");
  registry = (await import("./session-registry.js")).sessionRegistry;
  chats = (await import("./chat-file-service.js")).chatFileService;
  runner = await import("./job-runner.js");

  activeSessions = new Set();
  sentSessions = [];

  runner.setJobRunnerDeps({
    sendMessage: async (params) => {
      const chatId = `chat-${++chatCounter}`;
      const sent: SentSession = { chatId, ...(params.jobContext as Omit<SentSession, "chatId">) };
      sentSessions.push(sent);
      activeSessions.add(chatId);
      const emitter = new EventEmitter();
      const held = holdSession?.(sent);
      if (held) void held.then(() => emitter.emit("event", { type: "chat_created", chatId }));
      else setImmediate(() => emitter.emit("event", { type: "chat_created", chatId }));
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
  holdSession = null;
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

// ── Key plumbing into the session ───────────────────────────────────────
//
// Everything agent-step recovery does rests on the key reaching sendMessage in
// the jobContext, since that is what claude.ts stamps into the chat record
// (jobExecutionKey) for findChatIdByJobExecutionKey to find later. The rest of
// this file simulates the chat record by hand, so without these two the wiring
// itself is untested.

describe("execution keys — reach the session that carries them", () => {
  it("passes the step's key to sendMessage in the jobContext", async () => {
    const jobId = makeJob({ steps: [{ id: "work", type: "agent", prompt: "Do it" }] });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => !!store.getRun(runId)?.activeStep?.chatId);

    expect(sentSessions).toHaveLength(1);
    expect(sentSessions[0]).toMatchObject({ runId, stepId: "work", executionKey: `${runId}:work:1` });
    expect(sentSessions[0].executionKey).toBe(store.getRun(runId)!.activeStep!.executionKey);
    expect(sentSessions[0].branchId).toBeUndefined();
  });

  it("passes each parallel branch's own key — read from the branch record, not the step's", async () => {
    const jobId = makeJob({
      steps: [
        {
          id: "checks",
          type: "parallel",
          mode: "all",
          branches: [
            { id: "a", type: "agent", prompt: "a" },
            { id: "b", type: "agent", prompt: "b" },
          ],
        },
      ],
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => Object.values(store.getRun(runId)!.activeStep!.parallel!.branches).every((b) => !!b.chatId));

    const branches = store.getRun(runId)!.activeStep!.parallel!.branches;
    for (const branchId of ["a", "b"]) {
      const sent = sentSessions.find((s) => s.branchId === branchId);
      expect(sent).toMatchObject({ runId, stepId: "checks", executionKey: `${runId}:checks:1:${branchId}` });
      expect(sent!.executionKey).toBe(branches[branchId].executionKey);
    }
  });

  it("gives an advisory notifier no key at all — it never advances a run, so there is nothing to recover", async () => {
    const jobId = makeJob({ steps: [{ id: "sign", type: "approval", message: "ok?" }] });
    runner.spawnJobRun(jobId, {});
    await flush(() => sentSessions.length > 0);

    expect(sentSessions[0].executionKey).toBeUndefined();
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

  // The test above never exercises the adoption leg: its branches either kept
  // their chatId (harvested directly) or had no session at all (re-spawned).
  it("adopts a branch session by execution key when only the branch's chatId was lost", async () => {
    const jobId = makeJob({
      steps: [
        {
          id: "checks",
          type: "parallel",
          mode: "all",
          branches: [
            { id: "a", type: "agent", prompt: "a", outputs: ["r"] },
            { id: "b", type: "agent", prompt: "b", outputs: ["r"] },
          ],
        },
      ],
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => Object.values(store.getRun(runId)!.activeStep!.parallel!.branches).every((b) => !!b.chatId));

    const branches = store.getRun(runId)!.activeStep!.parallel!.branches;
    const chatA = branches.a.chatId!;
    const keyB = branches.b.executionKey!;
    store.recordStepResult(runId, "checks", { outputs: { r: "A" } }, "a");
    store.recordStepResult(runId, "checks", { outputs: { r: "B" } }, "b");

    // b's session did get created — the chat record claude.ts writes carries
    // its execution key — but the branch's chatId never reached the run file.
    chats.upsertChat("branch-orphan", dataDir, "branch-orphan", {
      metadata: JSON.stringify({ jobRunId: runId, jobStepId: "checks", branchId: "b", jobExecutionKey: keyB }),
    });
    const run = store.getRun(runId)!;
    delete run.activeStep!.parallel!.branches.b.chatId;
    store.saveRun(run);

    await load(dataDir);
    await flush(() => store.getRun(runId)!.status === "succeeded");

    const history = store.getRun(runId)!.history;
    expect(history.find((h) => h.branchId === "a")?.chatId).toBe(chatA);
    expect(history.find((h) => h.branchId === "b")?.chatId).toBe("branch-orphan"); // adopted, not re-spawned
    expect(history.find((h) => h.stepType === "parallel")?.outputs).toMatchObject({ a: { r: "A" }, b: { r: "B" } });
    expect(store.getRun(runId)!.sessionsSpawned).toBe(2);
  });

  it("fails a branch that has to be restarted but is no longer in the definition", async () => {
    const jobId = makeJob({
      steps: [
        {
          id: "checks",
          type: "parallel",
          mode: "all",
          branches: [
            { id: "a", type: "agent", prompt: "a", outputs: ["r"] },
            { id: "b", type: "agent", prompt: "b", outputs: ["r"] },
          ],
        },
      ],
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => Object.values(store.getRun(runId)!.activeStep!.parallel!.branches).every((b) => !!b.chatId));
    store.recordStepResult(runId, "checks", { outputs: { r: "A" } }, "a");

    // b never got as far as a session, and its definition is gone from the
    // run's frozen copy — the shape a hand-edited run file or a bad migration
    // leaves behind. Skipping it silently would strand the branch "starting"
    // forever, with no wake timer and no timeout to notice.
    const run = store.getRun(runId)!;
    delete run.activeStep!.parallel!.branches.b.chatId;
    const parallelStep = run.definition.steps[0] as { branches: Array<{ id: string }> };
    parallelStep.branches = parallelStep.branches.filter((b) => b.id !== "b");
    store.saveRun(run);

    await load(dataDir);
    await flush(() => store.getRun(runId)!.status === "failed");

    const entry = store.getRun(runId)!.history.find((h) => h.branchId === "b");
    expect(entry?.result).toBe("error");
    expect(entry?.detail).toContain("no longer defined");
  });
});

// ── Parallel steps left unresolved by a crash ───────────────────────────
//
// A parallel step arms no wake timer and has no timeout, so anything that
// leaves it on activeStep with nothing left to resolve it hangs the run
// permanently. Both fixtures below are states a hard kill can leave on disk.

describe("execution keys — a parallel step whose branches all ended in the crash window", () => {
  it("resolves on restart instead of hanging with every branch terminal", async () => {
    const jobId = makeJob({
      steps: [
        {
          id: "checks",
          type: "parallel",
          mode: "all",
          branches: [
            { id: "a", type: "agent", prompt: "a", outputs: ["r"] },
            { id: "b", type: "agent", prompt: "b", outputs: ["r"] },
          ],
        },
        { id: "after", type: "agent", prompt: "After" },
      ],
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => Object.values(store.getRun(runId)!.activeStep!.parallel!.branches).every((b) => !!b.chatId));

    // handleParallelBranchSessionEnd persists the branch result and only then
    // awaits resolveParallelIfReady — so a kill in that gap on the last branch
    // leaves every branch terminal and the step unresolved. Nothing in the
    // restart loop looks at terminal branches.
    const run = store.getRun(runId)!;
    const endedAt = new Date().toISOString();
    for (const branchId of ["a", "b"]) {
      const branch = run.activeStep!.parallel!.branches[branchId];
      branch.status = "completed";
      branch.endedAt = endedAt;
      branch.outputs = { r: branchId.toUpperCase() };
    }
    store.saveRun(run);

    await load(dataDir);
    await flush(() => store.getRun(runId)!.currentStepId === "after");

    expect(store.getRun(runId)!.history.find((h) => h.stepType === "parallel")?.outputs).toMatchObject({ a: { r: "A" }, b: { r: "B" } });
  });

  it("resolves a race step killed after its winner was recorded but before it routed on", async () => {
    const jobId = makeJob({
      steps: [
        {
          id: "checks",
          type: "parallel",
          mode: "race",
          branches: [
            { id: "a", type: "agent", prompt: "a", outputs: ["r"] },
            { id: "b", type: "agent", prompt: "b", outputs: ["r"] },
          ],
        },
        { id: "after", type: "agent", prompt: "After" },
      ],
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => Object.values(store.getRun(runId)!.activeStep!.parallel!.branches).every((b) => !!b.chatId));

    // The race path sets winnerBranchId in memory and then persists it as a
    // side effect of each loser's appendHistory, well before enterStep runs.
    // Killed in there, restart finds a winner recorded, every branch terminal
    // and the step still unresolved — a state in which neither leg of the race
    // path used to fire.
    const run = store.getRun(runId)!;
    const parallel = run.activeStep!.parallel!;
    const endedAt = new Date().toISOString();
    parallel.branches.a.status = "completed";
    parallel.branches.a.endedAt = endedAt;
    parallel.branches.a.outputs = { r: "A" };
    parallel.branches.b.status = "cancelled";
    parallel.branches.b.endedAt = endedAt;
    parallel.branches.b.detail = `superseded by winning branch "a"`;
    parallel.winnerBranchId = "a";
    store.saveRun(run);

    await load(dataDir);
    await flush(() => store.getRun(runId)!.currentStepId === "after");

    const entry = store.getRun(runId)!.history.find((h) => h.stepType === "parallel");
    expect(entry?.result).toBe("completed");
    expect(entry?.outputs).toMatchObject({ _winner: "a", a: { r: "A" } });
    // Exactly one summary entry — the resume is idempotent against a kill that
    // landed after the entry was appended instead of before it.
    expect(store.getRun(runId)!.history.filter((h) => h.stepType === "parallel")).toHaveLength(1);
  });
});

// ── Staleness of an in-flight spawn ─────────────────────────────────────

describe("execution keys — a session that lands after its attempt was superseded", () => {
  it("does not let a re-entered step adopt the previous attempt's in-flight branch session", async () => {
    // A race step that routes back into itself: branch "a" wins, the step
    // re-enters, and the branch ids of the new attempt are the same as the old
    // one's — so a step-id comparison cannot tell the two attempts apart.
    const jobId = makeJob({
      steps: [
        {
          id: "checks",
          type: "parallel",
          mode: "race",
          branches: [
            { id: "a", type: "agent", prompt: "a", outputs: ["r"] },
            { id: "b", type: "agent", prompt: "b", outputs: ["r"] },
          ],
        },
        { id: "again", type: "gate", condition: { all: [{ ref: "run.id", op: "exists" }] }, onPass: "checks", onFail: "end", maxLoops: 3 },
      ],
    });

    // Hold branch b's FIRST session inside sendMessage, so its chat_created
    // arrives only after the step has moved on and come back.
    let releaseFirstB: (() => void) | undefined;
    holdSession = (ctx) => {
      if (ctx.branchId !== "b" || releaseFirstB) return undefined;
      return new Promise<void>((resolve) => {
        releaseFirstB = resolve;
      });
    };

    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => !!store.getRun(runId)!.activeStep!.parallel!.branches.a.chatId && !!releaseFirstB);
    const staleChatB = sentSessions.find((s) => s.branchId === "b")!.chatId;
    expect(store.getRun(runId)!.activeStep!.parallel!.branches.b.chatId).toBeUndefined();

    // a wins the race → b is cancelled → the gate routes straight back into
    // "checks", which mints attempt 2 and spawns both branches again.
    endBranch(runId, "checks", "a", { outputs: { r: "A" } });
    await flush(() => store.getRun(runId)!.activeStep?.parallel?.branches.b.executionKey === `${runId}:checks:2:b`);
    await flush(() => !!store.getRun(runId)!.activeStep!.parallel!.branches.b.chatId);
    const attempt2ChatB = store.getRun(runId)!.activeStep!.parallel!.branches.b.chatId!;
    expect(attempt2ChatB).not.toBe(staleChatB);

    // Only now does attempt 1's branch-b session finish starting.
    releaseFirstB!();
    await flush(() => !activeSessions.has(staleChatB) || store.getRun(runId)!.activeStep!.parallel!.branches.b.chatId === staleChatB);

    // The stale session was stopped, not written over attempt 2's branch — an
    // "all" step whose real session got orphaned this way never resolves, and
    // the stale session's output would have been harvested as attempt 2's.
    expect(store.getRun(runId)!.activeStep!.parallel!.branches.b.chatId).toBe(attempt2ChatB);
    expect(activeSessions.has(staleChatB)).toBe(false);
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
  // The discriminator is JobRun.executionCounts, not activeStep.executionKey:
  // a modern run can legitimately have an activeStep with no key (see the
  // enterStep-to-intent-write test below), and sending that run down the
  // legacy scan is exactly the mis-adoption keys exist to prevent. So this
  // fixture has to strip executionCounts to be a genuine legacy run.
  it("falls back to the legacy child scan for a run persisted without executionCounts", async () => {
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
    expect(store.getRun(parentRunId)!.executionCounts).toBeUndefined();

    await load(dataDir);
    await flush(() => store.getRun(parentRunId)!.currentStepId === "after");

    expect(store.getRun(parentRunId)!.history.find((h) => h.stepId === "sub")?.childRunId).toBe(childRunId);
    expect(childrenOf(parentRunId)).toEqual([childRunId]);
  });

  it("marks a run as keyed from birth, before it has minted a single key", async () => {
    // An approval step mints nothing (its notifier is advisory), so this run
    // reaches disk with the marker present and empty. Were executionCounts
    // created lazily at the first mint instead, a run killed anywhere before
    // that mint would read as legacy — which is the very window the key
    // exists to close.
    const jobId = makeJob({ steps: [{ id: "sign", type: "approval", message: "ok?", notify: false }] });
    const runId = runner.spawnJobRun(jobId, {}).runId;

    await flush(() => store.getRun(runId)!.status === "waiting_approval");
    const run = store.getRun(runId)!;
    expect(run.executionCounts).toEqual({});
    expect(run.activeStep!.executionKey).toBeUndefined();
  });
});

// ── The enterStep-to-intent-write window ────────────────────────────────

describe("execution keys — a keyed run killed before its key was written", () => {
  it("re-enters the step rather than falling back to the legacy scan", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [
        { id: "sub", type: "job", jobId: childId, outputs: ["result"], onFailure: "sub", maxLoops: 2 },
        { id: "after", type: "agent", prompt: "After" },
      ],
    });
    const { parentRunId, childRunId: attempt1Child } = await spawnParentAndChild(parentId);
    store.recordStepResult(attempt1Child, "work", { outputs: { result: "from attempt 1" } });

    // Two kills again: attempt 1's child was spawned but its linkage never
    // landed (so it is not in history either), and the run was then killed on
    // its way into attempt 2 — after enterStep's saveRun, before
    // startSubJobStep's intent write. The activeStep therefore has no key at
    // all, even though this is a run that mints them.
    const parent = store.getRun(parentRunId)!;
    parent.status = "running";
    parent.currentStepId = "sub";
    parent.activeStep = { stepId: "sub", attempt: 1, startedAt: new Date().toISOString() };
    parent.loopCounts = { sub: 1 };
    store.saveRun(parent);
    expect(store.getRun(parentRunId)!.executionCounts).toEqual({ sub: 1 });

    // The legacy scan, if it were reached, would hand attempt 2 the stale
    // attempt-1 child and attribute its outputs to attempt 2.
    expect(store.findChildRun(parentRunId, "sub", new Set())?.runId).toBe(attempt1Child);

    await load(dataDir);
    await flush(() => !!store.getRun(parentRunId)!.activeStep?.childRunId);

    const recovered = store.getRun(parentRunId)!;
    expect(recovered.activeStep!.childRunId).not.toBe(attempt1Child);
    expect(recovered.activeStep!.executionKey).toBe(`${parentRunId}:sub:2`); // a fresh ordinal, not the abandoned one
    expect(recovered.history.some((h) => h.childRunId === attempt1Child)).toBe(false);
    expect(childrenOf(parentRunId)).toHaveLength(2);
  });
});
