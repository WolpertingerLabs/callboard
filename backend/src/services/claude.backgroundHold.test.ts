/**
 * Integration tests for the background-task hold at the `claude.ts` seam.
 *
 * Every production defect this branch exists to fix lived here rather than in
 * `background-task-hold.ts` — a latch not reset, an event class miscounted as
 * work in progress, a drain that cancelled the run's last timer. The unit tests
 * next door cover `HeldPrompt` in isolation and pass whether or not the query
 * loop calls it correctly, which is precisely the gap: reverting any of the
 * wiring below leaves that file entirely green.
 *
 * ## How the hold is observed
 *
 * The mechanism is that the prompt iterable does not return. The SDK keeps the
 * CLI subprocess alive for exactly as long as that is true, so the harness
 * below plays the SDK's part: it consumes the prompt it was handed and, when
 * that iterable finally returns, ends the event stream — which is what stdin
 * closing does in production. `turn.promptOpen` is therefore a direct read of
 * "is this session still being held?", not a proxy for one.
 *
 * Events are pushed by the test rather than scripted up front, because the
 * interesting cases are all about *ordering* against a wall clock: an expiry
 * landing mid-turn, a task ending with no turn behind it.
 *
 * The hold window is squeezed to a second via the env var the module reads at
 * load, so the timing assertions are ratios of a real window rather than
 * mocked clocks — fake timers and a live `for await` over an async generator
 * do not compose well enough to trust here.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import type { AgentEvent } from "../agents/ports/events.js";
import type { AgentProvider, AgentQuery, AgentQueryRequest } from "../agents/ports/AgentProvider.js";
import type { StreamEvent } from "shared/types/index.js";

const dataDir = mkdtempSync(join(tmpdir(), "callboard-bg-hold-data-"));
process.env.CALLBOARD_DATA_DIR = dataDir;
const workDir = mkdtempSync(join(tmpdir(), "callboard-bg-hold-work-"));
/** Read once at module load by background-task-hold.ts — must precede the import. */
const HOLD_MS = 1000;
process.env.CALLBOARD_MAX_BACKGROUND_HOLD_MS = String(HOLD_MS);

const { sendMessage } = await import("./claude.js");
const { setAgentProviderForTesting } = await import("../agents/factory.js");
const { DEFAULT_MAX_HOLD_MS } = await import("./background-task-hold.js");
const { listActivities } = await import("./chat-activity.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TurnRecord {
  /** False once this query's held prompt iterable returned — i.e. it released. */
  promptOpen: boolean;
  /** Pending events, plus the parked reader waiting for one. */
  queued: AgentEvent[];
  wake: (() => void) | null;
  ended: boolean;
}

/**
 * A provider the test drives by hand, standing in for the CLI.
 *
 * Three things matter. `push` delivers events on demand, so a test can place
 * one either side of a deadline. Each query consumes its prompt the way the SDK
 * does, ending the stream when that iterable returns — without which a released
 * hold would leave the query loop parked forever and every test would time out
 * rather than fail. And the state is *per query*, because a stream recovery
 * closes one conversation and opens another within a single run: shared state
 * would let the first query's close end the second one on arrival.
 */
function controllableProvider() {
  const turns: TurnRecord[] = [];

  const nudge = (turn: TurnRecord) => {
    const w = turn.wake;
    turn.wake = null;
    w?.();
  };

  const provider: AgentProvider = {
    kind: "mock",
    query(req: AgentQueryRequest): AgentQuery {
      const turn: TurnRecord = { promptOpen: true, queued: [], wake: null, ended: false };
      turns.push(turn);
      // The SDK's side of the contract: drain the prompt, and when it returns
      // (stdin closed) the conversation ends.
      void (async () => {
        for await (const _message of req.prompt as AsyncIterable<unknown>) {
          // The turn's messages; their content is irrelevant here.
        }
        turn.promptOpen = false;
        turn.ended = true;
        nudge(turn);
      })();

      return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            while (turn.queued.length > 0) yield turn.queued.shift()!;
            if (turn.ended) return;
            await new Promise<void>((resolve) => {
              turn.wake = resolve;
            });
          }
        },
        accountInfo: async () => null,
        supportedModels: async () => [],
        close: async () => {
          turn.ended = true;
          nudge(turn);
        },
      };
    },
    buildToolServer: () => ({ mock: true }),
  };

  return {
    provider,
    turns,
    /** Deliver events to the query currently running. */
    push(...events: AgentEvent[]) {
      const turn = turns[turns.length - 1];
      turn.queued = turn.queued.concat(events);
      nudge(turn);
    },
    /** Wait until the run has opened its `n`th query (a recovery opens one). */
    async waitForQuery(n: number, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (turns.length < n) {
        if (Date.now() > deadline) throw new Error(`query ${n} never opened (saw ${turns.length})`);
        await sleep(10);
      }
    },
  };
}

