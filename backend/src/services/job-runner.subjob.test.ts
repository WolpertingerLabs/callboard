/**
 * Runner-level tests for run-level outputs (definition.outputs) and the "job"
 * step (sub-job composition).
 *
 * Same harness as job-runner.parallel.test.ts: fake claude.ts deps are
 * injected so step sessions start/end deterministically, and each test loads
 * a fresh module graph against its own throwaway CALLBOARD_DATA_DIR. A child
 * run is driven exactly like any other run — its agent session ends via
 * recordStepResult + a session_stopped event — and its terminal transition is
 * what notifies the waiting parent.
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
let stopCalls: string[];
let chatCounter: number;
let jobCounter: number;

async function load(dir: string): Promise<void> {
  process.env.CALLBOARD_DATA_DIR = dir;
  vi.resetModules();
  store = await import("./job-store.js");
  registry = (await import("./session-registry.js")).sessionRegistry;
  runner = await import("./job-runner.js");

  activeSessions = new Set();
  stopCalls = [];
  chatCounter = 0;
  jobCounter = 0;

  runner.setJobRunnerDeps({
    sendMessage: async () => {
      const chatId = `chat-${++chatCounter}`;
      activeSessions.add(chatId);
      const emitter = new EventEmitter();
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
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!predicate()) throw new Error("flush(): condition not met within timeout");
}

function makeJob(def: Record<string, unknown>): string {
  const job = store.createJob({ name: `job-${++jobCounter}`, ...def } as never);
  return job.id;
}

/** Standard child job: one agent step reporting `result`, surfaced as a run-level output. */
function makeChildJob(extra: Record<string, unknown> = {}): string {
  return makeJob({
    inputs: [{ key: "task", required: false, default: "" }],
    steps: [{ id: "work", type: "agent", prompt: "Do {{inputs.task}}", outputs: ["result"] }],
    outputs: { result: "{{steps.work.outputs.result}}" },
    ...extra,
  });
}

/** Simulate the active step session of `runId` finishing: persist its result, emit the stop. */
function endStep(runId: string, stepId: string, result?: JobStepResult): void {
  const chatId = store.getRun(runId)!.activeStep!.chatId!;
  if (result) store.recordStepResult(runId, stepId, result);
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
  const childRunId = store.getRun(parentRunId)!.activeStep!.childRunId!;
  expect(store.getRun(parentRunId)!.status).toBe("waiting_child");
  return { parentRunId, childRunId };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "callboard-runner-"));
  await load(dataDir);
});

afterEach(() => {
  runner.shutdownJobRunner();
  rmSync(dataDir, { recursive: true, force: true });
});

// ── Run-level outputs ───────────────────────────────────────────────────

