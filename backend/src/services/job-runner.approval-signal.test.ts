/**
 * Runner-level tests for the one notification the sidebar's approval badge
 * depends on.
 *
 * `notifyRunUpdated` announces a run change by walking `activeChatIds`, which
 * reads `run.activeStep.chatId` — and an approval step never has one, because
 * `enterStep` sets a chatId only when it spawns a session. So on the way into
 * `waiting_approval` that walk iterates an empty list, `metadataVersion` never
 * moves, and an idle sidebar never asks for fresh rows (its poll is gated on
 * there being a live session). The badge would then land only if something
 * unrelated happened to wake the client.
 *
 * Every test here uses `notify: false` deliberately. With the notifier on, the
 * advisory session's own `session_started` incidentally wakes the client and
 * hides the defect; with it off, `syncApprovalSignal` is the only thing that
 * can announce, which is precisely the case that was broken.
 *
 * The chat-list cache is the other half and is asserted alongside: a bump that
 * makes the client ask is worth nothing if the answer is a response computed
 * before the transition.
 *
 * Same harness as job-runner.card.test.ts: fake claude.ts deps are injected so
 * step sessions start and end deterministically, and each test loads a fresh
 * module graph against its own throwaway CALLBOARD_DATA_DIR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type * as JobStoreModule from "./job-store.js";
import type * as JobRunnerModule from "./job-runner.js";
import type * as ChatListCacheModule from "./chat-list-cache.js";
import type { sessionRegistry as SessionRegistryType } from "./session-registry.js";

type Store = typeof JobStoreModule;
type Runner = typeof JobRunnerModule;
type Cache = typeof ChatListCacheModule;
type Registry = typeof SessionRegistryType;

let dataDir: string;
let store: Store;
let runner: Runner;
let cache: Cache;
let registry: Registry;

let activeSessions: Set<string>;
let chatCounter: number;
let jobCounter: number;
/** Every chat_metadata_updated the runner emitted, in order. */
let metadataEvents: Array<{ chatId: string; jobRunStatus?: string }>;

async function load(dir: string): Promise<void> {
  process.env.CALLBOARD_DATA_DIR = dir;
  vi.resetModules();
  store = await import("./job-store.js");
  registry = (await import("./session-registry.js")).sessionRegistry;
  cache = await import("./chat-list-cache.js");
  runner = await import("./job-runner.js");

  activeSessions = new Set();
  chatCounter = 0;
  jobCounter = 0;
  metadataEvents = [];

  registry.on("change", (event: any) => {
    if (event.event === "chat_metadata_updated") {
      metadataEvents.push({ chatId: event.chatId, jobRunStatus: event.data?.jobRunStatus });
    }
  });

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
  } as never);
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

/** One agent step, then an approval that does NOT spawn a notifier session. */
function makeApprovalJob(timeoutHours?: number): string {
  const job = store.createJob({
    name: `job-${++jobCounter}`,
    steps: [
      { id: "work", type: "agent", prompt: "Do it", next: "signoff" },
      { id: "signoff", type: "approval", message: "Ship it?", notify: false, ...(timeoutHours && { timeoutHours }) },
    ],
  } as never);
  return job.id;
}

/** Simulate the active step session of `runId` finishing. */
function endStep(runId: string): string {
  const chatId = store.getRun(runId)!.activeStep!.chatId!;
  activeSessions.delete(chatId);
  registry.emit("change", { event: "session_stopped", chatId });
  return chatId;
}

/** Put something in the chat-list cache so clearing it is observable. */
function seedCache(): void {
  cache.chatListCache.set("probe", { data: { chats: [], hasMore: false, total: 0, windowRows: 0 }, createdAt: Date.now() });
}

/** Run a job up to its approval step; returns the step chat that ran before it. */
async function runToApproval(timeoutHours?: number): Promise<{ runId: string; stepChatId: string }> {
  const runId = runner.spawnJobRun(makeApprovalJob(timeoutHours), {}).runId;
  await flush(() => !!store.getRun(runId)?.activeStep?.chatId);
  const stepChatId = endStep(runId);
  await flush(() => store.getRun(runId)?.status === "waiting_approval");
  return { runId, stepChatId };
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "callboard-approval-"));
  await load(dataDir);
});

afterEach(() => {
  runner.shutdownJobRunner();
  registry.removeAllListeners("change");
  rmSync(dataDir, { recursive: true, force: true });
});

