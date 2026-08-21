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
 * would pin one forever, so holding is bounded and every exit path — release,
 * timeout, abort, error — must release the stream exactly once.
 * {@link HeldPrompt} owns those guarantees so the query loop cannot forget
 * them.
 *
 * There are **two** bounds, and it takes both to make a bound at all:
 *
 * 1. {@link DEFAULT_MAX_HOLD_MS} caps one *episode* — one contiguous stretch of
 *    waiting. It is measured absolutely from the episode's first arm, so a task
 *    that reports periodically cannot extend it, and it resets only when the
 *    task set genuinely empties.
 * 2. {@link MAX_HOLD_EPISODES} caps how many times that reset may happen. A
 *    per-episode budget with unlimited episodes is not a bound: a run that
 *    alternates background `sleep` and notification turn would mint a fresh
 *    window forever, which is precisely the shape a polling agent falls into.
 *
 * Together they bound a run at `MAX_HOLD_EPISODES × DEFAULT_MAX_HOLD_MS` of
 * holding, and both degrade into the pre-hold behaviour: we stop waiting, and
 * tasks still running die with the subprocess.
 *
 * Two rules refine *when* a bound may act, without loosening it: an expiry that
 * lands mid-turn waits for the turn to end rather than closing stdin under it,
 * and a drained episode hands its timer slot to a separate liveness floor
 * rather than merely stopping (see {@link HeldPrompt.armTimeout} and
 * {@link HeldPrompt.disarmTimeout}). The floor is not a budget and keeps its
 * own clock, so it can never be spent as one episode's window by the next.
 *
 * Both refinements are safe for the same reason, and it is the load-bearing
 * property of this file: **while a hold is open, a timer is always pending.**
 * Deferring an expiry keeps a watchdog; draining an episode re-arms rather
 * than cancels. Neither ever hands liveness to an event the CLI is under no
 * obligation to emit, because it does not always emit one — a task can end
 * reporting only `task_updated`, which enqueues no prompt, opens no turn, and
 * produces no `result` to be waiting for.
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
 * Separate hold episodes one run may open. The second of this file's two
 * bounds, and the reason the first one is safe to reset.
 *
 * {@link DEFAULT_MAX_HOLD_MS} bounds a single stretch of waiting, and that
 * budget resets whenever the task set empties — which is right, because the
 * work it was being patient for actually finished. But "resets" with nothing
 * counting the resets is not a bound at all: `sleep 300 &` → ends → the CLI's
 * notification opens a turn → `sleep 300 &` again is a shape a polling agent
 * falls into naturally, and each round would mint a fresh window forever. Once
 * a run has done that this many times it is not making progress it needs a
 * held subprocess for.
 *
 * The two together bound a run at `MAX_HOLD_EPISODES × DEFAULT_MAX_HOLD_MS` of
 * holding — loose on purpose, since the point is to catch a runaway rather
 * than to ration legitimate work. Hitting it degrades into the pre-hold
 * behaviour exactly as the wall-clock cap does: we stop waiting, and tasks
 * still running die with the subprocess.
 *
 * Not tunable, unlike the window. The window encodes a policy about how long
 * *your* background work takes and deployments genuinely differ; this encodes
 * "something has gone wrong", and a deployment that needs it raised has a
 * different problem.
 */
