import type { Chat } from "shared";
import { parseChatMetadata } from "../utils/chat-metadata.js";

/**
 * The chat list's row-ID rule, shared so every surface that names list rows
 * (the list itself, `GET /chats/search`) agrees on which row a session is.
 *
 * A discovered session's row is the stored chat that claims it — through its
 * `session_id` or any entry of `metadata.session_ids[]` — and the bare session
 * ID when no record claims it. Ownership is provider-blind and last-wins: when
 * two records claim one session, the later record in storage order owns the
 * row. That is what the list has always done; anything that must return IDs
 * the list can render has to reproduce it exactly, not a "better" variant.
 */

/** Record `chat`'s session claims in `index`. `meta` is its parsed metadata. */
export function indexChatSessions(index: Map<string, Chat>, chat: Chat, meta: Record<string, unknown>): void {
  if (chat?.session_id) index.set(chat.session_id, chat);
  if (Array.isArray(meta.session_ids)) {
    for (const sid of meta.session_ids as string[]) index.set(sid, chat);
  }
}

/** Index stored chats by every session they claim. See the module comment. */
export function indexStoredChatsBySession(chats: Chat[]): Map<string, Chat> {
  const index = new Map<string, Chat>();
  for (const chat of chats) indexChatSessions(index, chat, parseChatMetadata(chat?.metadata));
  return index;
}

/** The list row ID a discovered session renders as. */
export function rowIdForSession(index: Map<string, Chat>, sessionId: string): string {
  return index.get(sessionId)?.id ?? sessionId;
}