describe("run-level outputs (definition.outputs)", () => {
  it("resolves declared outputs on success; bare refs keep native types; unresolvable keys are omitted", async () => {
    const jobId = makeJob({
      steps: [{ id: "work", type: "agent", prompt: "Do it", outputs: ["r"] }],
      outputs: { r: "{{steps.work.outputs.r}}", banner: "Result: {{steps.work.outputs.r}}", missing: "{{steps.work.outputs.nope}}" },
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => !!store.getRun(runId)?.activeStep?.chatId);

    endStep(runId, "work", { outputs: { r: { n: 1 } } });
    await flush(() => store.getRun(runId)!.status === "succeeded");

    const run = store.getRun(runId)!;
    expect(run.outputs?.r).toEqual({ n: 1 }); // bare ref → native type
    expect(run.outputs?.banner).toContain('"n": 1'); // mixed template → string
    expect(run.outputs).not.toHaveProperty("missing"); // unresolvable → omitted, run still succeeds
  });

  it("does not resolve outputs on failed runs", async () => {
    const jobId = makeJob({
      steps: [{ id: "work", type: "agent", prompt: "Do it", outputs: ["r"] }],
      outputs: { r: "{{steps.work.outputs.r}}" },
    });
    const runId = runner.spawnJobRun(jobId, {}).runId;
    await flush(() => !!store.getRun(runId)?.activeStep?.chatId);

    endStep(runId, "work", { summary: "gave up" }); // missing required output → step fails
    await flush(() => store.getRun(runId)!.status === "failed");
    expect(store.getRun(runId)!.outputs).toBeUndefined();
  });
});

// ── Job step: happy path ────────────────────────────────────────────────

describe("job step — happy path", () => {
  it("spawns a linked child run, waits on it, harvests its outputs, and advances", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      inputs: [{ key: "topic", required: true }],
      steps: [
        { id: "sub", type: "job", jobId: childId, inputs: { task: "Research {{inputs.topic}}" }, outputs: ["result"] },
        { id: "after", type: "agent", prompt: "Use {{steps.sub.outputs.result}}" },
      ],
    });

    const { parentRunId, childRunId } = await spawnParentAndChild(parentId, { topic: "geese" });

    // Linkage + templated inputs flowed into the child.
    const child = store.getRun(childRunId)!;
    expect(child.parentRunId).toBe(parentRunId);
    expect(child.parentStepId).toBe("sub");
    expect(child.depth).toBe(1);
    expect(child.inputs.task).toBe("Research geese");

    // Parent spawned no session of its own for the job step.
    expect(store.getRun(parentRunId)!.sessionsSpawned).toBe(0);

    endStep(childRunId, "work", { outputs: { result: "42" } });
    await flush(() => store.getRun(parentRunId)!.currentStepId === "after");

    const parent = store.getRun(parentRunId)!;
    expect(parent.status).toBe("running");
    expect(store.getRun(childRunId)!.status).toBe("succeeded");
    const entry = parent.history.find((h) => h.stepId === "sub");
    expect(entry?.stepType).toBe("job");
    expect(entry?.result).toBe("completed");
    expect(entry?.childRunId).toBe(childRunId);
    expect(entry?.outputs).toEqual({ result: "42" });
  });

  it("handles a child that finishes synchronously inside the spawn (gate-only job)", async () => {
    const childId = makeJob({
      steps: [{ id: "g", type: "gate", condition: { all: [{ ref: "run.id", op: "exists" }] }, onFail: "fail" }],
      outputs: { rid: "{{run.id}}" },
    });
    const parentId = makeJob({
      steps: [
        { id: "sub", type: "job", jobId: childId, outputs: ["rid"] },
        { id: "after", type: "agent", prompt: "Done" },
      ],
    });

    const parentRunId = runner.spawnJobRun(parentId, {}).runId;
    await flush(() => store.getRun(parentRunId)!.currentStepId === "after");

    const parent = store.getRun(parentRunId)!;
    const entry = parent.history.find((h) => h.stepId === "sub")!;
    expect(entry.result).toBe("completed");
    expect(entry.outputs?.rid).toBe(entry.childRunId);
    expect(store.getRun(entry.childRunId!)!.status).toBe("succeeded");
  });
});

// ── Job step: failure routing ───────────────────────────────────────────

describe("job step — failure routing", () => {
  it("routes to onFailure when the child run fails", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [
        { id: "sub", type: "job", jobId: childId, outputs: ["result"], onFailure: "recover" },
        { id: "recover", type: "agent", prompt: "Recover" },
      ],
    });
    const { parentRunId, childRunId } = await spawnParentAndChild(parentId);

    endStep(childRunId, "work", { summary: "no result" }); // child agent misses required output → child fails
    await flush(() => store.getRun(parentRunId)!.currentStepId === "recover");

    const parent = store.getRun(parentRunId)!;
    expect(parent.status).toBe("running");
    expect(store.getRun(childRunId)!.status).toBe("failed");
    const entry = parent.history.find((h) => h.stepId === "sub");
    expect(entry?.result).toBe("failed");
    expect(entry?.detail).toContain("child run failed");
  });

  it("fails the parent by default when the child fails", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [{ id: "sub", type: "job", jobId: childId, outputs: ["result"] }],
    });
    const { parentRunId, childRunId } = await spawnParentAndChild(parentId);

    endStep(childRunId, "work", { summary: "no result" });
    await flush(() => store.getRun(parentRunId)!.status === "failed");
    expect(store.getRun(parentRunId)!.error).toContain("child run failed");
  });

  it("routes as a failure when the child run is cancelled directly", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [
        { id: "sub", type: "job", jobId: childId, onFailure: "recover" },
        { id: "recover", type: "agent", prompt: "Recover" },
      ],
    });
    const { parentRunId, childRunId } = await spawnParentAndChild(parentId);

    runner.cancelRun(childRunId);
    await flush(() => store.getRun(parentRunId)!.currentStepId === "recover");

    const entry = store.getRun(parentRunId)!.history.find((h) => h.stepId === "sub");
    expect(entry?.result).toBe("cancelled");
    expect(entry?.detail).toContain("cancelled");
  });

  it("fails the step when a succeeded child does not produce a required output", async () => {
    // Child declares `result` but its agent step doesn't require it, so a run
    // can succeed without it — the parent's harvest is what must fail.
    const childId = makeJob({
      steps: [{ id: "work", type: "agent", prompt: "Do it" }],
      outputs: { result: "{{steps.work.outputs.result}}" },
    });
    const parentId = makeJob({
      steps: [{ id: "sub", type: "job", jobId: childId, outputs: ["result"] }],
    });
    const { parentRunId, childRunId } = await spawnParentAndChild(parentId);

    endStep(childRunId, "work", { summary: "did the thing" }); // unstructured completion, no `result`
    await flush(() => store.getRun(parentRunId)!.status === "failed");

    expect(store.getRun(childRunId)!.status).toBe("succeeded");
    expect(store.getRun(parentRunId)!.error).toContain("did not produce required output(s): result");
  });

  it("re-checks the child's declared outputs when the step starts (definition drift)", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [
        { id: "prep", type: "agent", prompt: "Prep" },
        { id: "sub", type: "job", jobId: childId, outputs: ["result"] },
      ],
    });
    const parentRunId = runner.spawnJobRun(parentId, {}).runId;
    await flush(() => !!store.getRun(parentRunId)?.activeStep?.chatId);

    // While `prep` runs, the child job is updated to no longer declare `result`.
    const child = store.getJob(childId)!;
    store.updateJob(childId, { ...child, outputs: undefined });

    endStep(parentRunId, "prep", { summary: "ok" });
    await flush(() => store.getRun(parentRunId)!.status === "failed");
    expect(store.getRun(parentRunId)!.error).toContain("does not declare required output(s): result");
  });
});

