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
 */
export type ActivityKind = "wait" | "await_chat" | "await_agent" | "generating" | "scanning";

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
