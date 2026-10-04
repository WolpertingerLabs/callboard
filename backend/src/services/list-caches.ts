/**
 * Invalidation for every cached listing derived from chat data.
 *
 * Today there is one — the chat list (`GET /api/chats`). Writers that change a
 * chat's title, status, summon flag, card membership or existence call this
 * rather than `clearChatListCache` directly, at each of the ~13 call sites, for
 * a reason that is about the next change, not this one: a second listing cache
 * added later should mean editing this function, not auditing every writer
 * again. A missed call is silent and slow — a row keeps showing a chat's old
 * title until its five-minute backstop expires.
 *
 * `clearChatListCache` remains exported from its own module for tests and for
 * the rare caller that genuinely means only that one.
 */
import { clearChatListCache } from "./chat-list-cache.js";

export function clearListCaches(): void {
  clearChatListCache();
}
