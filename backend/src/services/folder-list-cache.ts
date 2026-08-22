/**
 * Folder-list response cache for GET /api/chats/folders.
 *
 * Standalone for the same reason as {@link ./chat-list-cache.ts}: services
 * (card membership, MCP tools, the job runner) invalidate it on a metadata
 * write, and importing routes/chats.ts to do that would close an import cycle
 * — routes/chats.ts → claude.ts → callboard-tools.ts → back here.
 *
 * ## What this cache is for, and what it deliberately is not
 *
 * It serves **requests that arrive within 5 s of a completed one**, and that
 * phrasing is the whole of the claim. Three things it is *not*, each measured
 * rather than assumed:
 *
 *  - **Not a poll optimiser.** The sidebar polls every 15 s
 *    (`ACTIVE_POLL_MS`), so a 5 s entry never spans two polls and every
 *    scheduled poll pays a full recompute. Making a hit safe across 15 s would
 *    mean fingerprinting *discovery's* input — every provider's session
 *    directory — and discovery (the `find` spawn plus a stat per transcript) is
 *    ~11 ms of the ~21 ms a recompute costs. A fingerprint costing half the
 *    recompute is not worth building, so the recompute is allowed to happen.
 *  - **Not a stampede guard.** An entry is only written *after* its response
 *    computes, and there is no in-flight promise sharing, so genuinely
 *    simultaneous requests all miss and all recompute. Four at once measured
 *    259 ms against 315 ms uncached — ~18%, near noise. Staggered arrivals are
 *    what hit.
 *  - **Not a help to event-driven refreshes.** Those are misses *by
 *    construction*: the refresh fires because session or workspace state moved,
 *    and that is the same movement the fingerprint watches, so the entry is
 *    invalid for exactly the reason the request exists.
 *
 * What is left is real but small, and deliberately on the record here as the
 * evidence for a later simplification pass: if the remaining hits do not
 * justify the machinery, delete it and keep the memo. The memo in
 * utils/paths.ts is what took this route from ~115 ms to ~21 ms; this is the
 * second, much smaller win and it is scoped to say so.
 *
 * An earlier revision served entries past the TTL with `stale: true` and no
 * revalidation, copying the chat list's shape. That was wrong here on both
 * counts: nothing ever revalidated, so the practical staleness window was the
 * 300 s backstop rather than the 5 s TTL, and stale-serving only pays for
 * itself when a recompute is expensive enough to be worth hiding — 270 ms for
 * the chat list, 21 ms here. Background revalidation would not have fixed it
 * either: the cost that matters on this route is *blocked event loop*, and
 * moving the block off the request path does not unblock the loop.
 *
 * ## Freshness is checked, not only hooked
 *
 * A folder row carries state that changes with no request touching this route,
 * so no amount of `clearFolderListCache()` sprinkled on HTTP handlers can cover
 * it:
 *
 *  - `status: "ongoing" | "waiting" | "stopped"` — derived from
 *    `sessionRegistry.has()` and `hasPendingRequest()`. A session starts, stops
 *    or parks a permission prompt on its own schedule.
 *  - `displayName`, `workspaceId`, `workspaceCount`, `repoPath`,
 *    `workspaces[]`, `directoryState`, `directoryDetail` — all from the
 *    workspace registry. `renameWorkspace` and `archiveWorkspace` write a
 *    record and return; neither was ever among the writers that invalidate a
 *    listing, and neither would the next one be.
 *
 * So every entry records a fingerprint of that state, the route recomputes it
 * per request, and a mismatch is a miss. The route owns the fingerprint because
 * the route is where those dependencies are already imported; this module only
 * stores it. See the `fingerprint` local in routes/chats.ts.
 *
 * The rule the fingerprint encodes: **state that changes without a request
 * gets a version, state that changes because of a request gets a hook.** Titles,
 * `chatStatus`, summon flags and row membership are disk-backed and only move
 * when something calls into the daemon, so they use `clearListCaches()`.
 *
 * ## How this composes with the other three memos
 *
 * Four caches sit on this path and they nest rather than overlap:
 *
 *  1. `projectDirToFolder` (utils/paths.ts, 5 min) — decodes a project-dir name
 *     to a path. Below discovery; shared with `GET /api/chats` and chat search.
 *  2. `getCachedGitInfo` (routes/chats.ts, 5 min) — `isGitRepo` + branch per
 *     directory.
 *  3. disk-usage memo (utils/disk-usage.ts, 5 min) — `du -sk` per directory,
 *     only when `includeDiskUsage=true`.
 *  4. this one, 5 seconds — the assembled response.
 *
 * 1–3 are keyed by *directory* and answer "what is true of this path"; a hit
 * here short-circuits all of them, and a miss falls through to whatever they
 * hold. None of them can make this one stale, because a hit here never consults
 * them. Note the ordering that follows: this cache is an order of magnitude
 * shorter-lived than the three beneath it, so it can never be the reason a row
 * is out of date — if a branch name is stale it is layer 2's five minutes, which
 * predates this PR.
 */
import type { FolderSummary } from "shared";

export interface CachedFolderListResponse {
  data: { folders: FolderSummary[]; diskUsageNote?: string };
  createdAt: number;
  /**
   * The state this response was built from that no request need touch to
   * change. Compared, not trusted — see the module header.
   */
  fingerprint: string;
}

export const folderListCache = new Map<string, CachedFolderListResponse>();

/**
 * How long an entry may be served.
 *
 * Shorter than the sidebar's 15 s poll on purpose: an entry is served to
 * requests arriving within 5 s of the one that computed it, and never spans two
 * polls. See the module header for what that does and does not cover.
 *
 * It is also the worst-case window for the one thing no fingerprint here
 * watches — a folder that appears on disk with nothing in Callboard's memory,
 * such as a chat started from a terminal `claude` in a directory Callboard has
 * never seen. That is bounded by this constant, and in practice by the 15 s
 * poll that would have to fetch it anyway.
 */
export const FOLDER_LIST_CACHE_TTL = 5_000;

export function clearFolderListCache(): void {
  folderListCache.clear();
}