describe("approval parking notifies the sidebar", () => {
  it("bumps metadataVersion when a run parks, with no session to carry the event", async () => {
    const runId = runner.spawnJobRun(makeApprovalJob(), {}).runId;
    await flush(() => !!store.getRun(runId)?.activeStep?.chatId);
    const stepChatId = endStep(runId);

    const before = registry.metadataVersion;
    await flush(() => store.getRun(runId)?.status === "waiting_approval");
    await flush(() => registry.metadataVersion > before);

    // The approval step has no chat of its own, so the announcement lands on
    // the run's representative — the step that last ran in one.
    const parked = metadataEvents.filter((e) => e.jobRunStatus === "waiting_approval");
    expect(parked.map((e) => e.chatId)).toContain(stepChatId);
  });

  it("clears the chat-list cache on the way in", async () => {
    const runId = runner.spawnJobRun(makeApprovalJob(), {}).runId;
    await flush(() => !!store.getRun(runId)?.activeStep?.chatId);
    seedCache();
    endStep(runId);

    await flush(() => store.getRun(runId)?.status === "waiting_approval");
    await flush(() => cache.chatListCache.size === 0);
    expect(cache.chatListCache.size).toBe(0);
  });

  it("announces exactly once while the run sits parked", async () => {
    const { runId } = await runToApproval();
    const parkedCount = () => metadataEvents.filter((e) => e.jobRunStatus === "waiting_approval").length;
    const first = parkedCount();
    expect(first).toBeGreaterThan(0);

    // A pause/resume round trip re-enters waiting_approval; nothing else should.
    runner.pauseRun(runId);
    expect(store.getRun(runId)!.status).toBe("paused");
    expect(parkedCount()).toBe(first);
  });
});

describe("answering an approval clears the signal", () => {
  it("notifies the row that was carrying the badge, not the next step's chat", async () => {
    const { runId, stepChatId } = await runToApproval();
    metadataEvents.length = 0;
    seedCache();

    runner.respondToApproval(runId, "approve");

    // The run has already advanced past the approval by now, so naming the
    // representative *after* the fact would point at a different chat.
    const cleared = metadataEvents.filter((e) => e.chatId === stepChatId);
    expect(cleared.length).toBeGreaterThan(0);
    expect(cleared.every((e) => e.jobRunStatus !== "waiting_approval")).toBe(true);
    expect(cache.chatListCache.size).toBe(0);
  });

  it("clears on reject as well as approve", async () => {
    const { runId, stepChatId } = await runToApproval();
    metadataEvents.length = 0;
    seedCache();

    runner.respondToApproval(runId, "reject", "no");

    expect(store.getRun(runId)!.status).toBe("failed");
    expect(metadataEvents.some((e) => e.chatId === stepChatId && e.jobRunStatus === "failed")).toBe(true);
    expect(cache.chatListCache.size).toBe(0);
  });

  it("clears when the parked run is cancelled", async () => {
    const { runId, stepChatId } = await runToApproval();
    metadataEvents.length = 0;
    seedCache();

    runner.cancelRun(runId);

    expect(metadataEvents.some((e) => e.chatId === stepChatId && e.jobRunStatus === "cancelled")).toBe(true);
    expect(cache.chatListCache.size).toBe(0);
  });

  it("clears when the approval times out with nobody watching", async () => {
    // The one release that fires with no user present, so a badge stuck here is
    // the least likely to be noticed. 0.36s of timeoutHours; armWakeTimer fires
    // onWake directly rather than re-arming when the deadline is that close.
    const { runId, stepChatId } = await runToApproval(0.0001);
    metadataEvents.length = 0;
    seedCache();

    await flush(() => store.getRun(runId)?.status === "failed", 5000);
    expect(metadataEvents.some((e) => e.chatId === stepChatId && e.jobRunStatus === "failed")).toBe(true);
    expect(metadataEvents.some((e) => e.jobRunStatus === "waiting_approval")).toBe(false);
    expect(cache.chatListCache.size).toBe(0);
  });

  it("clears when the parked run is paused, and re-announces on resume", async () => {
    const { runId, stepChatId } = await runToApproval();
    metadataEvents.length = 0;

    runner.pauseRun(runId);
    expect(metadataEvents.some((e) => e.chatId === stepChatId && e.jobRunStatus === "paused")).toBe(true);

    metadataEvents.length = 0;
    runner.resumeRun(runId);
    expect(store.getRun(runId)!.status).toBe("waiting_approval");
    expect(metadataEvents.some((e) => e.chatId === stepChatId && e.jobRunStatus === "waiting_approval")).toBe(true);
  });
});
