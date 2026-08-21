/**
 * The liveness invariant, checked by exhaustion rather than by argument.
 *
 * **While a `HeldPrompt` is open and has ever been armed, a timer is pending.**
 *
 * Everything else in this design rests on that sentence. The hold deliberately
 * hands its close to events the CLI is under no obligation to emit — a turn
 * boundary that a `task_updated`-only ending never produces, a `result` from a
 * turn that has gone silent — and the pending timer is the only thing standing
 * between that and a permanently parked run: no `done`, no `session_stopped`,
 * no onComplete phone-home, no job-step harvest, subprocess pinned.
 *
 * It is checked here rather than reasoned about because the design now carries
 * three distinct timers through one slot (episode deadline, liveness floor,
 * silence watchdog) and a fourth state that cancels (`close`). Which one is
 * pending after any given sequence is not something a reader can hold in their
 * head, and the reachable state space is small enough to simply enumerate.
 *
 * The one excluded start state is a prompt that was never armed: before the
 * first `armTimeout` nothing is holding anything open, which is what every
 * session that uses no background tasks does, and what the code did before the
 * hold existed.
 */
import { describe, expect, it, vi } from "vitest";
import { HeldPrompt } from "./background-task-hold.js";

const WINDOW = 60_000;

/** Every operation the query loop can perform, plus the passage of time. */
const OPERATIONS = {
  arm: (h: HeldPrompt, onExpiry: () => void) => h.armTimeout(WINDOW, onExpiry),
  disarm: (h: HeldPrompt) => h.disarmTimeout(),
  turnActive: (h: HeldPrompt) => h.markTurnActive(),
  turnEnded: (h: HeldPrompt) => h.markTurnEnded(),
  // Long enough to fire whatever is pending, since every timer this class
  // schedules is exactly one window.
  elapse: () => vi.advanceTimersByTime(WINDOW + 1),
  // A partial advance, so a sequence can land between a timer being set and it
  // coming due — where most of the interesting state lives.
  tick: () => vi.advanceTimersByTime(WINDOW / 3),
} as const;

type OpName = keyof typeof OPERATIONS;
const OP_NAMES = Object.keys(OPERATIONS) as OpName[];

/**
 * How many timers Node currently has queued.
 *
 * Read off the fake-timer clock rather than the object, on purpose: asking
 * `HeldPrompt` whether it thinks it has a timer would let a bug in its own
 * bookkeeping answer the question the test is asking.
 *
 * The count is process-global, which is why every sequence starts by clearing
 * it (see {@link check}). Without that, a timer left behind by an earlier
 * sequence's abandoned prompt counts towards this one and a genuine
 * `!closed && nothing pending` state reads as healthy. The first draft of this
 * file had exactly that hole: a depth-6 run reported up to 11 timers pending
 * for a class that never has more than one.
 */
const pendingTimers = () => vi.getTimerCount();

interface Violation {
  sequence: OpName[];
  timers: number;
}

/** Run one sequence from a freshly armed prompt, checking after every step. */
function check(sequence: readonly OpName[]): Violation | null {
  // Isolation, and load-bearing: see `pendingTimers`.
  vi.clearAllTimers();
  const held = new HeldPrompt("hello");
  const onExpiry = () => {};
  held.armTimeout(WINDOW, onExpiry);
  if (pendingTimers() !== 1) throw new Error(`fixture broken: armed prompt has ${pendingTimers()} timers, expected exactly 1`);

  const done: OpName[] = [];
  for (const name of sequence) {
    if (name === "elapse" || name === "tick") OPERATIONS[name]();
    else if (name === "arm") OPERATIONS.arm(held, onExpiry);
    else OPERATIONS[name](held);
    done.push(name);

    if (!held.closed && pendingTimers() === 0) return { sequence: [...done], timers: 0 };
    // One slot, one timer. `schedule()` is the only scheduler and always
    // replaces, so more than one pending means a path bypassed it — which
    // would make "is anything pending?" ambiguous and this search unsound.
    if (pendingTimers() > 1) return { sequence: [...done], timers: pendingTimers() };
  }
  return null;
}

/** Every sequence of `OP_NAMES` up to `depth`, shortest first. */
function* sequences(depth: number): Generator<OpName[]> {
  let frontier: OpName[][] = [[]];
  for (let d = 0; d < depth; d++) {
    const next: OpName[][] = [];
    for (const prefix of frontier) {
      for (const op of OP_NAMES) {
        const seq = [...prefix, op];
        next.push(seq);
        yield seq;
      }
    }
    frontier = next;
  }
}

describe("HeldPrompt — while open, a timer is always pending", () => {
  it("holds across every operation sequence to depth 6", () => {
    vi.useFakeTimers();
    try {
      let checked = 0;
      const violations: Violation[] = [];
      for (const sequence of sequences(6)) {
        checked++;
        const violation = check(sequence);
        if (violation) violations.push(violation);
      }

      // 6 + 6^2 + ... + 6^6. Asserted so a generator that quietly stopped
      // enumerating cannot pass as a clean search.
      expect(checked).toBe(55_986);
      // Sliced first, so a failure prints counterexamples rather than a
      // five-figure diff nobody can read.
      expect(violations.slice(0, 5)).toEqual([]);
      expect(violations).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the one start state the invariant excludes", () => {
    // A prompt that has never been armed is open with nothing pending, and
    // that is correct rather than a hole: nothing is holding it open. Stated
    // here so the exclusion is a decision on the record and not a gap the
    // search quietly steps around — and so the checker's own predicate is seen
    // to fire on a state that genuinely has no timer.
    vi.useFakeTimers();
    try {
      const held = new HeldPrompt("hello");
      expect(held.closed).toBe(false);
      expect(pendingTimers()).toBe(0);

      // Anti-vacuity is established outside the suite, by reverting each timer
      // path in turn and re-running: removing the liveness floor or the
      // silence watchdog both make the search above fail with concrete
      // counterexample sequences. See the commit message.
      held.armTimeout(WINDOW, () => {});
      expect(pendingTimers()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
