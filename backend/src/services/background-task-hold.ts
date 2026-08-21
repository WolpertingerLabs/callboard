/**
 * Background-task hold — keeping a session alive while work it started outlives
 * the turn that started it.
 *
 * ## The problem
 *
 * A Bash tool called with `run_in_background: true` returns immediately with a
 * handle ("Command running in background with ID: b1c0oxnsp"), so the model is
 * free to end its turn straight away — and routinely does. The completion is
 * *not* delivered as a `tool_result`. The CLI enqueues a `<task-notification>`
 * as a fresh prompt and answers it in a new turn.
 *
 * That works only while the CLI subprocess is alive. It is alive only while the
 * SDK's streaming input stays open, and callboard closed that input the moment
 * it had yielded the user's message. So the shell was killed mid-flight, the
 * notification was left in the queue, and the next resume of that session
 * opened with "N background shell command task(s) from the previous session
 * have no completion record".
 *
 * Measured, not assumed: with the input closed, a 45-second background `sleep`
 * never wrote its marker file. With the input held open, the same command
 * completed and the CLI delivered its own follow-up turn ~19s later with no
 * prompting from us.
 *
 * ## The fix
 *
 * Hold the input stream open past the turn's `result` for as long as tasks are
 * outstanding. We send nothing — the CLI already knows how to notify itself, so
 * the hold is pure patience, not a poll. When the last task ends, release; the
 * input generator returns, stdin closes, and the stream ends normally (~0.3s).
 *
 * ## Why the bounds are not optional
 *
 * A held session pins a live CLI subprocess. `sleep infinity` in the background
 * would pin one forever, so every hold is bounded by wall-clock and every exit
 * path — release, timeout, abort, error — must release the stream exactly once.
 * {@link HeldPrompt} owns that guarantee so the query loop cannot forget it.
 *
 * Two rules refine that bound, and both are about *when* it is safe to act on:
 * the budget is per hold episode rather than per run (see
 * {@link HeldPrompt.disarmTimeout}), and an expiry that lands mid-turn waits
 * for the turn to end rather than closing stdin under it (see
 * {@link HeldPrompt.armTimeout}). Neither loosens the bound; they only stop it
 * firing at a moment when firing does damage.
 */
import { createLogger } from "../utils/logger.js";

const log = createLogger("bg-task-hold");

/**
 * How long a session may be held open waiting on background tasks.
 *
 * Chosen to cover the cases the hold exists for — a test suite, a build, a long
 * benchmark — without letting a runaway `tail -f` pin a subprocess for a
 * working day. A task still running at the cap is not killed; we simply stop
 * waiting, and it dies with the subprocess exactly as it did before this
 * existed. The failure mode of the cap is therefore the old behaviour, which is
 * the right thing for a bound to degrade into.
 *
 * ## The case this bound is *not* free in
 *
 * Some backgrounded work never finishes by design. This repo's own
 * `.claude/CLAUDE.md` tells agents to start the dev server with
 * `run_in_background: true`, and a server emits no terminal status ever — so
 * the hold runs the full window every time, and the `done` event, the
 * `session_stopped` that drives onComplete phone-home, and the job runner's
 * step harvest all wait behind it. A job step whose `timeoutMinutes` is
 * shorter than this window can time out while its session is merely being
 * patient.
 *
 * That is a policy cost, not a defect — the hold cannot tell a build it should
 * wait for from a server it shouldn't, because nothing in the task's shape
 * distinguishes them until one of them ends. It is tunable rather than
 * hard-coded for exactly that reason: a deployment that leans on long
 * background builds wants this high, one that mostly runs dev servers wants it
 * low, and neither should need a release to say so.
 */
const HOLD_MS_ENV = "CALLBOARD_MAX_BACKGROUND_HOLD_MS";

function resolveMaxHoldMs(): number {
  const raw = process.env[HOLD_MS_ENV];
  if (!raw) return 15 * 60_000;
  const parsed = Number(raw);
  // A malformed override falls back rather than throwing: this value bounds a
  // wait, and a daemon that refuses to boot over it would be a worse failure
  // than one that waits the default.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    log.warn(`Ignoring ${HOLD_MS_ENV}="${raw}" — not a positive number of milliseconds`);
    return 15 * 60_000;
  }
  return parsed;
}

export const DEFAULT_MAX_HOLD_MS = resolveMaxHoldMs();

/**
 * Most tasks one session will be held for. A session that has somehow accrued
 * more has almost certainly lost track of them, and waiting on the pile serves
 * nobody; the cap is a tripwire for that, not a resource limit.
 */
export const MAX_TRACKED_TASKS = 50;

/**
 * The set of background tasks a session is currently waiting on.
 *
 * Deliberately a plain set of ids with no lifecycle of its own: the CLI owns
 * the tasks, we only count them. `end()` on an id we never saw start is a
 * normal event, not an error — a task can be started by a turn that ran before
 * a stream recovery re-created the query.
 */
