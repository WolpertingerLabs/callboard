/**
 * Runner-level tests for the `parallel` job step (plan test items 5–9).
 *
 * The runner takes claude.ts (sendMessage/stopSession/getActiveSession) via
 * setJobRunnerDeps(), and drives step lifecycles off sessionRegistry
 * "session_stopped" events. These tests inject fakes for those deps so branch
 * sessions can be started and ended deterministically — no real agent sessions
 * are spawned. A branch "ends" by writing its complete_job_step result with
 * recordStepResult() (exactly what the job-step tool does) and then emitting a
 * session_stopped event, which is how the runner harvests the outcome.
 *
 * Each test loads a fresh module graph against its own throwaway CALLBOARD_DATA_DIR
 * so the in-memory runner state (chatToStep, run queues, the once-only init guard)
 * starts clean — and so the restart test can re-import the runner against the same
 * on-disk run file to simulate a backend reboot.
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

/** Fake-session state, recreated per load() so each test is isolated. */
let activeSessions: Set<string>;
let stopCalls: string[];
let chatCounter: number;

/**
 * Reset the module graph against `dir` and wire fake runner deps. Returns once
 * the runner is initialized (its session_stopped listener registered, and any
 * resumable runs in `dir` picked up).
 */
async function load(dir: string): Promise<void> {
  process.env.CALLBOARD_DATA_DIR = dir;
  vi.resetModules();
  store = await import("./job-store.js");
  registry = (await import("./session-registry.js")).sessionRegistry;
  runner = await import("./job-runner.js");

  activeSessions = new Set();
  stopCalls = [];
  chatCounter = 0;

  runner.setJobRunnerDeps({
    sendMessage: async () => {
      const chatId = `chat-${++chatCounter}`;
      activeSessions.add(chatId);
      const emitter = new EventEmitter();
      // Emit after the runner attaches its "event" listener inside spawnStepSession.
      setImmediate(() => emitter.emit("event", { type: "chat_created", chatId }));
      return emitter;
    },
    stopSession: (chatId: string) => {
      stopCalls.push(chatId);
      return activeSessions.delete(chatId);
    },
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

/** All branch ids of the active parallel step that have a live chat session. */
function activeBranchChatIds(runId: string): Record<string, string> {
  const run = store.getRun(runId)!;
  const out: Record<string, string> = {};
  for (const [id, b] of Object.entries(run.activeStep?.parallel?.branches ?? {})) {
    if (b.chatId) out[id] = b.chatId;
  }
  return out;
}

function branchStatus(runId: string, branchId: string): string | undefined {
  return store.getRun(runId)!.activeStep?.parallel?.branches[branchId]?.status;
}

/** Simulate a branch session finishing: persist its result, then emit the stop. */
function endBranch(runId: string, parentStepId: string, branchId: string, result?: JobStepResult): void {
  const chatId = store.getRun(runId)!.activeStep!.parallel!.branches[branchId].chatId!;
  if (result) store.recordStepResult(runId, parentStepId, result, branchId);
  activeSessions.delete(chatId);
  registry.emit("change", { event: "session_stopped", chatId });
}

/** Create a job with the given steps and spawn a run, waiting until branches are live. */
async function spawnParallel(steps: unknown[], waitBranchIds: string[], parentStepId: string): Promise<string> {
  const job = store.createJob({ name: `job-${chatCounter}-${Math.round(performance.now())}`, steps: steps as never });
  const run = runner.spawnJobRun(job.id, {});
  await flush(() => {
    const branches = store.getRun(run.runId)?.activeStep?.parallel?.branches;
    return !!branches && waitBranchIds.every((id) => branches[id]?.status === "running" && !!branches[id]?.chatId);
  });
  expect(store.getRun(run.runId)!.currentStepId).toBe(parentStepId);
  return run.runId;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "callboard-runner-"));
  await load(dataDir);
});

afterEach(() => {
  runner.shutdownJobRunner();
  rmSync(dataDir, { recursive: true, force: true });
});

// ── Item 5: race winner cancels losers and advances exactly once ────────

