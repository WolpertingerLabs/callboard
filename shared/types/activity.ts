/**
 * Chat activity — what a chat is currently doing that takes time.
 *
 * Callboard agents call tools that block the turn (`wait`, `talk_to_agent`,
 * `continue_chat` with `waitForCompletion`) or kick off work that outlives it.
 * None of that was observable: a chat sitting inside a 300-second `wait`
 * rendered identically to a finished one. An activity is the server-side
 * record that makes the difference visible.
 *
 * These types cross the REST boundary (`GET /chats/:id/activity`, and the
 * board rollup), NOT the SSE wire in `stream.ts`. That is deliberate — see
 * the transport note on the route handler. Adding a field here is safe for
 * the same reason it is safe on any REST payload: an older client ignores
 * keys it does not know.
 */

/**
 * What kind of thing the chat is waiting on. `wait` is the only kind the user
 * may end early — everything else is the agent waiting on work it delegated,
 * where returning without the result would hand the agent a confusing empty
 * response while the delegate kept running.
 *
 * `holding` is the background-task hold (`background-task-hold.ts`): the turn
 * is over but the session is deliberately kept alive so a Bash command started
 * with `run_in_background` can finish and report. It was the third way a chat
 * could legitimately be busy and the only one with nothing on screen — a chat
 * patiently holding a subprocess open rendered as idle and finished.
 *
 * ## Adding a kind
 *
 * Unlike a `StreamEvent` `type`, this is not gated behind a client capability,
 * and the reason is the transport: activities cross REST, where a client asks
 * and the server answers — there is no negotiated session to gate on, and the
 * wire-surface snapshot (`stream.ts` / `protocol.ts`) does not cover this file.
 * The hazard an old client faces is therefore not "drops the event" but "looks
 * this kind up in a map and renders nothing", so the obligation lands on the
 * consumer instead: anything keying a lookup on {@link ActivityKind} must fall
 * back for a kind it has never heard of. See `ActivityDock.tsx`.
 *
 * Be honest about what that buys and when. A fallback protects clients built
 * *after* it — it cannot protect the ones a new kind is actually new to, since
 * those are running a bundle that predates the fallback itself. When `holding`
 * shipped, every tab already open rendered `· undefined` beside the row. That
 * was judged acceptable rather than mitigated: the damage is one wrong word in
 * a status line, on a row whose label, countdown and detail all still read
 * correctly, and it self-heals on the next reload. The fallback earns its place
 * for the kind after this one, not this one.
 *
 * If a future kind ever carries more than a verb — a control, a different
 * layout, an interruptible affordance — that calculus changes and it wants a
 * real gate, which means moving the payload onto the SSE wire where one exists.
 */
export type ActivityKind = "wait" | "await_chat" | "await_agent" | "generating" | "scanning" | "holding";

/** The condition attached to a polling `wait`, denormalized onto the activity. */
export interface ActivityCondition {
  text: string;
  attempt: number;
  maxAttempts: number;
}

export interface ChatActivity {
  id: string;
  chatId: string;
  kind: ActivityKind;
  /** Display label — `wait`'s `flavor`, or the target alias for an agent call. */
  label: string;
  /** Secondary line — `wait`'s `reason`. */
  detail?: string;
  /** Epoch ms. */
  startedAt: number;
  /**
   * Epoch ms, when a deadline is known (a `wait`'s duration, a call's safety
   * timeout). The client derives its countdown from this rather than being
   * pushed ticks, so a stale tab re-renders correctly the moment it refetches.
   */
  expiresAt?: number;
  /** Whether {@link ActivityKind} allows the user to end this early. */
  interruptible: boolean;
  /** Deep-link target for `await_chat` / `await_agent`. */
  childChatId?: string;
  condition?: ActivityCondition;
}

/**
 * A condition watch — the durable half of `wait(require_condition)`.
 *
 * A single `wait` call is one tick of a polling loop; the watch is what spans
 * the wait → check → wait cycle, so the UI shows one persistent "waiting for
 * CI to finish, attempt 3" rather than three unrelated timers. Keyed by chat:
 * a chat polls for one condition at a time, and naming a different condition
 * supersedes the previous watch.
 */
export interface ConditionWatch {
  id: string;
  chatId: string;
  /** What the agent said it is waiting for, verbatim. */
  text: string;
  /** How many `wait` cycles this condition has consumed. */
  attempts: number;
  maxAttempts: number;
  /** Epoch ms of the first `wait` that opened this watch. */
  firstStartedAt: number;
  /** Epoch ms of the most recent cycle. */
  lastCheckedAt?: number;
  /**
   * Set once the attempt cap is spent. The record is kept rather than deleted
   * so re-naming the same condition cannot mint a fresh budget — the cap has
   * to survive the agent ignoring it, or it is not a cap. An exhausted watch
   * is not an open obligation, so it does not nudge; naming a *different*
   * condition supersedes it as normal.
   */
  exhausted?: boolean;
}

/** Response shape of `GET /chats/:id/activity`. */
export interface ChatActivityResponse {
  activities: ChatActivity[];
  conditionWatch: ConditionWatch | null;
  /**
   * Outstanding `onComplete` callbacks this chat is the parent of — spawned or
   * continued sessions it expects to hear back from. Persisted in
   * `session-callbacks.json`, so this survives a daemon restart.
   */
  awaitingChildren: number;
}
