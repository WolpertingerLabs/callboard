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
 */
export const DEFAULT_MAX_HOLD_MS = 15 * 60_000;

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
   * @param source the messages this turn is sending, in whatever shape the
   *   caller already had them — a plain string, or the async iterable the SDK
   *   requires once MCP servers are configured.
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
   * Arm the wall-clock bound. Called when a hold begins so the cap measures the
   * wait itself, not the turn that preceded it. Re-arming replaces the previous
   * deadline, which keeps a multi-task hold bounded by one window rather than
   * one window per task.
   */
  armTimeout(ms: number, onExpiry: () => void): void {
    if (this.isReleased) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      onExpiry();
      this.close();
    }, ms);
    // A pending hold must not be the reason the daemon stays up.
    this.timer.unref?.();
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
  if (i.aborted || i.errored || i.endReason) return { action: "release", reason: "terminal" };
  if (i.expired) return { action: "release", reason: "expired" };
  if (i.outstanding <= 0) return { action: "release", reason: "none-outstanding" };
  return { action: "hold", taskCount: i.outstanding };
}