export class OutstandingTasks {
  private readonly live = new Set<string>();
  /** Ids already ended, so a duplicate ending is not mistaken for a new task. */
  private readonly done = new Set<string>();
  private startedCount = 0;

  start(taskId: string): void {
    if (this.done.has(taskId) || this.live.has(taskId)) return;
    if (this.startedCount >= MAX_TRACKED_TASKS) {
      log.warn(`Refusing to track background task ${taskId} — already tracking ${MAX_TRACKED_TASKS} in this session`);
      return;
    }
    this.startedCount++;
    this.live.add(taskId);
  }

  /**
   * @returns whether this call is what ended the task, so a caller can log the
   *   transition rather than every report of it. Both `task_notification` and
   *   `task_updated` carry the same ending and both are forwarded on purpose —
   *   without this the log says a task ended twice.
   */
  end(taskId: string): boolean {
    this.done.add(taskId);
    return this.live.delete(taskId);
  }

  get size(): number {
    return this.live.size;
  }

  ids(): string[] {
    return [...this.live];
  }
}

/**
 * A streaming-input prompt that yields its messages and then stays open until
 * released.
 *
 * The SDK keeps the CLI subprocess alive for exactly as long as this iterable
 * has not returned, which is the entire mechanism — see the file header.
 * `release()` is idempotent and safe to call before iteration ever starts, so
 * the query loop can call it unconditionally in a `finally`.
 */
export class HeldPrompt {
  private release!: () => void;
  private readonly released: Promise<void>;
  private isReleased = false;
  private timer: NodeJS.Timeout | null = null;
  /**
   * Absolute expiry of the current hold episode, fixed by the `armTimeout` that
   * opened it and never extended. Cleared by {@link disarmTimeout} when the
   * episode ends, so the next one starts a fresh window — see the two methods
   * for why that is the whole of the rule.
   */
  private deadlineAt: number | null = null;
  /**
   * Whether a turn is running on this stream right now, as reported by the
   * query loop. The hold is only safe to close between turns — see
   * {@link armTimeout}.
   */
  private turnActive = false;
  /** An expiry that fired mid-turn, waiting on the boundary to close. */
  private expiryDeferred = false;