describe("parallel race — winner selection (item 5)", () => {
  const steps = [
    {
      id: "compare",
      type: "parallel",
      mode: "race",
      branches: [
        { id: "opus", type: "agent", prompt: "Solve it", outputs: ["answer"] },
        { id: "sonnet", type: "agent", prompt: "Solve it", outputs: ["answer"] },
      ],
    },
    { id: "review", type: "agent", prompt: "Review it" },
  ];

  it("cancels losing branches, records the winner, and advances once", async () => {
    const runId = await spawnParallel(steps, ["opus", "sonnet"], "compare");
    const loserChat = activeBranchChatIds(runId).sonnet;

    endBranch(runId, "compare", "opus", { outputs: { answer: "42" }, summary: "done" });
    await flush(() => store.getRun(runId)!.currentStepId === "review");

    const run = store.getRun(runId)!;
    // Advanced to the next step (a fresh agent session, no parallel state).
    expect(run.status).toBe("running");
    expect(run.activeStep?.parallel).toBeUndefined();

    // Winner recorded on the parent aggregate entry.
    const parents = run.history.filter((h) => h.stepId === "compare" && h.stepType === "parallel");
    expect(parents).toHaveLength(1);
    expect(parents[0].result).toBe("completed");
    expect(parents[0].outputs?._winner).toBe("opus");
    expect((parents[0].outputs?._winnerOutputs as Record<string, unknown>).answer).toBe("42");

    // Loser was stopped and recorded as cancelled.
    expect(stopCalls).toContain(loserChat);
    const loser = run.history.find((h) => h.stepId === "compare" && h.branchId === "sonnet");
    expect(loser?.result).toBe("cancelled");
    expect(loser?.detail).toContain("superseded");
  });

  it("does not advance a second time when a cancelled loser later emits its stop", async () => {
    const runId = await spawnParallel(steps, ["opus", "sonnet"], "compare");
    const loserChat = activeBranchChatIds(runId).sonnet;

    endBranch(runId, "compare", "opus", { outputs: { answer: "42" } });
    await flush(() => store.getRun(runId)!.currentStepId === "review" && !!store.getRun(runId)!.activeStep?.chatId);
    const reviewChat = store.getRun(runId)!.activeStep!.chatId;

    // The loser's session ends late (e.g. the stopSession-induced stop event).
    // chatToStep was already pruned for it, so this must be a no-op.
    registry.emit("change", { event: "session_stopped", chatId: loserChat });
    await new Promise((resolve) => setImmediate(resolve));

    const run = store.getRun(runId)!;
    expect(run.currentStepId).toBe("review");
    expect(run.activeStep?.chatId).toBe(reviewChat); // review session not disturbed
    expect(run.history.filter((h) => h.stepId === "compare" && h.stepType === "parallel")).toHaveLength(1);
  });
});

// ── Item 6: race ignores failed branches until a success or all fail ────

