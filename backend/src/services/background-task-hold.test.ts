/**
 * Background-task hold.
 *
 * Two things are worth testing here and they fail in opposite directions:
 *
 * - `decideHold` deciding to hold when it should have released pins a live CLI
 *   subprocess. Every hard-termination path is covered explicitly, because each
 *   one is a case where the pre-hold code ended the session and must still.
 * - `HeldPrompt` failing to release *hangs the session*. It is released from
 *   four places (normal end, timeout, abort, the run's `finally`), so the
 *   tests below lean on idempotency and on the released-before-iteration order
 *   that the abort path actually produces. The timeout is the subtle one: it
 *   closes when the hold is idle and defers to the turn boundary when it is
 *   not, so both halves are covered — a deferral that never settled would be
 *   a leak, and an idle expiry that deferred would be no bound at all.
 */
import { describe, it, expect, vi } from "vitest";
import { decideHold, HeldPrompt, OutstandingTasks, MAX_TRACKED_TASKS, MAX_HOLD_EPISODES, createHoldEpisodeBudget } from "./background-task-hold.js";

/** Drain an async iterable to an array, with a timeout so a hang fails loudly. */
async function drain(iterable: AsyncIterable<unknown>, timeoutMs = 1000): Promise<unknown[]> {
  const collected: unknown[] = [];
  const run = (async () => {
    for await (const item of iterable) collected.push(item);
  })();
  const timedOut = Symbol("timeout");
  const outcome = await Promise.race([run.then(() => "done"), new Promise((r) => setTimeout(() => r(timedOut), timeoutMs))]);
  if (outcome === timedOut) throw new Error(`iterable did not finish within ${timeoutMs}ms — the hold never released`);
  return collected;
}

const base = { outstanding: 0, aborted: false, errored: false, endReason: undefined, expired: false };

describe("decideHold", () => {
  it("holds when tasks are outstanding and nothing terminal happened", () => {
    expect(decideHold({ ...base, outstanding: 2 })).toEqual({ action: "hold", taskCount: 2 });
  });

  it("releases when nothing is outstanding", () => {
    expect(decideHold(base)).toEqual({ action: "release", reason: "none-outstanding" });
  });

  // Each of these ended the session before the hold existed and must still.
  // A user who pressed stop is not asking to wait out a benchmark, and a run
  // that hit max_turns has no turn left to receive the notification in.
  it.each([
    ["abort", { aborted: true }],
    ["provider error", { errored: true }],
    ["a hard cap", { endReason: "max_turns" }],
  ])("releases on %s even with tasks outstanding", (_label, overrides) => {
    expect(decideHold({ ...base, outstanding: 3, ...overrides })).toEqual({ action: "release", reason: "terminal" });
  });

  it("releases once the wall-clock bound has elapsed", () => {
    expect(decideHold({ ...base, outstanding: 1, expired: true })).toEqual({ action: "release", reason: "expired" });
  });

  it("treats a negative outstanding count as nothing to wait for", () => {
    // Defensive: an `end` for a task whose `start` was never seen must not be
    // able to drive the counter below zero into a permanent hold.
    expect(decideHold({ ...base, outstanding: -1 })).toEqual({ action: "release", reason: "none-outstanding" });
  });
});

describe("OutstandingTasks", () => {
  it("counts a task from start to end", () => {
    const tasks = new OutstandingTasks();
    tasks.start("a");
    tasks.start("b");
    expect(tasks.size).toBe(2);
    tasks.end("a");
    expect(tasks.size).toBe(1);
    expect(tasks.ids()).toEqual(["b"]);
  });

  it("ignores an end for a task it never saw start", () => {
    // Real: a task started before a stream recovery re-created the query.
    const tasks = new OutstandingTasks();
    tasks.end("ghost");
    expect(tasks.size).toBe(0);
  });

  it("does not resurrect a task when its ending is reported twice", () => {
    // task_notification and task_updated both report the same ending, and the
    // adapter forwards both on purpose.
    const tasks = new OutstandingTasks();
    tasks.start("a");
    tasks.end("a");
    tasks.end("a");
    expect(tasks.size).toBe(0);
  });

  it("does not re-add a task that already ended", () => {
    const tasks = new OutstandingTasks();
    tasks.start("a");
    tasks.end("a");
    tasks.start("a");
    expect(tasks.size).toBe(0);
  });

  it("ignores a duplicate start", () => {
    const tasks = new OutstandingTasks();
    tasks.start("a");
    tasks.start("a");
    expect(tasks.size).toBe(1);
  });

  it("stops tracking past the cap", () => {
    const tasks = new OutstandingTasks();
    for (let i = 0; i < MAX_TRACKED_TASKS + 10; i++) tasks.start(`t${i}`);
    expect(tasks.size).toBe(MAX_TRACKED_TASKS);
  });
});