  /**
   * @param source the messages this turn is sending, in whatever shape the
   *   caller already had them — a plain string, or the async iterable the SDK
   *   requires once MCP servers are configured.
   *
   * A string is converted to an iterable rather than passed through, and that
   * conversion is load-bearing, not tidiness: a string prompt puts the SDK in
   * single-user-turn mode, where it closes stdin at the first `result`
   * regardless of what this class does. Handing the SDK a string would defeat
   * the hold entirely and silently — the session would end exactly as it did
   * before, with no error to explain why.
   */
  constructor(private readonly source: AsyncIterable<unknown> | string) {
    this.released = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  /** The value handed to the SDK as `prompt`. */
  iterable(): AsyncIterable<unknown> {
    // Captured up front rather than read off `this` inside the generator: both
    // are immutable for this object's lifetime, and closing over the values
    // keeps the generator independent of how it ends up being invoked.
    const { source, released } = this;
    return (async function* () {
      if (typeof source === "string") {
        yield { type: "user" as const, message: { role: "user" as const, content: source } };
      } else {
        yield* source;
      }
      // Everything the caller had to say has been said. Staying here — rather
      // than returning, as an ordinary prompt generator would — is what keeps
      // the CLI subprocess, and so any background shell it owns, alive.
      await released;
    })();
  }

  /**
   * Close the input. Ends the SDK stream shortly after. Idempotent — the query
   * loop releases on the normal path, and again in its `finally`.
   */
  close(): void {
    if (this.isReleased) return;
    this.isReleased = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.release();
  }

  get closed(): boolean {
    return this.isReleased;
  }

  /**
   * Arm the wall-clock bound, measured from the *first* arm of the current
   * hold episode.
   *
   * Called at every held turn boundary, not once — each delivered notification
   * opens a new turn that can itself end still holding. So the deadline is
   * stored absolutely and later calls only re-hang a timer against the time
   * already on the clock. Re-arming from `ms` each time would have made the cap
   * "15 minutes since the last turn ended", which a task that reports
   * periodically could extend indefinitely — the exact runaway the bound exists
   * to stop.
   *
   * The budget is per *episode*, not per run: what resets it is
   * {@link disarmTimeout}, and the only thing that calls that is the task set
   * genuinely emptying. So one `tail -f` gets one window and no more, however
   * many turns it spans, while a session that starts a task, finishes it, and
   * later starts another gets a full window for the second — because between
   * them the work it was being patient for actually completed.
   *
   * ## What expiry does, and when
   *
   * Expiry always runs `onExpiry` — the caller's latch, which makes the next
   * turn boundary release. What it does about the *stream* depends on whether
   * a turn is in flight, and the distinction is not cosmetic:
   *
   * - **Idle** (the usual case: the turn ended, we are parked waiting on a
   *   notification that never came) — close immediately. Nothing else will:
   *   there is no next turn boundary to defer to, and a deferral here would
   *   turn the bound into no bound at all, which is the `sleep infinity`
   *   runaway it exists to stop.
   * - **Mid-turn** — latch and wait for {@link markTurnEnded}. Closing here
   *   pulls stdin out from under a live turn, and the CLI reports that as
   *   tools failing: production saw `Tool permission request failed:
   *   AbortError: Stream closed`, then the transport-failure recovery cycle,
   *   from a timer that fired while the session was working.
   *
   * The release-exactly-once guarantee is unchanged. The mid-turn path defers
   * to a boundary that always arrives — the turn either produces a `result`,
   * or ends the stream, or throws — and the run's `finally` closes the hold
   * unconditionally behind all three.
   */
  armTimeout(ms: number, onExpiry: () => void): void {
    if (this.isReleased) return;
    if (this.deadlineAt === null) this.deadlineAt = Date.now() + ms;
    if (this.timer) clearTimeout(this.timer);

    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) {
      this.timer = null;
      this.expire(onExpiry);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.expire(onExpiry);
    }, remaining);
    // A pending hold must not be the reason the daemon stays up.
    this.timer.unref?.();
  }

  private expire(onExpiry: () => void): void {
    onExpiry();
    if (this.turnActive) {
      this.expiryDeferred = true;
      return;
    }
    this.close();
  }

  /**
   * Report that the CLI is working — anything the query loop sees other than
   * the `result` that ends a turn.
   */
  markTurnActive(): void {
    this.turnActive = true;
  }

  /**
   * Report that a turn has ended, and settle any expiry that fired during it.
   *
   * Called after the turn boundary has had its say, so the ordinary path
   * (`decideHold` seeing `expired` and releasing with a reason logged) is what
   * normally closes the stream and this is only the backstop. It exists so the
   * bound is owned here rather than by a caller that could forget it.
   */
  markTurnEnded(): void {
    this.turnActive = false;
    if (this.expiryDeferred) this.close();
  }

  /**
   * End the current hold episode without closing the stream: cancel the armed
   * timer and clear the deadline, so a later {@link armTimeout} starts a fresh
   * window.
   *
   * Called when the outstanding task count drops to zero. At that moment there
   * is nothing left to be patient for, so a timer that keeps running can only
   * do harm — it fires on an empty task set, at whatever the session has since
   * gone on to do. The production trace was a session that polled with
   * successive background sleeps: each one inherited what was left of the first
   * one's fifteen minutes, and the last was killed 84 seconds short of
   * finishing, under a log line naming an empty list of tasks.
   *
   * Deliberately not `close()`: draining to zero is not the end of the run.
   * The turn boundary decides that — `decideHold` sees `outstanding: 0` and
   * releases there, on the one path that also ends the activity and reports
   * the reason.
   */
  disarmTimeout(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.deadlineAt = null;
  }
}

export interface HoldInputs {
  /** Background tasks still running when the turn's stream ended. */
  outstanding: number;
  /** The user cancelled the run. */
  aborted: boolean;
  /** The provider reported an error. */
  errored: boolean;
  /** A hard cap already ended the run (max_turns / max_budget / …). */
  endReason?: string | undefined;
  /** The hold's wall-clock bound has already elapsed. */
  expired: boolean;
  /**
   * The transport died and the run is about to be stopped and resumed.
   *
   * Passed in even though the query loop breaks out immediately afterwards and
   * would close the hold anyway. The point is to make the invariant local: a
   * dead transport delivers nothing, so arming a fifteen-minute wait on one is
   * never right, and this function should not need a reader to go and check an
   * unconditional `break` three hundred lines away to know that it doesn't.
   */
  streamRecoveryNeeded?: boolean;
}

export type HoldDecision = { action: "hold"; taskCount: number } | { action: "release"; reason: "none-outstanding" | "terminal" | "expired" };

/**
 * Decide whether a turn that just ended should be held open.
 *
 * Pure, so the interesting combinations can be tested without standing up a
 * provider — the same reason `decideNudge` lives apart from the query loop it
 * serves.
 *
 * Every hard termination beats an outstanding task. A user who pressed stop is
 * not asking to wait 15 more minutes for a benchmark, and a session that hit
 * max_turns has no turn left to receive the notification in even if it arrived.
 * Releasing here is what the code did before the hold existed, so these paths
 * are unchanged rather than newly special-cased.
 */
export function decideHold(i: HoldInputs): HoldDecision {
  if (i.aborted || i.errored || i.endReason || i.streamRecoveryNeeded) return { action: "release", reason: "terminal" };
  if (i.expired) return { action: "release", reason: "expired" };
  if (i.outstanding <= 0) return { action: "release", reason: "none-outstanding" };
  return { action: "hold", taskCount: i.outstanding };
}