export const MAX_HOLD_EPISODES = 20;

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
   *
   * Strictly the *episode's* clock. The liveness floor keeps its own
   * ({@link floorAt}) precisely so it cannot be mistaken for one: they answer
   * different questions and share nothing but a timer slot.
   */
  private deadlineAt: number | null = null;
  /**
   * Absolute expiry of the liveness floor — the anti-hang timer a drain leaves
   * behind. Null when no floor is pending.
   *
   * Separate from {@link deadlineAt} and not an alias for it. A shared field
   * made the floor's remaining time double as the *next episode's* budget, so
   * a session that drained and then worked for a while before starting another
   * task gave that task the remainder rather than a window: drain at t=30s,
   * a notification turn that runs 45s, and the new task arms with 15 seconds
   * instead of 60. Worse when the gap exceeds a window — the floor has fired
   * by then, and the new task got no hold at all. Since a fresh window per
   * episode is the whole of what the per-episode budget promises, that was the
   * promise being quietly withdrawn.
   */
  private floorAt: number | null = null;
  /**
   * Whether a turn is running on this stream right now, as reported by the
   * query loop. The hold is only safe to close between turns — see
   * {@link armTimeout}.
   */
  private turnActive = false;
  /** An episode expiry that fired mid-turn, waiting on the boundary to close. */
  private expiryDeferred = false;
  /**
   * A liveness floor that fired while a turn was running, and is now watching
   * for silence instead.
   *
   * Deliberately *not* `expiryDeferred`. A floor firing mid-turn has learned
   * only that the run is alive — which is the opposite of the hang it exists to
   * catch — so it declares nothing, latches nothing, and does not close at the
   * next boundary. Conflating the two is what let a floor set an hour earlier
   * kill the next task's hold before it began.
   */
  private floorWatchdog = false;
  /**
   * The window and callback of the most recent {@link armTimeout}, retained so
   * the bound can re-arm itself without the query loop being asked again.
   *
   * This is what makes "a timer is always pending while the hold is open" a
   * property of this class rather than a habit of its caller — see
   * {@link disarmTimeout}.
   */
  private lastArm: { ms: number; onExpiry: () => void } | null = null;
  /**
   * Whether the hold is inside an episode right now — armed for tasks that are
   * actually outstanding, as opposed to merely carrying the post-drain floor.
   *
   * Tracked explicitly rather than inferred from `deadlineAt`, which the floor
   * also sets: inferring would have counted the floor as an episode and, worse,
   * skipped counting the real episode that followed it.
   */
  private inEpisode = false;
  /** Episodes opened so far, against {@link MAX_HOLD_EPISODES}. */
  private episodes = 0;

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
   * Epoch ms the current hold *episode* expires, or null when no episode is
   * armed.
   *
   * Exposed so the UI can show the same deadline the bound is enforcing — the
   * dock counts down from it — rather than the caller re-deriving it from
   * `Date.now() + DEFAULT_MAX_HOLD_MS` and quietly disagreeing with the timer
   * on every turn after the first.
   *
   * Never reports the liveness floor. The dock's row exists for as long as the
   * session is waiting on a task, and a floor means it is waiting on nothing.
   */
  get deadline(): number | null {
    return this.deadlineAt;
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
   * The release-exactly-once guarantee is unchanged, and neither is liveness:
   * the mid-turn path defers to a boundary, but does not *trust* one to
   * arrive. A deferred expiry keeps a watchdog running, so a turn that stops
   * producing events entirely is closed rather than waited on forever. See
   * {@link disarmTimeout} for the standing invariant both halves serve.
   */
  armTimeout(ms: number, onExpiry: () => void): void {
    if (this.isReleased) return;
    this.lastArm = { ms, onExpiry };

    // A new stretch of waiting, as opposed to another turn boundary inside the
    // one already running. The per-episode budget is what makes counting these
    // necessary: without a cap on the resets, a run that alternates task and
    // notification mints a fresh window forever. See MAX_HOLD_EPISODES.
    if (!this.inEpisode) {
      this.inEpisode = true;
      this.episodes++;
      if (this.episodes > MAX_HOLD_EPISODES) {
        log.warn(`Refusing a ${this.episodes}th background-task hold in one run — the run has stopped making progress it needs a held subprocess for`);
        this.schedule(null);
        this.expire(onExpiry);
        return;
      }
      // An episode supersedes the floor outright: from here the episode's own
      // clock is the bound, and the floor has nothing left to guard. Clearing
      // both is what makes the next line mint rather than inherit.
      this.floorAt = null;
      this.floorWatchdog = false;
    }

    if (this.deadlineAt === null) this.deadlineAt = Date.now() + ms;

    const remaining = this.deadlineAt - Date.now();
    if (remaining <= 0) {
      this.schedule(null);
      this.expire(onExpiry);
      return;
    }
    this.schedule(remaining, () => this.expire(onExpiry));
  }

  /**
   * Replace whatever is pending. `delayMs === null` just cancels.
   *
   * Everything this class schedules goes through here and shares the one timer
   * slot, so "is anything pending?" has a single answer and cannot drift
   * between the episode deadline, the deferral watchdog, and the post-drain
   * floor.
   */
  private schedule(delayMs: number | null, fire?: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (delayMs === null || !fire) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      fire();
    }, delayMs);
    // A pending hold must not be the reason the daemon stays up.
    this.timer.unref?.();
  }

  private expire(onExpiry: () => void): void {
    onExpiry();
    if (!this.turnActive) {
      this.close();
      return;
    }
    // Mid-turn: hand the close to the boundary, but keep a watchdog running so
    // liveness does not depend on a `result` the CLI is under no obligation to
    // send. Measured from the last sign of life rather than from here — see
    // {@link markTurnActive} — because a turn that is still emitting events is
    // working, and cutting stdin under one is the damage the deferral exists
    // to avoid.
    //
    // What actually bounds this: the watchdog slides on every event, so a turn
    // that keeps working keeps its reprieve indefinitely — and that is correct,
    // because a *working* turn is what is pinning the subprocess, not the hold.
    // The turn itself is bounded elsewhere. `maxTurns` and `max_budget` both
    // terminate the query with a `result`, which lands on `markTurnEnded()` and
    // closes. So the bound here is "one query's worth of turns", and silence —
    // the one failure the turn's own bounds cannot catch — costs a window.
    this.expiryDeferred = true;
    this.armSilenceWatchdog();
  }

  /**
   * The liveness floor came due.
   *
   * Nothing like an expiry, despite sharing a timer slot with one. The floor
   * asks a single question — "is this run parked with nothing left to wait
   * for?" — and a live turn answers no. So it declares nothing in that case:
   * no `onExpiry`, no latch, no close at the boundary. It keeps watching for
   * the silence that would mean a real hang, and the next episode wipes it.
   *
   * Latching here is what made a `npm test &` that finished at minute two kill
   * an `npm run build &` started at minute twenty — the floor came due at
   * minute seventeen, mid-turn, and poisoned an episode that had not begun.
   */
  private expireFloor(onExpiry: () => void): void {
    this.floorAt = null;
    if (this.turnActive) {
      this.floorWatchdog = true;
      this.armSilenceWatchdog();
      return;
    }
    // Idle, with nothing outstanding and no turn boundary in a whole window.
    // Nothing is coming; this is the hang the floor exists for.
    onExpiry();
    this.close();
  }

  /**
   * Arm (or restart) the watchdog that closes on silence.
   *
   * Shared by the two states that are waiting on something the CLI may never
   * do — a deferred expiry waiting for a boundary, and a floor waiting to see
   * whether a live turn is really live. Both want the same thing: patience
   * while events keep arriving, and a close when they stop.
   */
  private armSilenceWatchdog(): void {
    const ms = this.lastArm?.ms;
    if (ms === undefined) return;
    this.schedule(ms, () => this.close());
  }

  /**
   * Report that the CLI is working — anything the query loop sees other than
   * the `result` that ends a turn, and other than `background_task`, which by
   * construction arrives while the hold is *idle*.
   */
  markTurnActive(): void {
    this.turnActive = true;
    // Every event is proof the turn is alive, so anything waiting on silence
    // starts its count again from here. A turn that keeps working keeps its
    // reprieve; a turn that has gone quiet runs out of one.
    if (this.expiryDeferred || this.floorWatchdog) this.armSilenceWatchdog();
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
    // A floor watchdog deliberately survives the boundary rather than closing
    // at it. The boundary itself settles the question — `decideHold` releases
    // with nothing outstanding, or holds and opens an episode that wipes the
    // floor — and both cancel this. It stays pending only if the caller does
    // neither, which is the case it is here to cover.
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
   *
   * ## Everything the old episode decided has to go, not just its clock
   *
   * The deadline is one of *two* pieces of state an expiry leaves behind, and
   * clearing only that one buys nothing: `expiryDeferred` still says "the
   * moment this turn ends, close", so a fresh window opens and is vetoed on
   * the spot. (The caller's own latch is the third — see the `holdExpired`
   * reset beside the call site in `claude.ts`. All three are needed; any one
   * left set kills the new episode by itself.)
   *
   * That is reachable, not theoretical: a turn straddles the deadline with a
   * task outstanding so the expiry defers, the task ends mid-turn, the model
   * starts another, and at the boundary the new task's brand-new window closes
   * immediately and its shell dies.
   *
   * ## The invariant: while the hold is open, something is always pending
   *
   * "Disarm" names the old episode's clock, not the bound. Cancelling outright
   * would leave the run with no timer anywhere in it, and the assumption that
   * covers for that — the turn boundary will close us — is exactly the
   * assumption the CLI does not honour. `messageAdapter.ts` says so in as many
   * words: a task can end reporting only `task_updated`, which enqueues no
   * prompt, so no turn opens and no `result` ever arrives. The `for await`
   * then parks on a stream this object is holding open, and the run hangs
   * permanently — no `done`, no `session_stopped`, no onComplete phone-home,
   * no job-step harvest, registry entry never released, subprocess pinned.
   * Before the per-episode change the absolute timer would have closed it.
   *
   * So a drain leaves a *floor* pending instead of clearing. If a boundary
   * arrives — the overwhelmingly common case — `decideHold` releases and
   * `close()` cancels this on the way out, so it never fires. If none does,
   * the run still ends, one window late, exactly as it did before the hold
   * existed.
   *
   * The floor keeps its own clock ({@link floorAt}) and its own expiry
   * ({@link expireFloor}). It has to: it is not a budget, and anything that
   * treats it as one takes the next episode's window away. That is the whole
   * of why `deadlineAt` is left null here.
   *
   * A second drain with a floor already pending leaves it alone rather than
   * pushing it out — the floor measures "how long since anything happened",
   * and re-minting it on every duplicate task-ending event would let a chatty
   * CLI extend it without bound.
   */
  disarmTimeout(): void {
    this.deadlineAt = null;
    this.expiryDeferred = false;
    // The episode is over; the next arm opens a new one, is counted, and mints
    // its own window rather than serving out what is left of this floor.
    this.inEpisode = false;
    if (this.isReleased || !this.lastArm) {
      this.schedule(null);
      return;
    }
    if (this.floorAt !== null || this.floorWatchdog) return;
    const { ms, onExpiry } = this.lastArm;
    this.floorAt = Date.now() + ms;
    this.schedule(ms, () => this.expireFloor(onExpiry));
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