/** Start a run and hand back the events as they arrive, plus a finish promise. */
function startSession(provider: AgentProvider) {
  setAgentProviderForTesting(provider);
  const events: StreamEvent[] = [];
  let chatId: string | null = null;
  const finished = (async () => {
    const emitter = await sendMessage({ prompt: "do the thing", folder: workDir, triggered: true });
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("session did not finish within 15s")), 15_000);
      emitter.on("event", (e: StreamEvent) => {
        events.push(e);
        if (e.type === "chat_created") chatId = (e as { chatId?: string }).chatId ?? null;
        if (e.type === "done" || e.type === "error") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
  })();
  return { events, finished, chatIdOf: () => chatId };
}

const started = (taskId: string): AgentEvent => ({ type: "background_task", phase: "started", taskId });
const ended = (taskId: string): AgentEvent => ({ type: "background_task", phase: "ended", taskId, status: "completed" });

afterEach(() => {
  setAgentProviderForTesting(null);
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe("background-task hold — query loop wiring", () => {
  it("picks up the squeezed hold window", () => {
    // Guards every timing assertion below: if the env override stopped being
    // read, they would all silently be waiting on fifteen real minutes.
    expect(DEFAULT_MAX_HOLD_MS).toBe(HOLD_MS);
  });

  it("releases immediately when a turn ends with no background task", async () => {
    const ctrl = controllableProvider();
    const run = startSession(ctrl.provider);
    ctrl.push({ type: "session_started", sessionId: "bh-plain" }, { type: "text", content: "done" }, { type: "result", status: "success" });

    await run.finished;
    expect(ctrl.turns[0].promptOpen).toBe(false);
    expect(run.events.at(-1)!.type).toBe("done");
    expect(run.events.at(-1)!.abandonedBackgroundTaskIds).toBeUndefined();
  });

  it("holds past the turn that started a task, and releases when it ends", async () => {
    const ctrl = controllableProvider();
    const run = startSession(ctrl.provider);
    ctrl.push({ type: "session_started", sessionId: "bh-basic" }, started("t1"), { type: "result", status: "success" });

    // The turn is over; the session is not.
    await sleep(HOLD_MS / 4);
    expect(ctrl.turns[0].promptOpen).toBe(true);

    // The task reports, and the next turn boundary lets go.
    ctrl.push(ended("t1"), { type: "result", status: "success" });
    await run.finished;
    expect(ctrl.turns[0].promptOpen).toBe(false);
    expect(run.events.at(-1)!.abandonedBackgroundTaskIds).toBeUndefined();
  });

  it("keeps holding a task that starts after an expiry was deferred and the set drained (M1)", async () => {
    // The two-latch bug, end to end. A turn straddles the deadline with a task
    // outstanding so the expiry defers; that task ends mid-turn, draining the
    // set; the model starts another in the same turn. The new task's window is
    // brand new and must not be vetoed by the old episode's verdict.
    //
    // Reverting either latch reset fails this: `expiryDeferred` closes the
    // stream at markTurnEnded, `holdExpired` makes decideHold release instead
    // of hold. Neither is visible to the unit tests next door.
    const ctrl = controllableProvider();
    const run = startSession(ctrl.provider);
    ctrl.push({ type: "session_started", sessionId: "bh-m1" }, started("t1"), { type: "result", status: "success" });

    // A turn opens (the CLI working), then the deadline passes underneath it.
    ctrl.push({ type: "text", content: "still working" });
    await sleep(HOLD_MS * 1.3);
    expect(ctrl.turns[0].promptOpen).toBe(true); // deferred, not closed

    // t1 finishes and t2 starts, both inside that same turn.
    ctrl.push(ended("t1"), started("t2"), { type: "result", status: "success" });
    await sleep(HOLD_MS / 2);
    expect(ctrl.turns[0].promptOpen).toBe(true); // t2 got a real hold

    ctrl.push(ended("t2"), { type: "result", status: "success" });
    await run.finished;
    expect(run.events.at(-1)!.type).toBe("done");
    expect(run.events.at(-1)!.abandonedBackgroundTaskIds).toBeUndefined();
  });

  it("does not close the stream when the hold expires mid-turn, and closes at the boundary", async () => {
    // 87f7452's property at the seam: the expiry latches but leaves stdin
    // alone while the CLI is working, then the turn boundary releases and the
    // task that was cut short is named on the way out.
    const ctrl = controllableProvider();
    const run = startSession(ctrl.provider);
    ctrl.push({ type: "session_started", sessionId: "bh-defer" }, started("t1"), { type: "result", status: "success" });

    ctrl.push({ type: "text", content: "working" });
    await sleep(HOLD_MS * 1.3);
    expect(ctrl.turns[0].promptOpen).toBe(true);

    ctrl.push({ type: "result", status: "success" });
    await run.finished;
    expect(ctrl.turns[0].promptOpen).toBe(false);
    const done = run.events.at(-1)!;
    expect(done.type).toBe("done");
    expect(done.abandonedBackgroundTaskIds).toEqual(["t1"]);
  });

  it("closes a hold whose last task ended without a turn behind it (M2)", async () => {
    // `messageAdapter.ts` contemplates a task ending on `task_updated` alone,
    // which enqueues no prompt — so no turn opens and no `result` arrives. The
    // drain used to cancel the run's only timer, leaving nothing armed anywhere
    // and the query loop parked on a stream the hold was holding open.
    //
    // The elapsed-time bound is the other half of M2: counting a
    // `background_task` as a live turn makes this close a whole extra window
    // late, because the floor's expiry defers instead of closing.
    const ctrl = controllableProvider();
    const run = startSession(ctrl.provider);
    const startedAt = Date.now();
    ctrl.push({ type: "session_started", sessionId: "bh-m2" }, started("t1"), { type: "result", status: "success" });

    // The task reports its ending. Nothing follows it. Ever.
    await sleep(HOLD_MS / 4);
    ctrl.push(ended("t1"));

    await run.finished;
    expect(ctrl.turns[0].promptOpen).toBe(false);
    // Fixed: the floor fires one window after the drain. Counting the
    // background_task as a live turn defers it for a second window.
    expect(Date.now() - startedAt).toBeLessThan(HOLD_MS * 1.8);
  });

  it("closes a hold whose deferred expiry is waiting on a turn that never ends", async () => {
    // The other way the run can end up with liveness owed to an event that
    // never comes: the expiry landed mid-turn and handed its close to a
    // boundary, and the turn then went silent. Without the watchdog the query
    // loop parks forever and this test times out rather than failing.
    const ctrl = controllableProvider();
    const run = startSession(ctrl.provider);
    ctrl.push({ type: "session_started", sessionId: "bh-hung" }, started("t1"), { type: "result", status: "success" });
    ctrl.push({ type: "text", content: "working" }); // a turn opens...

    // ...and never says anything again. The expiry defers at one window, the
    // watchdog gives it another, and then the bound stops waiting.
    await run.finished;
    expect(ctrl.turns[0].promptOpen).toBe(false);
    expect(run.events.at(-1)!.abandonedBackgroundTaskIds).toEqual(["t1"]);
  });

  it("holds a task started after a stream recovery, even though an earlier hold expired", async () => {
    // The expiry latch is scoped to the HeldPrompt it describes, and a stream
    // recovery installs a new one with a clean deadline. Carried across, one
    // expiry poisoned the rest of the run: `decideHold` kept reading
    // `expired: true` and released every subsequent turn on arrival. The
    // production trace is a task started 47 seconds after a recovery and killed
    // 13 seconds later, having never been held at all.
    //
    // The single line under test is `holdExpired = false` in `setQueryPrompt`.
    // The HeldPrompt-side latches cannot be responsible here: the recovery
    // throws that object away and builds a fresh one.
    const ctrl = controllableProvider();
    const run = startSession(ctrl.provider);
    ctrl.push({ type: "session_started", sessionId: "bh-sa-1" }, started("t1"), { type: "result", status: "success" });

    // A turn opens and the deadline passes under it, so the expiry latches.
    ctrl.push({ type: "text", content: "working" });
    await sleep(HOLD_MS * 1.3);
    expect(ctrl.turns[0].promptOpen).toBe(true); // deferred, not closed

    // The transport dies. Two consecutive failures trip the recovery, which
    // closes this query and resumes the session with a fresh prompt.
    ctrl.push(
      { type: "tool_use", toolName: "Bash", input: {}, callId: "sa-1" },
      { type: "tool_result", callId: "sa-1", content: "Error: Stream closed", isError: true },
      { type: "tool_use", toolName: "Read", input: {}, callId: "sa-2" },
      { type: "tool_result", callId: "sa-2", content: "Error: Stream closed", isError: true },
    );
    await ctrl.waitForQuery(2);
    expect(run.events.some((e) => e.type === "auto_recovery")).toBe(true);

    // A new task on the recovered query. It must get a real hold.
    ctrl.push({ type: "session_started", sessionId: "bh-sa-2" }, started("t2"), { type: "result", status: "success" });
    await sleep(HOLD_MS / 3);
    expect(ctrl.turns[1].promptOpen).toBe(true);

    ctrl.push(ended("t1"), ended("t2"), { type: "result", status: "success" });
    await run.finished;
    expect(ctrl.turns[1].promptOpen).toBe(false);
    expect(run.events.at(-1)!.type).toBe("done");
    expect(run.events.at(-1)!.abandonedBackgroundTaskIds).toBeUndefined();
  });

  it("names tasks abandoned by a provider error, which ends the run without a `done`", async () => {
    const ctrl = controllableProvider();
    const run = startSession(ctrl.provider);
    ctrl.push(
      { type: "session_started", sessionId: "bh-err" },
      started("t1"),
      started("t2"),
      { type: "result", status: "error", reason: "the provider fell over" },
    );

    await run.finished;
    const last = run.events.at(-1)!;
    expect(last.type).toBe("error");
    expect(last.abandonedBackgroundTaskIds).toEqual(["t1", "t2"]);
    // A terminal ending beats an outstanding task — the hold must not swallow
    // the error for fifteen minutes first.
    expect(ctrl.turns[0].promptOpen).toBe(false);
  });

  it("shows the hold in the activity dock, and takes the row down with it", async () => {
    const ctrl = controllableProvider();
    const run = startSession(ctrl.provider);
    ctrl.push({ type: "session_started", sessionId: "bh-act" }, started("t1"), { type: "result", status: "success" });

    await sleep(HOLD_MS / 4);
    const chatId = run.chatIdOf()!;
    expect(chatId).toBeTruthy();
    const holding = listActivities(chatId).filter((a) => a.kind === "holding");
    expect(holding).toHaveLength(1);
    expect(holding[0].label).toBe("1 background task");
    expect(holding[0].detail).toBe("t1");
    expect(holding[0].interruptible).toBe(false);
    expect(holding[0].expiresAt).toBeGreaterThan(Date.now());

    // The row goes when the wait does — at the drain, not at the end of the
    // run. Asserted here rather than after `finished` because the run's
    // `finally` clears every activity for the chat anyway, which would hide a
    // phantom row that outlived its hold for the whole rest of the session.
    ctrl.push(ended("t1"));
    await sleep(HOLD_MS / 4);
    expect(listActivities(chatId).filter((a) => a.kind === "holding")).toHaveLength(0);

    ctrl.push({ type: "result", status: "success" });
    await run.finished;
    expect(listActivities(chatId).filter((a) => a.kind === "holding")).toHaveLength(0);
  });
});