describe("parallel race — failure handling (item 6)", () => {
  it("a failed branch does not win; a later success does", async () => {
    const steps = [
      {
        id: "compare",
        type: "parallel",
        mode: "race",
        branches: [
          { id: "a", type: "agent", prompt: "Solve it", outputs: ["answer"] },
          { id: "b", type: "agent", prompt: "Solve it", outputs: ["answer"] },
        ],
      },
      { id: "review", type: "agent", prompt: "Review it" },
    ];
    const runId = await spawnParallel(steps, ["a", "b"], "compare");

    // Branch a finishes WITHOUT its required output → recorded as failed.
    endBranch(runId, "compare", "a", { summary: "gave up" });
    await flush(() => branchStatus(runId, "a") === "failed");

    // The failed branch must NOT win or advance the run.
    let run = store.getRun(runId)!;
    expect(run.currentStepId).toBe("compare");
    expect(run.status).toBe("running");
    expect(run.activeStep?.parallel?.winnerBranchId).toBeUndefined();

    // Branch b then succeeds → it becomes the winner.
    endBranch(runId, "compare", "b", { outputs: { answer: "ok" } });
    await flush(() => store.getRun(runId)!.currentStepId === "review");

    run = store.getRun(runId)!;
    const parent = run.history.find((h) => h.stepId === "compare" && h.stepType === "parallel");
    expect(parent?.outputs?._winner).toBe("b");
  });

  it("routes to onFailure only once every branch has failed", async () => {
    const steps = [
      {
        id: "compare",
        type: "parallel",
        mode: "race",
        onFailure: "recover",
        branches: [
          { id: "a", type: "agent", prompt: "Solve it", outputs: ["answer"] },
          { id: "b", type: "agent", prompt: "Solve it", outputs: ["answer"] },
        ],
      },
      { id: "recover", type: "agent", prompt: "Recover" },
    ];
    const runId = await spawnParallel(steps, ["a", "b"], "compare");

    endBranch(runId, "compare", "a", { summary: "no answer" });
    await flush(() => branchStatus(runId, "a") === "failed");
    // One branch failed — still waiting, not yet routed.
    expect(store.getRun(runId)!.currentStepId).toBe("compare");

    endBranch(runId, "compare", "b", { summary: "no answer" });
    await flush(() => store.getRun(runId)!.currentStepId === "recover");

    const run = store.getRun(runId)!;
    expect(run.status).toBe("running");
    const parent = run.history.find((h) => h.stepId === "compare" && h.stepType === "parallel");
    expect(parent?.result).toBe("error");
    expect(parent?.detail).toContain("all race branches failed");
  });

  it("fails the run when all branches fail and onFailure defaults to fail", async () => {
    const steps = [
      {
        id: "compare",
        type: "parallel",
        mode: "race",
        branches: [
          { id: "a", type: "agent", prompt: "Solve it", outputs: ["answer"] },
          { id: "b", type: "agent", prompt: "Solve it", outputs: ["answer"] },
        ],
      },
    ];
    const runId = await spawnParallel(steps, ["a", "b"], "compare");

    endBranch(runId, "compare", "a", { summary: "no answer" });
    endBranch(runId, "compare", "b", { summary: "no answer" });
    await flush(() => store.getRun(runId)!.status === "failed");

    expect(store.getRun(runId)!.error).toContain("no successful branch");
  });
});

// ── Item 7: all mode waits for every branch to reach terminal state ─────

describe("parallel all — wait-for-all (item 7)", () => {
  const steps = (extra: Record<string, unknown> = {}) => [
    {
      id: "checks",
      type: "parallel",
      mode: "all",
      ...extra,
      branches: [
        { id: "t1", type: "agent", prompt: "check 1", outputs: ["r"] },
        { id: "t2", type: "agent", prompt: "check 2", outputs: ["r"] },
        { id: "t3", type: "agent", prompt: "check 3", outputs: ["r"] },
      ],
    },
    { id: "summarize", type: "agent", prompt: "Summarize" },
  ];

  it("does not advance until all branches are terminal", async () => {
    const runId = await spawnParallel(steps(), ["t1", "t2", "t3"], "checks");

    endBranch(runId, "checks", "t1", { outputs: { r: "pass" } });
    await flush(() => branchStatus(runId, "t1") === "completed");
    expect(store.getRun(runId)!.currentStepId).toBe("checks");

    endBranch(runId, "checks", "t2", { outputs: { r: "pass" } });
    await flush(() => branchStatus(runId, "t2") === "completed");
    expect(store.getRun(runId)!.currentStepId).toBe("checks"); // still waiting on t3

    endBranch(runId, "checks", "t3", { outputs: { r: "pass" } });
    await flush(() => store.getRun(runId)!.currentStepId === "summarize");

    const run = store.getRun(runId)!;
    const parent = run.history.find((h) => h.stepId === "checks" && h.stepType === "parallel");
    expect(parent?.result).toBe("completed");
    expect(parent?.outputs).toMatchObject({ t1: { r: "pass" }, t2: { r: "pass" }, t3: { r: "pass" } });
  });

  it("waits for all branches before routing a failure", async () => {
    const runId = await spawnParallel(steps({ onFailure: "fail" }), ["t1", "t2", "t3"], "checks");

    endBranch(runId, "checks", "t1", { outputs: { r: "pass" } });
    await flush(() => branchStatus(runId, "t1") === "completed");

    // t2 fails — but the parent must keep waiting on t3 rather than fail-fast.
    endBranch(runId, "checks", "t2", { summary: "boom" });
    await flush(() => branchStatus(runId, "t2") === "failed");
    expect(store.getRun(runId)!.status).toBe("running");
    expect(store.getRun(runId)!.currentStepId).toBe("checks");

    endBranch(runId, "checks", "t3", { outputs: { r: "pass" } });
    await flush(() => store.getRun(runId)!.status === "failed");

    const run = store.getRun(runId)!;
    const parent = run.history.find((h) => h.stepId === "checks" && h.stepType === "parallel");
    expect(parent?.result).toBe("error");
    expect(parent?.detail).toContain("t2");
  });
});

