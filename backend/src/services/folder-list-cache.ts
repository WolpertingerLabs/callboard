/**
 * Folder-list response cache (stale-while-revalidate) for GET /api/chats/folders.
 *
 * Standalone for the same reason as {@link ./chat-list-cache.ts}: services
 * (card membership, MCP tools, the job runner) invalidate it on a metadata
 * write, and importing routes/chats.ts to do that would close an import cycle
 * — routes/chats.ts → claude.ts → callboard-tools.ts → back here.
 *
 * ## Why this cache needs a fingerprint and the chat-list one does not
 *
 * A folder row carries `status: "ongoing" | "waiting" | "stopped"`, and that
 * field is not read from disk — it is derived from two pieces of **in-memory**
 * state at the instant the row is built: `sessionRegistry.has(sessionId)` and
 * `hasPendingRequest(sessionId)`. A cached row showing "stopped" for a session
 * that just went live is a visible bug, not a stale number, and no amount of
 * `clearFolderListCache()` sprinkled on HTTP handlers can cover it: a session
 * starts, stops, or parks a permission prompt without any request touching this
 * route at all.
 *
 * So freshness here is not (only) hooked, it is **checked**. Every entry
 * records the fingerprint of that in-memory state, the route recomputes the
 * fingerprint per request, and a mismatch is a miss — ahead of the TTL, ahead
 * of the stale window, unconditionally. The route owns the fingerprint because
 * the route is where those two dependencies are already imported; this module
 * only stores it. See `statusFingerprint` in routes/chats.ts.
 *
 * That makes the dangerous field structurally exempt from staleness, which in
 * turn is what makes the time-based part of this cache safe: what the TTL can
 * serve stale is chat titles, `chatStatus`, summon flags and row ordering —
 * all disk-backed, all covered by the same explicit invalidation calls the
 * chat-list cache already gets.
 *
 * ## How this composes with the other three layers
 *
 * Four memos sit on this path and they nest rather than overlap:
 *
 *  1. `projectDirToFolder` (utils/paths.ts, 5 min) — decodes a project-dir name
 *     to a path. Below discovery; shared with `GET /api/chats` and chat search.
 *  2. `getCachedGitInfo` (routes/chats.ts, 5 min) — `isGitRepo` + branch per
 *     directory.
 *  3. disk-usage memo (utils/disk-usage.ts, 5 min) — `du -sk` per directory,
 *     only when `includeDiskUsage=true`.
 *  4. this one — the assembled response.
 *
 * 1–3 are keyed by *directory* and answer "what is true of this path"; a hit in
 * this cache short-circuits all of them, and a miss falls through to whatever
 * they hold. None of them can make this one stale, because a hit here never
 * consults them. The only freshness question a reader has to hold in their head
 * is this module's, and the fingerprint answers the sharp half of it.
 */
import type { FolderSummary } from "shared";

export interface CachedFolderListResponse {
  data: { folders: FolderSummary[]; diskUsageNote?: string };
  createdAt: number;
  /**
   * The in-memory session state this response was built from. Compared, not
   * trusted — see the module header.
   */
  fingerprint: string;
}

export const folderListCache = new Map<string, CachedFolderListResponse>();
/** Serve without recomputing below this age. */
export const FOLDER_LIST_CACHE_TTL = 5_000;
/** Serve stale up to this age; beyond it, recompute. */
export const FOLDER_LIST_CACHE_MAX_AGE = 300_000;

export function clearFolderListCache(): void {
  folderListCache.clear();
}
