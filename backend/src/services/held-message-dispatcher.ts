/**
 * Held-message delivery — sends the next "Send when idle" message once a
 * chat's turn ends.
 *
 * Driven by `session-completion-handler.ts`'s idle hook (installed from
 * server bootstrap, see {@link initHeldMessageDispatcher}), which runs it on
 * every `session_stopped` before completion callbacks, and by
 * `POST /chats/:id/held/resume` when the chat is already idle.
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
 */
import { heldMessageService } from "./held-message-service.js";
import { sessionRegistry } from "./session-registry.js";
import { setIdleDeliveryHook } from "./session-completion-handler.js";
import { startChatTurn, type ChatTurnRequest, type ChatTurnResult } from "./chat-turn.js";
import { getActiveSession } from "./claude.js";
import { loadImageBuffers } from "./image-storage.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("held-dispatcher");

/** Test seam: the turn starter. */
export const dispatcherDeps: { startChatTurn: (req: ChatTurnRequest) => Promise<ChatTurnResult> } = { startChatTurn };

/** A refusal body's user-facing text: `message` when there is one, else `error`. */
function refusalMessage(body: Record<string, unknown>): string {
  if (typeof body.message === "string" && body.message) return body.message;
  if (typeof body.error === "string" && body.error) return body.error;
  return "The message could not be sent.";
}

/**
 * Start the chat's next queued held message, if the chat is idle. Resolves
 * true when a turn started. Never throws: a delivery that cannot start leaves
 * the item `failed` with the reason, for the user to resend or remove.
 */
export async function deliverHeld(chatId: string): Promise<boolean> {
  if (getActiveSession(chatId) || sessionRegistry.isStarting(chatId)) return false;
  const item = heldMessageService.claimNext(chatId);
  if (!item) return false;

  // From here until the turn registers (or fails), the chat reads as busy to
  // every other idle-triggered sender.
  const token = sessionRegistry.markStarting(chatId);
  try {
    const imageIds = (item.images ?? []).map((image) => image.id);
    // All or nothing, as for a draft's execute-now: a message that would go
    // out short an attachment goes back to the user instead.
    if (imageIds.length > 0 && loadImageBuffers(imageIds).length !== imageIds.length) {
      heldMessageService.markFailed(chatId, item.id, "An attachment is gone.");
      log.warn(`Held message ${item.id} on ${chatId} not sent: an attachment is missing`);
      return false;
    }

    const result = await dispatcherDeps.startChatTurn({
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
    if (!result.ok) {
      heldMessageService.markFailed(chatId, item.id, refusalMessage(result.body));
      log.info(`Held message ${item.id} on ${chatId} refused (${result.status}): ${refusalMessage(result.body)}`);
      return false;
    }
    heldMessageService.removeDelivered(chatId, item.id);
    log.info(`Delivered held message ${item.id} to ${chatId}`);
    return true;
  } catch (err: unknown) {
    const reason = err instanceof Error && err.message ? err.message : "The message could not be sent.";
    heldMessageService.markFailed(chatId, item.id, reason);
    log.error(`Held message ${item.id} on ${chatId} failed to start: ${reason}`);
    return false;
  } finally {
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
