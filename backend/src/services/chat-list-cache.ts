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
 * Note this is **not** stale-while-revalidate, despite the shape: nothing
 * refreshes the entry on a stale hit and no client currently re-requests on
 * seeing the flag, so between the TTL and this bound a response simply ages in
 * place. What keeps that from being visible is invalidation — `clearListCaches`
 * runs on every write that changes a listing — which makes this a backstop for
 * whatever no writer covers, not a freshness window anyone should rely on.
 */
export const CHAT_LIST_CACHE_MAX_AGE = 300_000;

export function clearChatListCache(): void {
  chatListCache.clear();
}
