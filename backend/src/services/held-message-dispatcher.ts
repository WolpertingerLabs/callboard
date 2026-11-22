/**
 * Held-message delivery — sends the next "Enqueue Send" message once a
 * chat's turn ends.
 *
 * Driven by `session-completion-handler.ts`'s idle hook (installed from
 * server bootstrap, see {@link initHeldMessageDispatcher}), which runs it on
 * every `session_stopped` before completion callbacks, and by
 * `POST /chats/:id/held/resume` (through the handler's `handleChatIdle`).
 *
 * One item per idle transition. Each held message becomes its own turn and
 * the next waits for that turn to end — it keeps "a normal message once the
 * turn finishes" literally true, attachments and per-message settings
 * included, rather than merging messages that may ask for different models.
 *
 * Races, and what closes each:
 *  - A user's "interrupt and send" stops the run before the new one
 *    registers; `sendMessage` marks the chat starting first, and this refuses
 *    a starting chat.
 *  - Completion callbacks: the hook runs under the completion handler's
 *    per-chat guard, and while this is starting a turn it holds its own
 *    starting mark, which `tryDeliver` treats as busy.
 *  - The user's Edit / Send now (`take`): `claimNext` marks the item
 *    `delivering` synchronously, and `take` refuses a delivering item.
 *  - The user's Stop while an item is being started: there is no session for
 *    `stopSession` to reach yet, so the stop route flags the delivery
 *    ({@link cancelHeldDelivery}) and the run is aborted as soon as the start
 *    resolves; the item is kept as `paused`.
 *  - A start that never settles: raced against a timeout, after which the
 *    item is `failed` (takeable again) and a late start is aborted.
 */
import type { EventEmitter } from "events";
import { heldMessageService, PAUSE_REASON_STOPPED_MID_SEND } from "./held-message-service.js";
import { sessionRegistry } from "./session-registry.js";
import { setIdleDeliveryHook } from "./session-completion-handler.js";
import { startChatTurn, type ChatTurnRequest, type ChatTurnResult } from "./chat-turn.js";
import { getActiveSession, stopSession } from "./claude.js";
import { loadImageBuffers } from "./image-storage.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("held-dispatcher");

/**
 * How long a delivery may sit in `startChatTurn` before the item is given
 * back to the user. Starting a turn on an existing chat is preflight only
 * (provenance, effort and route checks, a metadata write) — seconds at most —
 * so this is a backstop for a start that hangs, not a budget anyone should
 * hit. Without it a hung start would leave the item `delivering` (refusing
 * take/remove with 409) and the chat's queue blocked until a restart.
 *
 * What it cannot do is cancel the hung await itself. If the hang is inside
 * `sendMessage`, that call keeps its own starting mark until it settles, so
 * the chat still reads as "starting": completion callbacks and later held
 * deliveries wait (the start settling wakes them — a throw emits
 * `start_abandoned`, a late success is aborted here and its stop fires). The
 * hold route, though, treats such a chat as not running
 * ({@link hasTimedOutStart}), so new holds are refused with `not_running`
 * instead of piling up behind a start nobody is waiting for.
 */
const DELIVERY_TIMEOUT_MS = 120_000;

/** Test seams. */
export const dispatcherDeps: {
  startChatTurn: (req: ChatTurnRequest) => Promise<ChatTurnResult>;
  stopSession: (chatId: string) => boolean;
  deliveryTimeoutMs: number;
} = { startChatTurn, stopSession, deliveryTimeoutMs: DELIVERY_TIMEOUT_MS };

/** The delivery currently being started on a chat. At most one per chat (claimNext refuses a second). */
interface InFlight {
  itemId: string;
  /** The user pressed Stop while this was starting. */
  cancelled: boolean;
  /** The timeout gave the item back; a late start is aborted, not kept. */
  timedOut: boolean;
}
const inFlight = new Map<string, InFlight>();

/** Per chat: starts this dispatcher timed out that have not settled yet. */
const timedOutStarts = new Map<string, number>();

/**
 * Whether `chatId` has a held-delivery start that timed out and is still
 * pending. While true, its "starting" mark belongs to a start nobody is
 * waiting for, so the hold route must not read it as "running".
 */
export function hasTimedOutStart(chatId: string): boolean {
  return (timedOutStarts.get(chatId) ?? 0) > 0;
}

function settleTimedOutStart(chatId: string): void {
  const left = (timedOutStarts.get(chatId) ?? 1) - 1;
  if (left > 0) timedOutStarts.set(chatId, left);
  else timedOutStarts.delete(chatId);
}

/**
 * Stop a held message that is being started right now — the stop route's
 * half of "Stop means stop". A delivery in `startChatTurn` has no registered
 * session yet, so `stopSession` cannot reach it; this flags it instead, and
 * {@link deliverHeld} aborts the run the moment the start resolves and puts
 * the item back as `paused`. Returns true when there was one to cancel.
 */
export function cancelHeldDelivery(chatId: string): boolean {
  const flight = inFlight.get(chatId);
  if (!flight || flight.timedOut) return false;
  flight.cancelled = true;
  return true;
}

/**
 * Abort the run a delivery started — only if it is still the chat's session,
 * so a run the user started since (after a timeout handed the item back) is
 * never the one stopped.
 */
function abortStartedRun(chatId: string, emitter: EventEmitter): void {
  if (sessionRegistry.get(chatId)?.emitter !== emitter) return;
  dispatcherDeps.stopSession(chatId);
}