// ── Item 8: cancel stops all active branch sessions ─────────────────────

describe("parallel — cancel (item 8)", () => {
  it("stops every active branch session and prevents further advancement", async () => {
    const steps = [
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
      { id: "summarize", type: "agent", prompt: "Summarize" },
    ];
    const runId = await spawnParallel(steps, ["a", "b", "c"], "checks");
    const chats = activeBranchChatIds(runId);
    expect(Object.keys(chats)).toHaveLength(3);

    runner.cancelRun(runId);

    // Every live branch chat was stopped.
    for (const chatId of Object.values(chats)) expect(stopCalls).toContain(chatId);
    expect(store.getRun(runId)!.status).toBe("cancelled");

    // A late session_stopped for a cancelled branch must not advance the run.
    registry.emit("change", { event: "session_stopped", chatId: chats.a });
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getRun(runId)!.status).toBe("cancelled");
    expect(store.getRun(runId)!.currentStepId).toBe("checks");
  });
});

// ── Item 9: restart recovery loops all branch chat IDs ──────────────────

describe("parallel — restart recovery (item 9)", () => {
  it("harvests every branch session that ended during downtime", async () => {
    const steps = [
      {
        id: "checks",
        type: "parallel",
        mode: "all",
        branches: [
          { id: "a", type: "agent", prompt: "a", outputs: ["r"] },
          { id: "b", type: "agent", prompt: "b", outputs: ["r"] },
        ],
      },
    ];
    const runId = await spawnParallel(steps, ["a", "b"], "checks");

    // Both branches reported results (complete_job_step) but the backend went
    // down before harvesting — their sessions are gone, results persisted.
    store.recordStepResult(runId, "checks", { outputs: { r: "A" } }, "a");
    store.recordStepResult(runId, "checks", { outputs: { r: "B" } }, "b");

    // Simulate the reboot: fresh module graph over the same on-disk run file.
    // getActiveSession now returns undefined (sessions died with the process).
    await load(dataDir);

    await flush(() => store.getRun(runId)!.status === "succeeded");

    const run = store.getRun(runId)!;
    // Both branch chat ids were looped and harvested — not just one.
    const aEntry = run.history.find((h) => h.stepId === "checks" && h.branchId === "a");
    const bEntry = run.history.find((h) => h.stepId === "checks" && h.branchId === "b");
    expect(aEntry?.result).toBe("completed");
    expect(bEntry?.result).toBe("completed");
    const parent = run.history.find((h) => h.stepId === "checks" && h.stepType === "parallel");
    expect(parent?.result).toBe("completed");
    expect(parent?.outputs).toMatchObject({ a: { r: "A" }, b: { r: "B" } });
  });

  it("fails the parent step when a branch session cannot be recovered", async () => {
    const steps = [
      {
        id: "checks",
        type: "parallel",
        mode: "all",
        branches: [
          { id: "a", type: "agent", prompt: "a", outputs: ["r"] },
          { id: "b", type: "agent", prompt: "b", outputs: ["r"] },
        ],
      },
    ];
    const runId = await spawnParallel(steps, ["a", "b"], "checks");

    // Corrupt one branch's recorded chatId so restart can't recover it.
    const run = store.getRun(runId)!;
    delete run.activeStep!.parallel!.branches.a.chatId;
    store.saveRun(run);

    await load(dataDir);
    await flush(() => store.getRun(runId)!.status === "failed");

    expect(store.getRun(runId)!.error).toContain("could not recover");
  });
});
