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
 * Dependencies (sendMessage, getActiveSession) are injected from claude.ts to
 * avoid a circular import, mirroring the setMessageSender pattern used elsewhere.
 */
import type { EventEmitter } from "events";
import { sessionRegistry, type SessionEvent } from "./session-registry.js";
import { findChat } from "../utils/chat-lookup.js";
import { executeAgent } from "./agent-executor.js";
import {
  markChildComplete,
  getReadyForParent,
  removeCallbacks,
  parentsWithReadyCallbacks,
  setChatDepth,
  clearChatDepth,
} from "./session-callbacks.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("session-completion");

type MessageSender = (opts: {
  prompt: string | AsyncIterable<unknown>;
  chatId?: string;
  maxTurns?: number;
}) => Promise<EventEmitter>;

type ActiveSessionLookup = (chatId: string) => unknown | undefined;

let _sendMessage: MessageSender | null = null;
let _getActiveSession: ActiveSessionLookup | null = null;
let _initialized = false;

/** Parents currently being delivered to — guards against concurrent double-delivery. */
const delivering = new Set<string>();

/**
 * Wire up the global completion listener. Safe to call once; subsequent calls
 * only refresh the injected dependencies.
 */
export function initSessionCompletionHandler(deps: { sendMessage: MessageSender; getActiveSession: ActiveSessionLookup }): void {
  _sendMessage = deps.sendMessage;
  _getActiveSession = deps.getActiveSession;

  if (_initialized) return;
  _initialized = true;

  sessionRegistry.on("change", (event: SessionEvent) => {
    if (event.event !== "session_stopped") return;
    // Fire-and-forget; never let a delivery failure crash the registry emit.
    void handleSessionStopped(event.chatId).catch((err) => {
      log.error(`Completion handling for ${event.chatId} failed: ${err?.message ?? err}`);
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
  const candidates = new Set<string>(parentsWithReadyCallbacks());
  candidates.add(stoppedChatId);

  for (const parentChatId of candidates) {
    await tryDeliver(parentChatId);
  }
}

async function tryDeliver(parentChatId: string): Promise<void> {
  if (delivering.has(parentChatId)) return;

  const ready = getReadyForParent(parentChatId);
  if (ready.length === 0) return;

  // Parent is mid-turn — defer. It will be retried when the parent (or any
  // session) next stops.
  if (_getActiveSession && _getActiveSession(parentChatId)) return;

  delivering.add(parentChatId);
  try {
    const ids = ready.map((c) => c.id);
    const childChatIds = ready.map((c) => c.childChatId);
    const depth = Math.max(...ready.map((c) => c.depth));
    const prompt = buildNotification(childChatIds);

    const parentChat = findChat(parentChatId, false);

    if (parentChat) {
      // Normal path: resume the existing parent chat as a fresh turn.
      await _sendMessage!({ chatId: parentChatId, prompt: toPromptIterable(prompt), maxTurns: 200 });
      setChatDepth(parentChatId, depth);
      removeCallbacks(ids);
      log.info(`Delivered ${ids.length} completion(s) to parent chat ${parentChatId} (depth ${depth})`);
      return;
    }

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
    // Leave callbacks in "ready" so they retry on a future session stop.
    log.error(`Delivery to parent ${parentChatId} failed: ${err.message}`);
  } finally {
    delivering.delete(parentChatId);
  }
}

function buildNotification(childChatIds: string[]): string {
  const list = childChatIds.map((id) => `"${id}"`).join(", ");
  const header =
    childChatIds.length === 1
      ? `🔔 A session you spawned has completed: ${list}.`
      : `🔔 ${childChatIds.length} sessions you spawned have completed: ${list}.`;
  return [
    header,
    "",
    "Use the read_session_messages tool with each chatId above to review the results, and get_session_status to confirm how each session finished. " +
      "Then continue with whatever work depends on these results. If nothing further is needed, you can stop.",
  ].join("\n");
}

function toPromptIterable(content: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { type: "user" as const, message: { role: "user" as const, content } };
  })();
}