// ── Job step: cancellation, timeout, depth ──────────────────────────────

describe("job step — cancellation and timeout", () => {
  it("cancelling the parent cascades to the child and its sessions", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({ steps: [{ id: "sub", type: "job", jobId: childId }] });
    const { parentRunId, childRunId } = await spawnParentAndChild(parentId);
    const childChat = store.getRun(childRunId)!.activeStep!.chatId!;

    runner.cancelRun(parentRunId);

    expect(store.getRun(parentRunId)!.status).toBe("cancelled");
    expect(store.getRun(childRunId)!.status).toBe("cancelled");
    expect(stopCalls).toContain(childChat);

    // The cascaded child's end notification must not advance the cancelled parent.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getRun(parentRunId)!.status).toBe("cancelled");
    expect(store.getRun(parentRunId)!.history.find((h) => h.stepId === "sub")).toBeUndefined();
  });

  it("cancels the child and routes onTimeout when timeoutHours elapses", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [
        // ~360ms — small enough to elapse inside the test.
        { id: "sub", type: "job", jobId: childId, timeoutHours: 0.0001, onTimeout: "fallback" },
        { id: "fallback", type: "agent", prompt: "Fallback" },
      ],
    });
    const { parentRunId, childRunId } = await spawnParentAndChild(parentId);

    await flush(() => store.getRun(parentRunId)!.currentStepId === "fallback");

    expect(store.getRun(childRunId)!.status).toBe("cancelled");
    const entry = store.getRun(parentRunId)!.history.find((h) => h.stepId === "sub");
    expect(entry?.result).toBe("timeout");
    expect(entry?.childRunId).toBe(childRunId);
  });

  it("fails a run that would exceed the max nesting depth", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({ steps: [{ id: "sub", type: "job", jobId: childId }] });

    // Simulate a run already at the depth limit (as if spawned by a deep chain).
    const runId = runner.spawnJobRun(parentId, {}, { parentRunId: "run-nonexistent", parentStepId: "x", depth: 5 }).runId;
    await flush(() => store.getRun(runId)!.status === "failed");
    expect(store.getRun(runId)!.error).toContain("nesting depth");
  });
});

// ── Job step: pause/resume and restart ──────────────────────────────────

describe("job step — pause/resume and restart", () => {
  it("reconciles on resume when the child finished while the parent was paused", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [
        { id: "sub", type: "job", jobId: childId, outputs: ["result"] },
        { id: "after", type: "agent", prompt: "After" },
      ],
    });
    const { parentRunId, childRunId } = await spawnParentAndChild(parentId);

    runner.pauseRun(parentRunId);
    expect(store.getRun(parentRunId)!.status).toBe("paused");

    // The child is NOT paused — it keeps running and finishes.
    endStep(childRunId, "work", { outputs: { result: "ok" } });
    await flush(() => store.getRun(childRunId)!.status === "succeeded");
    expect(store.getRun(parentRunId)!.status).toBe("paused"); // notification dropped while paused

    runner.resumeRun(parentRunId);
    await flush(() => store.getRun(parentRunId)!.currentStepId === "after");
    expect(store.getRun(parentRunId)!.history.find((h) => h.stepId === "sub")?.result).toBe("completed");
  });

  it("resumes a waiting parent and an in-flight child across a restart", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({
      steps: [
        { id: "sub", type: "job", jobId: childId, outputs: ["result"] },
        { id: "after", type: "agent", prompt: "After" },
      ],
    });
    const { parentRunId, childRunId } = await spawnParentAndChild(parentId);

    // Child reported its result but the backend died before harvesting.
    store.recordStepResult(childRunId, "work", { outputs: { result: "ok" } });

    await load(dataDir); // reboot: child harvests its dead session, then notifies the parent

    await flush(() => store.getRun(parentRunId)!.currentStepId === "after");
    expect(store.getRun(childRunId)!.status).toBe("succeeded");
    expect(store.getRun(parentRunId)!.history.find((h) => h.stepId === "sub")?.outputs).toEqual({ result: "ok" });
  });

  it("fails the parent on restart when the child run file is gone", async () => {
    const childId = makeChildJob();
    const parentId = makeJob({ steps: [{ id: "sub", type: "job", jobId: childId }] });
    const { parentRunId, childRunId } = await spawnParentAndChild(parentId);

    store.deleteRun(childRunId);
    await load(dataDir);

    await flush(() => store.getRun(parentRunId)!.status === "failed");
    expect(store.getRun(parentRunId)!.error).toContain("lost its child run");
  });
});

