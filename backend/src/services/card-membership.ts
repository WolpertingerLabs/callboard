/**
 * Card membership on the chat side. Chats point at a card via
 * metadata.cardId; unassign writes `cardId: null` (the key stays present, so
 * membership is a string check, never key presence).
 *
 * All writes here are VIEW-ONLY: they must not bump updated_at (which would
 * mark the chat unread and reorder the sidebar) and must invalidate the
 * chat-list cache so chat lists reflect the change on their next poll.
 * Single choke point so the REST routes and the MCP tools behave identically,
 * including for chats that exist only as filesystem sessions.
 */
import { chatFileService } from "./chat-file-service.js";
import { findChat } from "../utils/chat-lookup.js";
import { sessionRegistry } from "./session-registry.js";
import { clearListCaches } from "./list-caches.js";

/** The chat's card, or undefined. `cardId: null` (unassigned) reads as undefined. */
export function getChatCardId(chatId: string): string | undefined {
  const chat = chatFileService.getChat(chatId);
  if (!chat) return undefined;
  try {
    const meta = JSON.parse(chat.metadata || "{}");
    return typeof meta.cardId === "string" && meta.cardId ? meta.cardId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Merge view-only metadata fields onto a chat without bumping updated_at,
 * then invalidate the chat-list cache and bump the metadata version. Returns
 * false only when the chat cannot be found at all. Handles chats that exist
 * only as filesystem sessions by materializing a file record that preserves
 * the session's timestamps.
 */
function writeViewMeta(chatId: string, fields: Record<string, unknown>): boolean {
  // Fast path: an existing file-storage record (covers agent/UI chats).
  if (chatFileService.updateChatMetadata(chatId, fields, { touch: false })) {
    clearListCaches();
    sessionRegistry.notifyMetadata(chatId, fields);
    return true;
  }

  // Filesystem-only chat: materialize a record, preserving its timestamps.
  const chat = findChat(chatId, false) as any;
  if (!chat) return false;
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(chat.metadata || "{}");
  } catch {}
  Object.assign(meta, fields);
  chatFileService.upsertChat(chat.id, chat.folder, chat.session_id, {
    metadata: JSON.stringify(meta),
    ...(chat.created_at && { created_at: chat.created_at }),
    ...(chat.updated_at && { updated_at: chat.updated_at }),
  });
  clearListCaches();
  sessionRegistry.notifyMetadata(chat.id, fields);
  return true;
}

/** Assign the chat to a card, or unassign with cardId = null. Lifecycle is the caller's to enforce. */
export function setChatCardMembership(chatId: string, cardId: string | null): boolean {
  return writeViewMeta(chatId, { cardId });
}

/**
 * Unassign every chat that points at `cardId`. Used when a card is deleted so
 * no chat is left carrying a dead card id — `getChatCardId` would otherwise
 * resolve one, and the MCP tools' default-card path would fail with "card not
 * found" instead of the clearer "this chat is not on a card".
 *
 * Membership is read with the same non-empty-string rule as everywhere else in
 * this module, so an unassigned `cardId: null` is never mistaken for a member.
 * Returns the number of chats changed.
 */
export function unassignAllChatsFromCard(cardId: string): number {
  let changed = 0;
  for (const chat of chatFileService.getAllChats()) {
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(chat.metadata || "{}");
    } catch {
      continue;
    }
    if (typeof meta.cardId === "string" && meta.cardId === cardId && setChatCardMembership(chat.id, null)) changed++;
  }
  return changed;
}
