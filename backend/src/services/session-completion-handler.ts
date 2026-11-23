/**
 * Session Completion Handler — the "phone home" delivery engine.
 *
 * Subscribes once to the global session registry. Whenever ANY session reaches a
 * terminal state (the registry emits `session_stopped` from the sendMessage
 * `finally` block, covering success, max_turns, max_budget, abort, and error),
 * this handler:
 *
 *   1. Marks any callbacks waiting on that session (as a child) "ready".
 *   2. Attempts delivery to every parent that has ready callbacks and is now idle.
 *      A stopped session is itself a candidate parent — this is how a callback
 *      that was deferred while the parent was busy gets delivered once the parent
 *      finishes its own turn.
 *
 * Delivery re-invokes the parent as a fresh turn with a lightweight notification;
 * the parent reads the child transcript itself. If the parent chat was deleted
 * and it was an agent, a brand-new agent chat is spawned to pick up instead.
 *
 * Chat notices (chat-notices.ts) ride the same path: a notice is due as soon
 * as it is queued, so a chat with one is a delivery candidate exactly like a
 * parent with a ready callback, and both go out in one turn when they meet.
 *
 * Dependencies (sendMessage, getActiveSession) are injected from claude.ts to
 * avoid a circular import, mirroring the setMessageSender pattern used elsewhere.
 */
import type { EventEmitter } from "events";
import { sessionRegistry, type SessionEvent } from "./session-registry.js";
import { findChat } from "../utils/chat-lookup.js";
import { executeAgent } from "./agent-executor.js";
import {
  type CallbackKind,
  markChildComplete,
  getReadyForParent,
  removeCallbacks,
  parentsWithReadyCallbacks,
  setChatDepth,
  clearChatDepth,
} from "./session-callbacks.js";
import { chatsWithNotices, dropChatNotices, peekChatNotices, recordNoticeDeliveryFailure, removeChatNotices, setChatNoticeWakeup } from "./chat-notices.js";
import { isChatArchived } from "./chat-archived.js";
import { createLogger } from "../utils/logger.js";
import type { SendMessageOptions } from "./claude.js";
import { toPromptIterable } from "./session-spawn.js";

const log = createLogger("session-completion");

// The real options type, imported type-only: a value import would close the
// cycle this indirection exists to break (the emitted JS has no import).
type MessageSender = (opts: SendMessageOptions) => Promise<EventEmitter>;

type ActiveSessionLookup = (chatId: string) => unknown | undefined;

/**
 * Work that runs first when a chat goes idle, before its completion callbacks:
 * held messages ("Enqueue Send"). Resolves true when it started a turn on
 * the chat — the callbacks then wait for that turn to end, exactly as they
 * wait for any other turn.
 */
export type IdleDeliveryHook = (chatId: string) => Promise<boolean>;

let _sendMessage: MessageSender | null = null;
let _getActiveSession: ActiveSessionLookup | null = null;
let _initialized = false;
let _idleHook: IdleDeliveryHook | null = null;

/** Parents currently being delivered to — guards against concurrent double-delivery. */
const delivering = new Set<string>();

/**
 * Chats whose idle handling was skipped because the guard above was held —
 * a stop (or abandoned start) that arrived mid-delivery. Without this the
 * wakeup is simply lost: a held turn that fails within microtasks of
 * registering, or a child finishing while a held delivery is being refused,
 * would leave the next held message and any ready callbacks waiting for some
 * unrelated session to stop. {@link releaseGuard} replays it.
 */
const missedWhileGuarded = new Set<string>();

/**
 * Chats whose guard is currently held by a replay. A wakeup missed during a
 * replay is not replayed again — see {@link releaseGuard}.
 */
const guardHeldByReplay = new Set<string>();

/**
 * Chats with a *held-messages-only* miss: an abandoned start met the guard.
 * Replaying full idle handling for it is what looped (the callback send fails
 * again, forever), but dropping it outright strands a held message accepted
 * while that failing start had the chat reading as "starting" — the hold
 * route took it as running, and no stop will ever come for it. So on release
 * only the idle hook is replayed, never `tryDeliver`. That cannot loop: a
 * held delivery that fails marks its item failed and pauses what is queued
 * behind it, so the next replay finds nothing to claim — and the replay cap
 * below applies to it too.
 */
