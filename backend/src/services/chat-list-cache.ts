/**
 * Chat-list response cache (stale-while-revalidate) for GET /api/chats.
 *
 * Extracted from routes/chats.ts so services (card membership, MCP tools)
 * can invalidate it on a metadata write without importing the route module
 * — routes/chats.ts → claude.ts → callboard-tools.ts would otherwise close
 * an import cycle back here.
 */
export interface CachedChatListResponse {
  data: { chats: any[]; hasMore: boolean; total: number; windowRows: number };
  createdAt: number;
}

export const chatListCache = new Map<string, CachedChatListResponse>();
/** Serve as fresh (`stale: false`) below this age. */
export const CHAT_LIST_CACHE_TTL = 5_000;
/**
 * Serve flagged `stale: true` up to this age; beyond it, recompute.
 *
 * This *is* stale-while-revalidate — but the revalidation lives in the client,
 * not here. The server never refreshes an entry on a stale hit; what closes the
 * loop is `ChatList.tsx`, which paints the stale response and immediately
 * re-requests with `cached=false`, and that bypass is a read-through, so it
 * refills the entry on the way past. Between the TTL and this bound a response
 * is therefore shown once and replaced, not left to age.
 *
 * The folder list deliberately has no equivalent (see folder-list-cache.ts).
 * The asymmetry is a cost argument, not an oversight: hiding a ~270 ms
 * recompute behind an instant stale paint is worth a second round trip, and
 * hiding a ~21 ms one is not.
 */
export const CHAT_LIST_CACHE_MAX_AGE = 300_000;

export function clearChatListCache(): void {
  chatListCache.clear();
}