/** A refusal body's user-facing text: `message` when there is one, else `error`. */
function refusalMessage(body: Record<string, unknown>): string {
  if (typeof body.message === "string" && body.message) return body.message;
  if (typeof body.error === "string" && body.error) return body.error;
  return "The message could not be sent.";
}

/**
 * Start the chat's next queued held message, if the chat is idle. Resolves
 * true when a turn started (and is still running). Never throws: a delivery
 * that cannot start leaves the item `failed` with the reason, for the user to
 * resend or remove; one the user stopped mid-start is left `paused`.
 *
 * Call it through the completion handler (its idle hook, or
 * `handleChatIdle`), never directly: the per-chat guard there is what lets a
 * wakeup that arrives mid-delivery be replayed instead of lost.
 */
export async function deliverHeld(chatId: string): Promise<boolean> {
  if (getActiveSession(chatId) || sessionRegistry.isStarting(chatId)) return false;
  const item = heldMessageService.claimNext(chatId);
  if (!item) return false;

  // From here until the turn registers (or fails), the chat reads as busy to
  // every other idle-triggered sender.
  const token = sessionRegistry.markStarting(chatId);
  const flight: InFlight = { itemId: item.id, cancelled: false, timedOut: false };
  inFlight.set(chatId, flight);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const imageIds = (item.images ?? []).map((image) => image.id);
    // All or nothing, as for a draft's execute-now: a message that would go
    // out short an attachment goes back to the user instead.
    if (imageIds.length > 0 && loadImageBuffers(imageIds).length !== imageIds.length) {
      heldMessageService.markFailed(chatId, item.id, "An attachment is gone.");
      log.warn(`Held message ${item.id} on ${chatId} not sent: an attachment is missing`);
      return false;
    }

    const starting = dispatcherDeps.startChatTurn({
      chatId,
      prompt: item.text,
      ...(imageIds.length > 0 && { imageIds }),
      ...(item.activePlugins !== undefined && { activePlugins: item.activePlugins }),
      ...(item.model !== undefined && { model: item.model }),
      ...(item.effort !== undefined && { effort: item.effort }),
      ...(item.maxTurns !== undefined && { maxTurns: item.maxTurns }),
      // Never acknowledgeBranchDrift: whether to continue on a different
      // branch is the user's call, made through the client's dialog.
    });
    // Raced against the timeout so a hung start releases the item, this
    // chat's starting mark and the completion handler's guard (we return).
    const timedOut = new Promise<"timed_out">((resolve) => {
      timer = setTimeout(() => resolve("timed_out"), dispatcherDeps.deliveryTimeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([starting, timedOut]);
    if (result === "timed_out") {
      flight.timedOut = true;
      // Bookkeeping first, the store write last: a store write that throws
      // (an unreadable held file) must not skip arranging the late-start
      // abort or the hold route's `hasTimedOutStart` view.
      // A start that completes late must not run behind the handed-back item.
      timedOutStarts.set(chatId, (timedOutStarts.get(chatId) ?? 0) + 1);
      starting.then(
        (late) => {
          settleTimedOutStart(chatId);
          if (late.ok) abortStartedRun(chatId, late.emitter);
        },
        () => settleTimedOutStart(chatId),
      );
      log.warn(`Held message ${item.id} on ${chatId}: start did not settle within ${dispatcherDeps.deliveryTimeoutMs}ms — given back as failed`);
      heldMessageService.markFailed(chatId, item.id, "Starting the turn timed out.");
      return false;
    }
    if (!result.ok) {
      heldMessageService.markFailed(chatId, item.id, refusalMessage(result.body));
      log.info(`Held message ${item.id} on ${chatId} refused (${result.status}): ${refusalMessage(result.body)}`);
      return false;
    }
    if (flight.cancelled) {
      // The user pressed Stop while this was starting. Kept, not lost: the
      // run is aborted and the item waits for Resume / Send now / Remove like
      // any other paused one. Its own reason says the prompt may already be in
      // the transcript (the run registered before the abort), so the user
      // knows a Resume could send it twice.
      abortStartedRun(chatId, result.emitter);
      heldMessageService.update(chatId, item.id, { state: "paused", reason: PAUSE_REASON_STOPPED_MID_SEND });
      log.info(`Held message ${item.id} on ${chatId} stopped by the user as it started — paused`);
      return false;
    }
    // The turn is running: from here the item WAS sent, whatever the store
    // says. A store error now must not fall into the catch below and mark a
    // sent message failed (a Resume would then send it twice). The item stays
    // `delivering` instead — not claimable, refused by take/remove — and the
    // next boot pauses it, where the user can see and remove it.
    try {
      heldMessageService.removeDelivered(chatId, item.id);
    } catch (err: unknown) {
      log.error(`Held message ${item.id} on ${chatId} was sent, but could not be removed from the store: ${err instanceof Error ? err.message : String(err)}`);
    }
    log.info(`Delivered held message ${item.id} to ${chatId}`);
    return true;
  } catch (err: unknown) {
    const reason = err instanceof Error && err.message ? err.message : "The message could not be sent.";
    heldMessageService.markFailed(chatId, item.id, reason);
    log.error(`Held message ${item.id} on ${chatId} failed to start: ${reason}`);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    if (inFlight.get(chatId) === flight) inFlight.delete(chatId);
    sessionRegistry.clearStarting(chatId, token);
  }
}

/**
 * Server bootstrap: pause what the previous process left queued, and install
 * delivery as the completion handler's idle hook.
 */
export function initHeldMessageDispatcher(): void {
  const paused = heldMessageService.pauseAllOnBoot();
  if (paused > 0) log.info(`Paused ${paused} held message(s) left from before the restart`);
  setIdleDeliveryHook(deliverHeld);
}