const heldOnlyMissWhileGuarded = new Set<string>();

/**
 * Why idle handling is running, which decides what a held guard means:
 *  - `event` — a session stopped. Arriving while the guard is held, it is a
 *    real missed wakeup and is recorded for replay.
 *  - `abandoned` — a start failed before registering. Arriving while the
 *    guard is held, it is almost always the guard holder's *own* start
 *    failing (tryDeliver's `sendMessage`, or a held delivery's): replaying
 *    full idle handling for it would retry the same failing callback send
 *    forever, in microtasks — the event loop never gets a turn. Ready
 *    callbacks stay ready and retry on the next stop instead; only a
 *    held-messages-only miss is recorded ({@link heldOnlyMissWhileGuarded}).
 *  - `replay` — a recorded miss being replayed.
 */
type IdleOrigin = "event" | "abandoned" | "replay";

/** Take the per-chat guard, or (for a real missed wakeup) note it and refuse. */
function takeGuard(chatId: string, origin: IdleOrigin): boolean {
  if (delivering.has(chatId)) {
    if (origin === "abandoned") heldOnlyMissWhileGuarded.add(chatId);
    else missedWhileGuarded.add(chatId);
    return false;
  }
  delivering.add(chatId);
  if (origin === "replay") guardHeldByReplay.add(chatId);
  return true;
}

/**
 * Release the guard and replay a wakeup that arrived while it was held.
 *
 * At most one replay per release: a miss recorded while a *replay* held the
 * guard is dropped (with a warning) rather than replayed again, so no chain
 * of replays can sustain itself — it falls back to "retry on the next stop",
 * which is what every miss was before replays existed. The replay is also
 * deferred with `setImmediate`, so even a regression here yields to I/O and
 * timers instead of freezing the daemon in a microtask loop.
 *
 * The cap's accepted cost: two *consecutive* held deliveries that both fail
 * within microtasks of registering (A's stop replayed, the replay delivers B,
 * B's stop lands during the replay and is dropped) leave the next held
 * message `queued` on an idle chat until Resume or the chat's next stop. It
 * needs two instant failures back to back; the trade is a bounded stall
 * against an unbounded loop.
 */
function releaseGuard(chatId: string): void {
  delivering.delete(chatId);
  const heldByReplay = guardHeldByReplay.delete(chatId);
  const full = missedWhileGuarded.delete(chatId);
  const heldOnly = heldOnlyMissWhileGuarded.delete(chatId);
  if (!full && !heldOnly) return;
  if (heldByReplay) {
    log.warn(`Idle wakeup for ${chatId} missed during a replay — not replaying again; it retries on the next stop`);
    return;
  }
  setImmediate(() => {
    const replay = full ? handleChatIdle(chatId, "replay") : runIdleHook(chatId, "replay");
    void replay.catch((err) => {
      log.error(`Replayed idle handling for ${chatId} failed: ${err?.message ?? err}`);
    });
  });
}

/**
 * Install the idle hook (held-message delivery). Registered from server
 * bootstrap rather than claude.ts: the dispatcher reaches `sendMessage`
 * through chat-turn.ts, which imports claude.js, so claude.ts registering it
 * would close an import cycle.
 */
export function setIdleDeliveryHook(fn: IdleDeliveryHook | null): void {
  _idleHook = fn;
}

/** Busy for the purposes of idle-triggered delivery: running, or a turn on its way. */
function isBusy(chatId: string): boolean {
  return sessionRegistry.isStarting(chatId) || Boolean(_getActiveSession && _getActiveSession(chatId));
}

/**
 * Wire up the global completion listener. Safe to call once; subsequent calls
 * only refresh the injected dependencies.
 */
