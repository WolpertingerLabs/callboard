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
 *   that the abort path actually produces.
 */
import { describe, it, expect, vi } from "vitest";
import { decideHold, HeldPrompt, OutstandingTasks, MAX_TRACKED_TASKS } from "./background-task-hold.js";

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

  it("releases itself when the armed timeout expires", async () => {
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
    // budget. Armed at t=0, disarmed at t=30s, re-armed at t=30s: it must fire
    // at t=90s, a full 60s later.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      const onExpiry = vi.fn();
      held.armTimeout(60_000, onExpiry);
      vi.advanceTimersByTime(30_000);
      held.disarmTimeout();
      held.armTimeout(60_000, onExpiry);

      vi.advanceTimersByTime(59_999);
      expect(onExpiry).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(onExpiry).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire an expiry for a hold that already drained", () => {
    // The 10:27 line in the production trace: the last task ended, nothing
    // cancelled the timer, and it fired 32 seconds later naming an empty list.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      const onExpiry = vi.fn();
      held.armTimeout(60_000, onExpiry);
      held.disarmTimeout();

      vi.advanceTimersByTime(600_000);
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