// ── Validation ──────────────────────────────────────────────────────────

describe("validation — job steps and run-level outputs", () => {
  function validate(def: Record<string, unknown>): string[] {
    return store.validateJobDefinition({ id: "test-job", name: "Test", ...def } as never);
  }

  it("rejects a job step referencing an unknown job", () => {
    const errors = validate({ steps: [{ id: "sub", type: "job", jobId: "no-such-job" }] });
    expect(errors.some((e) => e.includes('unknown job "no-such-job"'))).toBe(true);
  });

  it("rejects self-reference", () => {
    const errors = validate({ steps: [{ id: "sub", type: "job", jobId: "test-job" }] });
    expect(errors.some((e) => e.includes("cannot reference itself"))).toBe(true);
  });

  it("rejects a cross-job reference cycle", () => {
    const aId = makeJob({ steps: [{ id: "work", type: "agent", prompt: "A" }] });
    const bId = makeJob({ steps: [{ id: "sub", type: "job", jobId: aId }] });
    const a = store.getJob(aId)!;
    expect(() => store.updateJob(aId, { ...a, steps: [{ id: "sub", type: "job", jobId: bId }] })).toThrowError(/cycle/);
  });

  it("rejects required step outputs the child does not declare, and unmet required child inputs", () => {
    const childId = makeJob({
      inputs: [{ key: "task", required: true }],
      steps: [{ id: "work", type: "agent", prompt: "Do {{inputs.task}}", outputs: ["result"] }],
      outputs: { result: "{{steps.work.outputs.result}}" },
    });
    const errors = validate({ steps: [{ id: "sub", type: "job", jobId: childId, outputs: ["result", "extra"] }] });
    expect(errors.some((e) => e.includes('does not declare a run-level output "extra"'))).toBe(true);
    expect(errors.some((e) => e.includes('requires input "task"'))).toBe(true);
  });

  it("validates templated job-step input values like prompts", () => {
    const childId = makeChildJob();
    const errors = validate({
      steps: [{ id: "sub", type: "job", jobId: childId, inputs: { task: "Do {{inputs.nope}}" } }],
    });
    expect(errors.some((e) => e.includes("undeclared input"))).toBe(true);
  });

  it("rejects run-level outputs referencing a step that does not run on every successful path", () => {
    const errors = validate({
      steps: [
        { id: "check", type: "agent", prompt: "check", outputs: ["v"] },
        { id: "g", type: "gate", condition: { all: [{ ref: "steps.check.outputs.v", op: "eq", value: "yes" }] }, onPass: "extra", onFail: "end" },
        { id: "extra", type: "agent", prompt: "extra", outputs: ["e"] },
      ],
      outputs: { v: "{{steps.check.outputs.v}}", e: "{{steps.extra.outputs.e}}" },
    });
    expect(errors.some((e) => e.includes("outputs.e") && e.includes("every successful path"))).toBe(true);
    expect(errors.some((e) => e.includes("outputs.v"))).toBe(false); // check dominates end
  });

  it("rejects malformed run-level output references", () => {
    const errors = validate({
      steps: [{ id: "work", type: "agent", prompt: "w" }],
      outputs: { a: "{{steps.work.result}}", b: "{{inputs.nope}}", c: "{{bogus.thing}}" },
    });
    expect(errors.some((e) => e.includes("outputs.a") && e.includes("steps.<id>.outputs.<key>"))).toBe(true);
    expect(errors.some((e) => e.includes("outputs.b") && e.includes("undeclared input"))).toBe(true);
    expect(errors.some((e) => e.includes("outputs.c") && e.includes("unknown reference"))).toBe(true);
  });
});