export function initSessionCompletionHandler(deps: { sendMessage: MessageSender; getActiveSession: ActiveSessionLookup }): void {
  _sendMessage = deps.sendMessage;
  _getActiveSession = deps.getActiveSession;

  if (_initialized) return;
  _initialized = true;

  // A notice queued on an idle chat is due now; on a busy one, the stop below
  // picks it up. Through handleChatIdle so held messages keep going first.
  setChatNoticeWakeup((chatId) => handleChatIdle(chatId));

  sessionRegistry.on("change", (event: SessionEvent) => {
    if (event.event !== "session_stopped") return;
    // Fire-and-forget; never let a delivery failure crash the registry emit.
    void handleSessionStopped(event.chatId).catch((err) => {
      log.error(`Completion handling for ${event.chatId} failed: ${err?.message ?? err}`);
    });
  });

  // A start that failed before registering: the stop it superseded fired
  // while the chat read as "starting", so anything that stop deferred is due.
  sessionRegistry.on("start_abandoned", (chatId: string) => {
    void handleChatIdle(chatId, "abandoned").catch((err) => {
      log.error(`Idle handling for ${chatId} after an abandoned start failed: ${err?.message ?? err}`);
    });
  });

  log.info("Session completion handler initialized");
}

async function handleSessionStopped(stoppedChatId: string): Promise<void> {
  // 1. Promote callbacks waiting on this (child) session to "ready".
  markChildComplete(stoppedChatId);

  // 2. Re-attempt delivery for every parent that has ready callbacks, plus the
  //    stopped chat itself (it may be a parent that just freed up). tryDeliver
  //    no-ops when a parent is still busy or has nothing ready.
  //    The stopped chat's held messages go first: a message the user held for
  //    "when this turn ends" is theirs to have answered next, and if one
  //    starts a turn, the callbacks wait for that turn's stop like any other.
  const startedHeld = await runIdleHook(stoppedChatId, "event");
  const candidates = new Set<string>([...parentsWithReadyCallbacks(), ...chatsWithNotices()]);
  if (startedHeld) candidates.delete(stoppedChatId);
  else candidates.add(stoppedChatId);

  for (const parentChatId of candidates) {
    await tryDeliver(parentChatId, "event");
  }
}

/**
 * Idle handling for one chat that went idle without (or after) a session
 * stopping: an abandoned start, a replayed wakeup, or the user resuming held
 * messages. Held messages first, then completion callbacks — the same order
 * and the same guard as a stop. Resolves true when a held message started a
 * turn. Exported for `POST /chats/:id/held/resume` (origin `event`: the
 * user asking is as real a wakeup as a stop).
 */
export async function handleChatIdle(chatId: string, origin: IdleOrigin = "event"): Promise<boolean> {
  if (await runIdleHook(chatId, origin)) return true;
  await tryDeliver(chatId, origin);
  return false;
}

/**
 * Run the idle hook for `chatId`, under the same per-chat guard as callback
 * delivery so the two can never both start a turn on one chat. Never throws.
 */
