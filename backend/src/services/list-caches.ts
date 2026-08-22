/**
 * Invalidation for every cached listing derived from chat data.
 *
 * There are two of them — the chat list (`GET /api/chats`) and the folder list
 * (`GET /api/chats/folders`) — and they are projections of the same underlying
 * records. A write that changes a chat's title, status, summon flag, card
 * membership or existence changes both listings, so every event that has ever
 * wanted to invalidate one wants to invalidate the other.
 *
 * They get one call rather than two at each of the ~13 call sites for a reason
 * that is about the next change, not this one: paired calls are one forgotten
 * line away from a folder row that keeps showing a chat's old title until its
 * five-minute backstop expires, and that failure is silent. Adding a third
 * listing cache later should mean editing this function, not auditing every
 * writer again.
 *
 * The individual `clearChatListCache` / `clearFolderListCache` remain exported
 * from their own modules for tests and for the rare caller that genuinely means
 * only one.
 */
import { clearChatListCache } from "./chat-list-cache.js";
import { clearFolderListCache } from "./folder-list-cache.js";

export function clearListCaches(): void {
  clearChatListCache();
  clearFolderListCache();
}