describe("HeldPrompt", () => {
  it("yields its messages then stays open until closed", async () => {
    const held = new HeldPrompt(
      (async function* () {
        yield { type: "user", message: { role: "user", content: "hi" } };
      })(),
    );

    const seen: unknown[] = [];
    let finished = false;
    const run = (async () => {
      for await (const item of held.iterable()) seen.push(item);
      finished = true;
    })();

    // Let the generator run as far as it can — which is up to the hold.
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(1);
    expect(finished).toBe(false);

    held.close();
    await run;
    expect(finished).toBe(true);
  });

  it("wraps a plain string prompt as a user message", async () => {
    const held = new HeldPrompt("just a string");
    held.close();
    expect(await drain(held.iterable())).toEqual([{ type: "user", message: { role: "user", content: "just a string" } }]);
  });

  it("is closeable before iteration ever starts", async () => {
    // The abort path: the signal fires while the query is still being built,
    // so `close()` lands before anything reads the iterable.
    const held = new HeldPrompt("hello");
    held.close();
    expect(held.closed).toBe(true);
    await expect(drain(held.iterable())).resolves.toHaveLength(1);
  });

  it("is idempotent — every exit path closes it", async () => {
    const held = new HeldPrompt("hello");
    held.close();
    held.close();
    held.close();
    await expect(drain(held.iterable())).resolves.toHaveLength(1);
  });

  it("releases itself when the armed timeout expires between turns", async () => {
    // The ordinary case: the turn ended, the hold is parked waiting on a
    // notification that never comes. Nothing else will close it, so the timer
    // must — deferring here would leave the bound with nothing to bite on.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      const onExpiry = vi.fn();
      held.armTimeout(60_000, onExpiry);
      expect(held.closed).toBe(false);

      vi.advanceTimersByTime(60_000);
      expect(onExpiry).toHaveBeenCalledOnce();
      expect(held.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not close the stream when the timeout expires mid-turn", async () => {
    // Closing stdin under a live turn is what produced the "Stream closed"
    // tool failures and the transport-recovery cycles in production. The latch
    // still fires immediately — the caller needs it to decide at the boundary.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      const onExpiry = vi.fn();
      held.markTurnActive();
      held.armTimeout(60_000, onExpiry);

      vi.advanceTimersByTime(60_000);
      expect(onExpiry).toHaveBeenCalledOnce();
      expect(held.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a deferred expiry at the next turn boundary", async () => {
    // The backstop half: the turn boundary normally closes via decideHold's
    // `expired` release, but the bound is owned here so a caller that forgets
    // cannot leak a held stream.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      held.markTurnActive();
      held.armTimeout(60_000, vi.fn());
      vi.advanceTimersByTime(60_000);
      expect(held.closed).toBe(false);

      held.markTurnEnded();
      expect(held.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an unexpired hold open across a turn boundary", () => {
    // markTurnEnded runs at every turn boundary, held or not. Only a deferred
    // expiry may make it close.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      held.markTurnActive();
      held.armTimeout(60_000, vi.fn());
      held.markTurnEnded();
      expect(held.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire an armed timeout after an early close", async () => {
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      const onExpiry = vi.fn();
      held.armTimeout(60_000, onExpiry);
      held.close();

      vi.advanceTimersByTime(120_000);
      expect(onExpiry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("measures its deadline from the first arm of an unbroken hold, not the latest", () => {
    // `armTimeout` runs at every held turn boundary, and each delivered
    // notification opens another turn. If re-arming restarted the window, a
    // task reporting periodically could extend the cap forever — the exact
    // runaway the bound exists to stop. Armed at t=0 for 60s and re-armed at
    // t=30s with the hold never having broken, it must still fire at t=60s,
    // not t=90s. A single `tail -f` gets one window, however many turns it
    // spans.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      const onExpiry = vi.fn();
      held.armTimeout(60_000, onExpiry);
      vi.advanceTimersByTime(30_000);
      held.armTimeout(60_000, onExpiry);

      vi.advanceTimersByTime(29_999);
      expect(onExpiry).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(onExpiry).toHaveBeenCalledOnce();
      expect(held.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives the next hold episode a full window once the task set has emptied", () => {
    // The other half of the invariant above. `disarmTimeout` is called only
    // when the outstanding count reaches zero — the work finished — so the
    // next task is not made to serve out the remainder of a dead task's
    // budget.
    //
    // The gap between drain and re-arm is deliberately NONZERO. Draining and
    // re-arming in the same instant is the one moment where the liveness
    // floor's deadline and a freshly-minted one coincide, so a version that
    // handed the floor's remaining time to the new episode passed it too:
    // drained at t=30s and re-armed at t=45s, the old code gave the episode 45
    // seconds, not 60. Armed at t=0, drained at t=30s, re-armed at t=45s, it
    // must fire at t=105s.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      const onExpiry = vi.fn();
      held.armTimeout(60_000, onExpiry);
      vi.advanceTimersByTime(30_000);
      held.disarmTimeout();
      vi.advanceTimersByTime(15_000); // a notification turn does some work
      held.armTimeout(60_000, onExpiry);
      expect(held.deadline! - Date.now()).toBe(60_000);

      vi.advanceTimersByTime(59_999);
      expect(onExpiry).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(onExpiry).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a full window to an episode that starts after the floor has already come due", () => {
    // The sharper form, and the one that cost a whole hold rather than part of
    // one. `npm test &` finishes at minute two, so the floor is set for minute
    // seventeen; the model keeps working and starts `npm run build &` at minute
    // twenty. The floor came due mid-turn — but all that proves is that the run
    // is alive, so it must not have latched anything on its way past.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      const onExpiry = vi.fn();
      held.markTurnActive();
      held.armTimeout(60_000, onExpiry);
      held.disarmTimeout(); // drained; floor due at t=60s

      // The turn works on, well past the floor, saying so as it goes.
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(30_000);
        held.markTurnActive();
      }
      expect(onExpiry).not.toHaveBeenCalled();
      expect(held.closed).toBe(false);

      // A new task, and a real hold for it.
      held.armTimeout(60_000, onExpiry);
      expect(held.deadline! - Date.now()).toBe(60_000);
      held.markTurnEnded();
      expect(held.closed).toBe(false);

      vi.advanceTimersByTime(59_999);
      expect(held.closed).toBe(false);
      vi.advanceTimersByTime(2);
      expect(onExpiry).toHaveBeenCalledOnce();
      expect(held.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still closes a drained hold when the turn the floor found alive goes silent", () => {
    // The floor declining to latch must not cost liveness. It swaps its clock
    // for a watchdog on the last sign of life, so silence still ends the run.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      held.markTurnActive();
      held.armTimeout(60_000, vi.fn());
      held.disarmTimeout();

      vi.advanceTimersByTime(60_000); // floor comes due, turn looks alive
      expect(held.closed).toBe(false);
      vi.advanceTimersByTime(59_999); // ...and then says nothing more
      expect(held.closed).toBe(false);
      vi.advanceTimersByTime(2);
      expect(held.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not push the floor out on a repeated drain", () => {
    // claude.ts calls disarmTimeout on every ending task once the set is empty,
    // and both `task_notification` and `task_updated` report the same ending.
    // Re-minting the floor each time would let a chatty CLI extend it forever.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      held.armTimeout(60_000, vi.fn());
      held.disarmTimeout();
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(10_000);
        held.disarmTimeout();
      }
      expect(held.closed).toBe(false);
      vi.advanceTimersByTime(10_001); // t=60.001s, one window from the first drain
      expect(held.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire a drained hold's expiry on the dead episode's clock", () => {
    // The 10:27 line in the production trace: the last task ended, nothing
    // cancelled the timer, and it fired 32 seconds later naming an empty list.
    //
    // The invariant is about *which* clock, not about there being none — a
    // drain re-arms a full window as the liveness floor, so the second half
    // asserts the floor still fires. Without it a run whose last task reported
    // only `task_updated` has no timer anywhere and hangs forever.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      const onExpiry = vi.fn();
      held.armTimeout(60_000, onExpiry); // episode deadline: t=60s
      vi.advanceTimersByTime(30_000);
      held.disarmTimeout(); // drained at t=30s → fresh floor at t=90s

      vi.advanceTimersByTime(30_001); // t=60.001s, past the dead episode's deadline
      expect(onExpiry).not.toHaveBeenCalled();
      expect(held.closed).toBe(false);

      vi.advanceTimersByTime(30_000); // t=90s, the floor
      expect(onExpiry).toHaveBeenCalledOnce();
      expect(held.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a hold whose turn never ends, rather than waiting on it forever", () => {
    // M2's hang. A deferred expiry hands the close to the turn boundary, but
    // the CLI is not obliged to produce one: a task that ends reporting only
    // `task_updated` enqueues no prompt, so no turn opens and no `result`
    // arrives (see messageAdapter.ts). The watchdog is what keeps that from
    // parking the run forever with nothing armed anywhere in it.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      held.markTurnActive();
      held.armTimeout(60_000, vi.fn());
      vi.advanceTimersByTime(60_000); // expiry defers — the turn looks alive
      expect(held.closed).toBe(false);

      vi.advanceTimersByTime(59_999); // silence, and no boundary
      expect(held.closed).toBe(false);
      vi.advanceTimersByTime(2);
      expect(held.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a deferred expiry a fresh reprieve for as long as the turn keeps working", () => {
    // Silence is the signal, not elapsed time. A turn still emitting events is
    // doing something, and cutting stdin under one is the damage the deferral
    // exists to avoid — so the watchdog restarts on every sign of life.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      held.markTurnActive();
      held.armTimeout(60_000, vi.fn());
      vi.advanceTimersByTime(60_000); // deferred

      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(50_000);
        held.markTurnActive(); // still working
      }
      expect(held.closed).toBe(false);

      held.markTurnEnded(); // the boundary finally arrives
      expect(held.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a deferred expiry when the task set drains, so the next episode is not vetoed on arrival", () => {
    // The two-latch bug. Making the *budget* per-episode reset `deadlineAt`,
    // but an expiry that fired mid-turn also left `expiryDeferred` set — and
    // that alone says "close at the next boundary". So the new episode opened
    // with a full window and was killed the instant the turn ended.
    //
    // Reachable, not theoretical: a turn straddles the deadline with a task
    // outstanding (expiry defers), that task ends mid-turn (drain to zero),
    // the model starts another, and the boundary kills the new one.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      const onExpiry = vi.fn();
      held.markTurnActive();
      held.armTimeout(60_000, onExpiry);
      vi.advanceTimersByTime(60_000);
      expect(held.closed).toBe(false); // deferred, as designed

      held.disarmTimeout(); // the task set drained to zero, mid-turn
      held.armTimeout(60_000, onExpiry); // a new task, a new window
      expect(held.deadline).not.toBeNull();

      held.markTurnEnded();
      expect(held.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops granting fresh windows once a run has opened too many episodes", () => {
    // Per-episode budgeting with unlimited episodes is not a bound. `sleep
    // 300 &` → ends → notification turn → `sleep 300 &` is a shape a polling
    // agent falls into naturally, and each round would mint a fresh window
    // forever. Pre-PR the whole run was capped; this is what restores that.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      const onExpiry = vi.fn();

      // Each round: hold, wait a little, drain. Well inside every window.
      for (let i = 0; i < MAX_HOLD_EPISODES; i++) {
        held.armTimeout(60_000, onExpiry);
        vi.advanceTimersByTime(1_000);
        expect(held.closed).toBe(false);
        held.disarmTimeout();
      }
      expect(onExpiry).not.toHaveBeenCalled();

      // One episode too many: refused outright rather than granted a window.
      held.armTimeout(60_000, onExpiry);
      expect(onExpiry).toHaveBeenCalledOnce();
      expect(held.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("spends one run allowance across every prompt the run installs", () => {
    // A run does not have one HeldPrompt: a nudge and a stream recovery each
    // install a replacement, up to seven in a run. A count living on the object
    // was therefore a per-prompt cap wearing a per-run cap's name — seven
    // allowances of twenty, or thirty-five hours of holding against a
    // documented five.
    vi.useFakeTimers();
    try {
      const budget = createHoldEpisodeBudget();
      const onExpiry = vi.fn();

      // The first prompt burns the whole allowance, one episode at a time.
      const first = new HeldPrompt("hello", budget);
      for (let i = 0; i < MAX_HOLD_EPISODES; i++) {
        first.armTimeout(60_000, onExpiry);
        vi.advanceTimersByTime(1_000);
        first.disarmTimeout();
      }
      expect(onExpiry).not.toHaveBeenCalled();
      first.close();

      // A recovery installs a replacement, which inherits the spent allowance
      // rather than a fresh one.
      const second = new HeldPrompt("hello", budget);
      second.armTimeout(60_000, onExpiry);
      expect(onExpiry).toHaveBeenCalledOnce();
      expect(second.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts episodes, not turn boundaries — a long hold is still one episode", () => {
    // `armTimeout` runs at every held turn boundary, and a task reporting
    // progress can produce many. Counting those would refuse a hold that has
    // never once drained, which is the opposite of what the cap is for.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      const onExpiry = vi.fn();
      for (let i = 0; i < MAX_HOLD_EPISODES * 3; i++) {
        held.armTimeout(600_000, onExpiry);
        vi.advanceTimersByTime(1_000);
      }
      expect(onExpiry).not.toHaveBeenCalled();
      expect(held.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not count the post-drain floor as an episode", () => {
    // The floor re-arms `deadlineAt`, so inferring "new episode" from a null
    // deadline would both count the floor and then miss the real episode after
    // it — burning the budget at twice the rate on one path and not at all on
    // the other.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      const onExpiry = vi.fn();
      held.armTimeout(60_000, onExpiry);
      for (let i = 0; i < MAX_HOLD_EPISODES - 1; i++) {
        held.disarmTimeout(); // floor armed
        vi.advanceTimersByTime(1_000);
        held.armTimeout(60_000, onExpiry); // real episode, inherits the floor's deadline
      }
      expect(onExpiry).not.toHaveBeenCalled();
      expect(held.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tolerates a disarm with nothing armed", () => {
    // Every ending task calls it, including one whose hold was never armed
    // because the turn it started in has not ended yet.
    const held = new HeldPrompt("hello");
    expect(() => held.disarmTimeout()).not.toThrow();
    expect(held.closed).toBe(false);
  });


  it("ignores an arm request after close", () => {
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      held.close();
      const onExpiry = vi.fn();
      held.armTimeout(60_000, onExpiry);
      vi.advanceTimersByTime(120_000);
      expect(onExpiry).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("OutstandingTasks.end — reporting the transition", () => {
  it("reports true only for the call that actually ended the task", () => {
    // Both task_notification and task_updated carry the same ending; the
    // caller logs on the transition so the log does not say it ended twice.
    const tasks = new OutstandingTasks();
    tasks.start("a");
    expect(tasks.end("a")).toBe(true);
    expect(tasks.end("a")).toBe(false);
  });

  it("reports false for a task it never saw start", () => {
    expect(new OutstandingTasks().end("ghost")).toBe(false);
  });
});

describe("decideHold — a dead transport is not worth waiting on", () => {
  it("releases when a stream recovery is pending, even with tasks outstanding", () => {
    // The transport is about to be stopped and resumed, so nothing can be
    // delivered over it. The query loop breaks out immediately afterwards and
    // would close the hold anyway; deciding it here keeps the invariant local
    // rather than dependent on an unconditional `break` far below.
    expect(decideHold({ ...base, outstanding: 2, streamRecoveryNeeded: true })).toEqual({ action: "release", reason: "terminal" });
  });

  it("still holds when no recovery is pending", () => {
    expect(decideHold({ ...base, outstanding: 2, streamRecoveryNeeded: false })).toEqual({ action: "hold", taskCount: 2 });
  });
});