async function runIdleHook(chatId: string, origin: IdleOrigin): Promise<boolean> {
  if (!_idleHook) return false;
  if (isBusy(chatId) || !takeGuard(chatId, origin)) return false;
  try {
    return await _idleHook(chatId);
  } catch (err: unknown) {
    log.error(`Idle delivery for ${chatId} failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    releaseGuard(chatId);
  }
}

async function tryDeliver(parentChatId: string, origin: IdleOrigin): Promise<void> {
  if (delivering.has(parentChatId)) {
    takeGuard(parentChatId, origin); // held: records the miss, or not, by origin
    return;
  }

  const ready = getReadyForParent(parentChatId);
  let notices = peekChatNotices(parentChatId);
  // Sending into an archived chat un-archives it (sendMessage reopens the
  // tree). A completion callback is the agent's own delegated work and keeps
  // that behaviour; a notice is the daemon's, so it is dropped instead.
  if (notices.length && isChatArchived(parentChatId)) {
    log.info(`Chat ${parentChatId} is archived — dropping ${dropChatNotices(parentChatId)} undelivered notice(s) rather than reopening it`);
    notices = [];
  }
  if (ready.length === 0 && notices.length === 0) return;

  // Parent is mid-turn, or a turn is on its way (a superseding send, a held
  // message being started) — defer. It will be retried when the parent (or
  // any session) next stops.
  if (isBusy(parentChatId)) return;

  if (!takeGuard(parentChatId, origin)) return;
  try {
    const ids = ready.map((c) => c.id);
    const childChatIds = ready.map((c) => c.childChatId);
    const depth = ready.length ? Math.max(...ready.map((c) => c.depth)) : 0;
    const callbackPrompt = ready.length
      ? buildNotification(
          childChatIds,
          ready.map((c) => c.kind ?? "spawned"),
        )
      : "";
    const noticeIds = notices.map((n) => n.id);

    const parentChat = findChat(parentChatId, false);

    if (parentChat) {
      // Normal path: resume the existing parent chat as a fresh turn.
      const prompt = [callbackPrompt, ...notices.map((n) => n.text)].filter(Boolean).join("\n\n---\n\n");
      await _sendMessage!({ chatId: parentChatId, prompt: toPromptIterable(prompt), maxTurns: 200 });
      if (ready.length) setChatDepth(parentChatId, depth);
      removeCallbacks(ids);
      removeChatNotices(parentChatId, noticeIds);
      log.info(`Delivered ${ids.length} completion(s) and ${noticeIds.length} notice(s) to chat ${parentChatId}${ready.length ? ` (depth ${depth})` : ""}`);
      return;
    }

    // A notice describes this chat's own state (its computer-control
    // session, its open approvals), which went with the chat.
    if (noticeIds.length) log.warn(`Chat ${parentChatId} was deleted — dropping ${dropChatNotices(parentChatId)} undelivered notice(s)`);
    if (ready.length === 0) return;
    const prompt = callbackPrompt;

    // Parent chat was deleted. If it was an agent, spawn a fresh agent chat to
    // pick up where the deleted parent left off.
    const agentAlias = ready.find((c) => c.parentAgentAlias)?.parentAgentAlias;
    if (agentAlias) {
      const result = await executeAgent({
        agentAlias,
        prompt,
        triggeredBy: "tool",
        metadata: { phoneHome: true, originalParentChatId: parentChatId, childChatIds },
        maxTurns: 200,
      });
      if (result) {
        setChatDepth(result.chatId, depth);
        log.info(`Parent chat ${parentChatId} was deleted — spawned fresh agent chat ${result.chatId} for "${agentAlias}"`);
      } else {
        log.warn(`Parent chat ${parentChatId} deleted; failed to spawn replacement agent chat for "${agentAlias}"`);
      }
      removeCallbacks(ids);
      clearChatDepth(parentChatId);
      return;
    }

    // Deleted, non-agent parent — nothing to revive.
    log.warn(`Parent chat ${parentChatId} was deleted and is not an agent — dropping ${ids.length} callback(s)`);
    removeCallbacks(ids);
    clearChatDepth(parentChatId);
  } catch (err: any) {
    // Leave callbacks in "ready" (and notices queued) so they retry on a
    // future session stop — notices only up to their attempt cap.
    log.error(`Delivery to parent ${parentChatId} failed: ${err.message}`);
    if (notices.length)
      recordNoticeDeliveryFailure(
        parentChatId,
        notices.map((n) => n.id),
      );
  } finally {
    releaseGuard(parentChatId);
  }
}

function buildNotification(childChatIds: string[], kinds: CallbackKind[]): string {
  const list = childChatIds.map((id) => `"${id}"`).join(", ");
  // A batch can mix the two — the parent spawned one child and sent a follow-up
  // to another, and both finished while it was busy. Only claim what is true.
  const uniform = kinds.every((k) => k === kinds[0]) ? kinds[0] : undefined;
  const one = uniform === "continued" ? "A session you sent a follow-up to" : uniform === "spawned" ? "A session you spawned" : "A session you are waiting on";
  const many = uniform === "continued" ? "sessions you sent follow-ups to" : uniform === "spawned" ? "sessions you spawned" : "sessions you are waiting on";
  const header = childChatIds.length === 1 ? `🔔 ${one} has completed: ${list}.` : `🔔 ${childChatIds.length} ${many} have completed: ${list}.`;
  return [
    header,
    "",
    "Use the read_session_messages tool with each chatId above to review the results, and get_session_status to confirm how each session finished. " +
      "Then continue with whatever work depends on these results. If nothing further is needed, you can stop.",
  ].join("\n");
}
