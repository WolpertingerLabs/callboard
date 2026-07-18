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
/** Serve without revalidating below this age. */
export const CHAT_LIST_CACHE_TTL = 5_000;
/** Serve stale (and revalidate) up to this age; beyond it, recompute. */
export const CHAT_LIST_CACHE_MAX_AGE = 300_000;

export function clearChatListCache(): void {
  chatListCache.clear();
}
