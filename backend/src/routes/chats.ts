import { Router } from "express";
import type { Request } from "express";
import { existsSync } from "fs";
import { randomUUID } from "node:crypto";
import { chatFileService } from "../services/chat-file-service.js";
import { getCommandsAndPluginsForDirectory, getAllCommandsForDirectory, resolveSlashCommandContent } from "../services/slashCommands.js";
import { getAllAppPluginsData } from "../services/app-plugins.js";
import { getGitInfo } from "../utils/git.js";
import { findChat } from "../utils/chat-lookup.js";
import { hasPendingRequest, pendingRequestFingerprint } from "../services/claude.js";
import { buildChatTree, buildLineageIndex, paginateTreeRows, walkToRootId } from "../services/chat-lineage.js";
import { isCardEligible, cardLifecycleOf, rawCardFields } from "../services/card-fields.js";
import { getRun, latestRunChatId } from "../services/job-store.js";
import { hasParkedApprovals } from "../services/job-approval-signal.js";
import { sessionRegistry } from "../services/session-registry.js";
import { getSessionProviders } from "../agents/factory.js";
import { isInternalProvider, isRetiredProvider, isRoutableProvider, type InternalProviderKind } from "../agents/ports/AgentProvider.js";
import { buildHandoffTurns, providerLabel, truncateAtCutoff } from "../agents/handoff.js";
import { createLogger } from "../utils/logger.js";
import { buildFolderSummaries } from "../services/folder-summaries.js";
import { buildWorkspaceIndex, viewForDirectory } from "../services/workspace-views.js";
import { describeWorkspaceDirectory } from "../services/workspace-service.js";
import { newAsyncDiskUsageBudget } from "../utils/disk-usage.js";
// Both listing caches live in standalone modules so services can invalidate
// them without closing an import cycle back through this route, and
// `clearListCaches` is the one call that empties both — see list-caches.ts.
import { chatListCache, CHAT_LIST_CACHE_TTL, CHAT_LIST_CACHE_MAX_AGE, clearChatListCache } from "../services/chat-list-cache.js";
import { folderListCache, folderListGeneration, folderListInFlight, FOLDER_LIST_CACHE_TTL, clearFolderListCache } from "../services/folder-list-cache.js";
import { workspaceRegistryVersion } from "../services/workspace-store.js";
import { clearListCaches } from "../services/list-caches.js";
export { clearChatListCache, clearFolderListCache, clearListCaches };

const log = createLogger("chats");

export const chatsRouter = Router();

// Cache for git info to avoid repeated expensive operations
const gitInfoCache = new Map<string, { isGitRepo: boolean; branch?: string; cachedAt: number }>();
const GIT_CACHE_TTL = 300000; // 5 minutes

/**
 * Get cached git info or fetch and cache it
 *
 * ## The entries expire together, and that used to be the whole problem
 *
 * Every entry is created by the same request — the one that built the first
 * listing — so every entry also *expires* at the same instant, five minutes
 * later. Whichever 15-second poll lands after that boundary re-fetches all of
 * them in one synchronous run. Measured on a 24-folder sidebar: 24 misses in a
 * single poll, 347 ms of blocked event loop, recurring at t+303 s and t+606 s
 * and every five minutes after that for as long as a tab is open. It read as a
 * cold-start cost in a one-shot measurement and was not one.
 *
 * The fix here was to make the underlying read cheap rather than to stagger the
 * expiry — `getGitInfo` now reads the branch out of `HEAD` instead of spawning
 * `git branch --show-current`, so refilling *this* memo costs ~12 ms and there
 * is no herd left worth breaking up at that price. See the header of
 * `getGitInfo` in utils/git.ts.
 *
 * ## The property is general; this memo is just the cheap case now
 *
 * **Every memo minted by one request and expired on a fixed TTL has this
 * shape**, and this one is not the only one on this path. `projectDirToFolder`
 * (utils/paths.ts) is minted by the same first listing and was on the same
 * five-minute clock, for 49.8 ms of re-decoding on the same poll — it is why
 * the `disc` column spiked alongside the `git` column at t+303 s and t+606 s in
 * the measurements above. A decode cannot be made cheap the way a branch read
 * could, so that one is fixed by *spreading* the expiries instead; see
 * `jitteredExpiry` there. Two memos, one property, two different fixes because
 * the underlying costs differ.
 *
 * What that means for anyone editing here: this memo's value is now *bounded*,
 * because what it memoises is a handful of file reads. It is worth keeping —
 * the directory set is small and stable, so hits are nearly free — but it can
 * no longer be relied on to hide an expensive call. Putting a subprocess back
 * behind it would restore the five-minute spike exactly as it was, and nothing
 * in a single request's timing would show it.
 */
function getCachedGitInfo(folder: string): { isGitRepo: boolean; branch?: string } {
  const cached = gitInfoCache.get(folder);
  const now = Date.now();

  if (cached && now - cached.cachedAt < GIT_CACHE_TTL) {
    return { isGitRepo: cached.isGitRepo, branch: cached.branch };
  }

  let gitInfo: { isGitRepo: boolean; branch?: string } = { isGitRepo: false };
  try {
    gitInfo = getGitInfo(folder);
  } catch {}

  gitInfoCache.set(folder, { ...gitInfo, cachedAt: now });
  return gitInfo;
}

/** Whether a chat's nested card opted out of the board (metadata.card.hidden). */
function isCardHidden(chat: { metadata?: string | null }): boolean {
  return rawCardFields(chat).hidden === true;
}

/** The `provider` a chat record names, or undefined when absent/unparseable. */
function readProvider(chat: { metadata?: string | null }): unknown {
  try {
    return JSON.parse(chat.metadata || "{}").provider;
  } catch {
    return undefined;
  }
}

/**
 * Extract the first user message text from a JSONL session file (up to maxLength chars).
 * Used as a chat preview/title in the chat list.
 *
 * `providerKind` names the session's owning provider — the chat record's
 * `metadata.provider`, else whichever provider's discovery returned the file.
 * Asked first, it turns five speculative full-file reads into one. It is a
 * hint, not a contract: a session whose owner declines still falls through to
 * the historical walk over every provider, so a stale or missing `provider`
 * costs the old price rather than a missing preview.
 */
function getFirstUserMessage(filePath: string, maxLength: number = 200, providerKind?: string): string | null {
  const providers = getSessionProviders();
  const owner = providerKind ? providers.find((p) => p.kind === providerKind) : undefined;
  if (owner) {
    const preview = owner.getSessionPreview(filePath, maxLength);
    if (preview) return preview;
  }
  for (const provider of providers) {
    if (provider === owner) continue;
    const preview = provider.getSessionPreview(filePath, maxLength);
    if (preview) return preview;
  }
  return null;
}

/**
 * A discovered session plus the provider that discovered it. The tag is what
 * lets the list route send a preview read to one provider instead of trying all
 * five; it is route-local bookkeeping and never reaches the response body.
 */
type DiscoveredSession = {
  sessionId: string;
  folder: string;
  displayFolder: string;
  filePath: string;
  createdAt: Date;
  updatedAt: Date;
  providerKind: string;
};

/**
 * Discover session JSONL files using filesystem-level sorting for optimal performance.
 * Only processes the files needed for the current page.
 */
/**
 * Discover sessions across all registered providers.
 * Merges results, sorts globally by mtime DESC, and paginates.
 */
function discoverSessionsPaginated(limit: number, offset: number): { sessions: DiscoveredSession[]; total: number } {
  const providers = getSessionProviders();

  if (providers.length === 1) {
    // Single provider: delegate directly (preserves existing performance)
    const { sessions, total } = providers[0].discoverSessions({ limit, offset });
    return { sessions: sessions.map((s) => ({ ...s, providerKind: providers[0].kind })), total };
  }

  // Multi-provider: collect all, merge, sort, paginate
  const allSessions: DiscoveredSession[] = [];
  for (const provider of providers) {
    const { sessions } = provider.discoverSessions({ limit: 9999, offset: 0 });
    for (const s of sessions) allSessions.push({ ...s, providerKind: provider.kind });
  }

  allSessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const total = allSessions.length;
  const paginated = allSessions.slice(offset, offset + limit);
  return { sessions: paginated, total };
}

// Search chat contents using grep for performance
chatsRouter.get("/search", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Search chat contents'
  // #swagger.description = 'Search through session files for matching content across all providers.'
  /* #swagger.parameters['q'] = { in: 'query', type: 'string', required: true, description: 'Search query string' } */
  /* #swagger.parameters['folder'] = { in: 'query', type: 'string', description: 'Folder to search within' } */
  /* #swagger.responses[200] = { description: "Array of matching chat/session IDs" } */
  try {
    const query = ((req.query.q as string) || "").trim();
    const folder = (req.query.folder as string) || "";
    if (!query) {
      return res.json({ chatIds: [] });
    }

    // If folder is provided, use the structured searchSessions API
    if (folder) {
      const chatIds = new Set<string>();
      for (const provider of getSessionProviders()) {
        const results = provider.searchSessions({ folder, grep: query });
        for (const r of results.chats) chatIds.add(r.chatId);
      }
      return res.json({ chatIds: Array.from(chatIds) });
    }

    // Fallback: search all sessions across all providers by discovering
    // all sessions and checking for matches (backwards-compatible with
    // the old grep-based approach). For now, delegate to first provider's
    // search with a broad filter. The old endpoint searched globally;
    // the provider search is folder-scoped, so we replicate the old
    // behavior by getting all sessions and checking each.
    // TODO: Add a global grep method to SessionProvider if needed.
    const chatIds = new Set<string>();
    for (const provider of getSessionProviders()) {
      const { sessions } = provider.discoverSessions({ limit: 9999, offset: 0 });
      // Group by folder and search each folder
      const folderSet = new Set(sessions.map((s) => s.folder));
      for (const f of folderSet) {
        try {
          const results = provider.searchSessions({ folder: f, grep: query, limit: 50 });
          for (const r of results.chats) chatIds.add(r.chatId);
        } catch {
          // Folder may no longer exist — skip
        }
      }
    }

    res.json({ chatIds: Array.from(chatIds) });
  } catch (err: any) {
    log.error(`Error searching chats: ${err}`);
    res.status(500).json({ error: "Failed to search chats", details: err.message });
  }
});

// List chats grouped by folder, ordered by most recent chat created
chatsRouter.get("/folders", async (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'List chats grouped by folder'
  // #swagger.description = 'Returns folders with aggregated chat info, ordered by most recently created chat. Folders that no longer exist on disk are filtered out, except when an active workspace record claims them — those are listed with directoryState "missing" so the stale record can be seen and archived. Each row also carries the active workspace records claiming the directory (id, name, isolation, owned, branch, directory state); it deliberately carries no removal verdict, which costs several git subprocesses per record — ask GET /api/workspaces for that.'
  /* #swagger.parameters['maxAgeDays'] = { in: 'query', type: 'integer', description: 'Maximum age in days (default: 5)' } */
  /* #swagger.parameters['includeDiskUsage'] = { in: 'query', type: 'string', description: 'Pass the string true to measure each listed directory with du -sk. Off by default: it is the slow part, and this endpoint is polled. Measurements are memoised for five minutes.' } */
  /* #swagger.parameters['cached'] = { in: 'query', type: 'string', description: 'Set to false to bypass the response cache and force fresh data' } */
  try {
    const maxAgeDays = parseInt(req.query.maxAgeDays as string, 10) || 5;
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    const includeDiskUsage = req.query.includeDiskUsage === "true";

    // Both parameters change the response body — `maxAgeDays` the row set,
    // `includeDiskUsage` the per-row `diskUsage` — so both are in the key.
    const cacheKey = `${maxAgeDays}:${includeDiskUsage}`;
    // The in-memory state a row reports that no request need touch to change:
    // `status` (session registry + parked permission prompts) and the workspace
    // record fields (`displayName`, `workspaceId`, `workspaces[]`,
    // `directoryState`, …). Recomputed per request and compared against what
    // the entry was built from; a mismatch is a miss. See the header of
    // services/folder-list-cache.ts for why these are checked, not hooked.
    const fingerprint = `${sessionRegistry.version}:${sessionRegistry.metadataVersion}:${pendingRequestFingerprint()}:${workspaceRegistryVersion()}`;
    const bypassCache = req.query.cached === "false";
    const now = Date.now();
    // Read before anything is read *from*, so an invalidation landing at any
    // point during the build is caught. Erring early only ever costs a cache
    // miss; erring late stores rows that predate a delete. @see folderListGeneration
    const generation = folderListGeneration();

    if (!bypassCache) {
      const cached = folderListCache.get(cacheKey);
      if (cached && cached.fingerprint === fingerprint && now - cached.createdAt < FOLDER_LIST_CACHE_TTL) {
        return res.json(cached.data);
      }
      // Nothing cached, but a build for this exact key and state may already be
      // running — see folderListInFlight. Joining it costs nothing and saves a
      // whole duplicate listing, synchronous head included.
      const sharing = folderListInFlight.get(cacheKey);
      if (sharing && sharing.fingerprint === fingerprint) {
        return res.json(await sharing.response);
      }
    }

    const build = buildFolderListResponse();
    // `cached=false` means "compute mine from scratch", so it neither joins a
    // build nor publishes one for others to join.
    if (!bypassCache) folderListInFlight.set(cacheKey, { fingerprint, response: build });
    try {
      return res.json(await build);
    } finally {
      if (folderListInFlight.get(cacheKey)?.response === build) folderListInFlight.delete(cacheKey);
    }

    async function buildFolderListResponse() {
      // One budget across the listing, not one timeout per row: an unbounded
      // listing would be an unbounded wait even now that the `du`s run in
      // parallel. What it did not get to is reported rather than silently
      // absent — `diskUsageNote` has been in FolderListResponse since Phase 4a
      // and this is what sets it. The rows come back holding unfilled
      // measurements that `settle()` writes into, below.
      const budget = newAsyncDiskUsageBudget();

      // Fetch all sessions (large limit to get everything within range)
      const { sessions } = discoverSessionsPaginated(9999, 0);

      // One registry read for the whole listing, not one per row.
      const workspaces = buildWorkspaceIndex();

      const folders = buildFolderSummaries(sessions, {
        cutoff,
        workspaces,
        directoryExists: (folder) => existsSync(folder),
        chatMetadata: (sessionId) => {
          // Session id straight from discovery, so this is the direct-filename
          // read with no fallback scan. This bounds a spike rather than saving
          // steady-state work: rows whose newest chat has a record cost the same
          // either way, but one started from a terminal `claude` used to make
          // getChat readdir + parse the whole chats directory (~88 ms) to prove
          // the record is absent — once per such row, on a route the sidebar
          // polls every 15 seconds.
          const storedChat = chatFileService.getChatBySessionId(sessionId);
          return storedChat ? JSON.parse(storedChat.metadata || "{}") : {};
        },
        isOngoing: (sessionId) => sessionRegistry.has(sessionId),
        isWaiting: (sessionId) => hasPendingRequest(sessionId),
        gitInfo: (folder) => getCachedGitInfo(folder),
        describeDirectory: (workspace) => describeWorkspaceDirectory(workspace),
        // Absent unless asked for — that absence *is* the opt-in.
        ...(includeDiskUsage && { diskUsage: (folder: string) => budget.measure(folder) }),
      });

      // Fills in the measurements the rows are already holding. Must precede
      // both `note()` and the cache write below — a row cached mid-flight would
      // be cached with an unfilled placeholder and served that way for the TTL.
      await budget.settle();

      const diskUsageNote = budget.note(folders.length);
      const responseData = { folders, ...(diskUsageNote && { diskUsageNote }) };
      // Both the fingerprint and `createdAt` are the values read *before* the
      // rows were built. The rows can only be as fresh as that read, so
      // recording either later would claim a freshness they do not have — the
      // fingerprint would hide a transition that landed mid-build, and a
      // post-`settle()` timestamp would grant the entry the whole duration of
      // the `du` sweep as extra TTL.
      //
      // And the write only happens if no invalidation landed while we ran.
      // The fingerprint cannot cover this: `clearListCaches()` fires for changes
      // that move no version counter — a deleted chat, a closed card, a toggled
      // bookmark — so a build that started before one produces an entry whose
      // fingerprint still matches and would be served as valid for a full TTL.
      // @see folderListGeneration
      if (folderListGeneration() === generation) {
        folderListCache.set(cacheKey, { data: responseData, createdAt: now, fingerprint });
      }
      // The response itself is still returned: this request read a consistent
      // snapshot, and it began before the invalidation did. Only *storing* it
      // for later requests would be wrong.
      return responseData;
    }
  } catch (err: any) {
    log.error(`Error listing folders: ${err}`);
    res.status(500).json({ error: "Failed to list folders", details: err.message });
  }
});

// List all chats (pull from log directories, augment with file storage data)
chatsRouter.get("/", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'List all chats'
  // #swagger.description = 'Returns paginated list of chats from filesystem session logs, augmented with file storage metadata. Sorted by most recently updated.'
  /* #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Number of chats per page (default: 20). With includeLineage, counts sidebar tree rows — a parentage group folds into one row and all its members are returned.' } */
  /* #swagger.parameters['offset'] = { in: 'query', type: 'integer', description: 'Offset for pagination (default: 0). Same unit as limit: chats normally, tree rows with includeLineage.' } */
  /* #swagger.parameters['bookmarked'] = { in: 'query', type: 'string', description: 'Filter to only bookmarked chats when set to true' } */
  /* #swagger.parameters['excludeTriggered'] = { in: 'query', type: 'string', description: 'Exclude triggered/agent chats from results when set to true. Returns LIMIT non-triggered chats so the list always has content.' } */
  /* #swagger.parameters['includeLineage'] = { in: 'query', type: 'string', description: 'When true, limit/offset count sidebar tree rows (chats sharing a parentage root fold into one row, every member of a windowed row is returned) so the tree view always gets a full page of visible rows. Tree relatives without a session in the window are appended flagged with _lineage_appended; they do not count toward pagination.' } */
  /* #swagger.parameters['cardsOnly'] = { in: 'query', type: 'string', description: 'When true, return only chats whose lineage root is an OPEN card (a non-triggered, non-job-step top-level chat), plus every chat in those trees. Chats on closed cards, non-card chats, and sessions with no stored record are excluded.' } */
  /* #swagger.parameters['cached'] = { in: 'query', type: 'string', description: 'Set to false to bypass cache and force fresh data' } */
  /* #swagger.responses[200] = { description: "Paginated chat list with hasMore, total, windowRows, and stale fields" } */
  try {
    // Check cache (stale-while-revalidate)
    const bypassCache = req.query.cached === "false";
    const cacheKey = `${req.query.limit || ""}:${req.query.offset || ""}:${req.query.bookmarked || ""}:${req.query.excludeTriggered || ""}:${req.query.includeLineage || ""}:${req.query.cardsOnly || ""}`;
    const now = Date.now();

    if (!bypassCache) {
      const cached = chatListCache.get(cacheKey);
      if (cached) {
        const age = now - cached.createdAt;
        if (age < CHAT_LIST_CACHE_TTL) {
          return res.json({ ...cached.data, stale: false });
        }
        if (age < CHAT_LIST_CACHE_MAX_AGE) {
          return res.json({ ...cached.data, stale: true });
        }
      }
    }
    // Get all file chats for augmentation lookup (may be empty if no file storage)
    let fileChats: any[] = [];
    try {
      fileChats = chatFileService.getAllChats() || [];
    } catch (err) {
      log.error(`Error reading file chats, continuing with filesystem only: ${err}`);
    }

    // Create lookup map for file data by session ID
    const fileChatsBySessionId = new Map<string, any>();

    for (const chat of fileChats) {
      // Index by session_id
      if (chat?.session_id) {
        fileChatsBySessionId.set(chat.session_id, chat);
      }

      // Also index by session_ids in metadata
      try {
        const meta = JSON.parse(chat?.metadata || "{}");
        if (Array.isArray(meta.session_ids)) {
          for (const sid of meta.session_ids) {
            fileChatsBySessionId.set(sid, chat);
          }
        }
      } catch {}
    }

    // Handle pagination
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;
    const bookmarkedFilter = req.query.bookmarked === "true";
    const excludeTriggered = req.query.excludeTriggered === "true";
    const includeLineage = req.query.includeLineage === "true";
    const cardsOnly = req.query.cardsOnly === "true";

    // Lineage index over file-storage chats — built for the tree view (row
    // pagination + the lineage-append pass below) and for the cards-only
    // filter, which walks it to pull in the descendants of card members.
    // One metadata parse per chat, memoized root resolution.
    const lineageIndex = includeLineage || cardsOnly ? buildLineageIndex(fileChats) : null;

    /**
     * Chat ids the cards-only filter admits: every chat whose lineage root
     * is an OPEN card. Membership is derived from the tree —
     * existingRootIdOf walks parent pointers (and job-step chats' stamped
     * rootChatId) to the highest surviving root, whose own record says whether
     * its card is open or hidden.
     * Hidden cards are omitted too: they opted out of the board, and this
     * view is the board's chat-listing sibling. Null when the filter is off.
     */
    let cardScopedChatIds: Set<string> | null = null;
    if (cardsOnly && lineageIndex) {
      const openRootIds = new Set<string>();
      for (const chat of fileChats) {
        // Only the highest existing eligible ancestor can be a card. Using
        // existingRootIdOf (rather than the sidebar's synthetic dangling row
        // key) promotes surviving descendants after a parent is deleted.
        if (lineageIndex.existingRootIdOf(chat.id) === chat.id && isCardEligible(chat) && !isCardHidden(chat) && cardLifecycleOf(chat) === "open") {
          openRootIds.add(chat.id);
        }
      }
      cardScopedChatIds = new Set<string>();
      for (const chat of fileChats) {
        if (openRootIds.has(lineageIndex.existingRootIdOf(chat.id))) cardScopedChatIds.add(chat.id);
      }
    }

    /**
     * The bookmark verdict, read from the file record — the only place the flag
     * lives. Shared by the two passes that need it (the session-id set below,
     * and the lineage-append guard further down) so a chat cannot be starred
     * for one and unstarred for the other.
     */
    const isBookmarked = (chat: { metadata?: string | null } | undefined): boolean => {
      try {
        return JSON.parse(chat?.metadata || "{}").bookmarked === true;
      } catch {
        return false;
      }
    };

    // Build set of bookmarked session IDs when filtering
    let bookmarkedSessionIds: Set<string> | null = null;
    if (bookmarkedFilter) {
      bookmarkedSessionIds = new Set<string>();
      for (const [sessionId, fileChat] of fileChatsBySessionId) {
        if (isBookmarked(fileChat)) bookmarkedSessionIds.add(sessionId);
      }
    }

    // When filtering by bookmarks or excluding triggered chats, we need to fetch
    // more sessions than requested since we filter after augmentation (the triggered
    // flag lives in chat file metadata). For bookmarks, fetch all. For excludeTriggered,
    // over-fetch to ensure we get enough non-triggered results. includeLineage also
    // needs the full session list so out-of-window tree relatives can be augmented.
    const needsPostFilter = bookmarkedFilter || excludeTriggered || includeLineage || cardsOnly;
    const fetchLimit = needsPostFilter ? 9999 : limit;
    const fetchOffset = needsPostFilter ? 0 : offset;
    const { sessions: discoveredSessions, total: rawTotal } = discoverSessionsPaginated(fetchLimit, fetchOffset);

    // Card membership is decided from the file record alone, so the
    // cards-only filter runs BEFORE augmentation — augmentSession reads the
    // session log for a preview, which is the expensive part. A session with
    // no stored record can't carry membership and is dropped here.
    const paginatedSessions = cardScopedChatIds
      ? discoveredSessions.filter((s) => {
          const fileChat = fileChatsBySessionId.get(s.sessionId);
          return !!fileChat && cardScopedChatIds!.has(fileChat.id);
        })
      : discoveredSessions;

    // Which provider discovered each session log, so a deferred preview read
    // can go straight to its owner. Keyed by path because that is all a
    // finished row still carries by the time the preview is read.
    const providerKindByLogPath = new Map<string, string>();
    for (const s of discoveredSessions) providerKindByLogPath.set(s.filePath, s.providerKind);

    /**
     * Build a response row for a discovered session.
     *
     * Deliberately does no session-log I/O: `needsPostFilter` over-fetches
     * every session (the triggered/bookmarked flags live in chat-file metadata,
     * and lineage/cards need the whole list to walk), so this runs thousands of
     * times per request while ~20 rows are returned. The one expensive part —
     * the first-user-message preview — is split into {@link attachPreview},
     * which runs after filtering *and* pagination.
     */
    const augmentSession = (s: (typeof paginatedSessions)[0]) => {
      // Try to find by session ID (may not exist in file storage - that's fine)
      const fileChat = fileChatsBySessionId.get(s.sessionId);

      // Get cached git info using the original folder (may be a worktree) for correct branch
      const gitInfo = getCachedGitInfo(s.folder);

      if (fileChat) {
        // Augment with file storage data while keeping filesystem as source of truth for timestamps
        return {
          ...fileChat,
          // Keep original folder (may be a worktree) — logs are stored under this path
          folder: s.folder,
          // Resolved main repo path for display/grouping in the UI
          displayFolder: s.displayFolder,
          // Keep filesystem timestamps as they're more accurate for actual activity
          created_at: s.createdAt.toISOString(),
          updated_at: s.updatedAt.toISOString(),
          // Ensure session info from filesystem
          session_id: s.sessionId,
          session_log_path: s.filePath,
          // Add git information
          is_git_repo: gitInfo.isGitRepo,
          git_branch: gitInfo.branch,
          // Merge session_ids in metadata (the preview is folded in later, by
          // attachPreview, for the rows this request actually returns)
          metadata: (() => {
            try {
              const meta = JSON.parse(fileChat.metadata || "{}");
              const sessionIds = Array.isArray(meta.session_ids) ? meta.session_ids : [];
              if (!sessionIds.includes(s.sessionId)) {
                sessionIds.push(s.sessionId);
              }
              return JSON.stringify({ ...meta, session_ids: sessionIds });
            } catch {
              return JSON.stringify({ session_ids: [s.sessionId] });
            }
          })(),
          _augmented_from_file: true,
        };
      } else {
        // No file record found, create from filesystem only - this is normal
        return {
          id: s.sessionId,
          // Keep original folder (may be a worktree)
          folder: s.folder,
          // Resolved main repo path for display/grouping in the UI
          displayFolder: s.displayFolder,
          session_id: s.sessionId,
          session_log_path: s.filePath,
          metadata: JSON.stringify({ session_ids: [s.sessionId] }),
          created_at: s.createdAt.toISOString(),
          updated_at: s.updatedAt.toISOString(),
          // Add git information
          is_git_repo: gitInfo.isGitRepo,
          git_branch: gitInfo.branch,
          _from_filesystem: true,
        };
      }
    };

    /**
     * Fold the session log's first user message into a finished row's metadata
     * — the other half of {@link augmentSession}, and the only part of building
     * a row that opens a session file.
     *
     * Runs on returned rows only. Gated on `session_log_path`, which is set
     * exactly when a row was built from a discovered session: stored chat
     * records always carry `null` there, so the lineage-append pass's bare
     * `{...fileChat}` fallback stays preview-less, as it always has.
     *
     * Nothing in this route filters or sorts on the preview — the post-filters
     * read `metadata.triggered`/`bookmarked`, pagination reads chat ids — so
     * reading it last is a reordering of I/O, not of rows.
     */
    const attachPreview = (chat: any) => {
      const logPath = chat.session_log_path;
      if (typeof logPath !== "string" || !logPath) return chat;
      let meta: any;
      try {
        meta = JSON.parse(chat.metadata || "{}");
      } catch {
        meta = {};
      }
      const preview = getFirstUserMessage(logPath, 200, typeof meta.provider === "string" ? meta.provider : providerKindByLogPath.get(logPath));
      if (!preview) return chat;
      return { ...chat, metadata: JSON.stringify({ ...meta, preview }) };
    };

    /**
     * Is any run at all parked on an approval right now?
     *
     * Read once per request, and the gate on every run-file read below. When
     * nothing is parked — very nearly always — no row can be a representative,
     * so both passes fall through on metadata alone and touch no run files.
     *
     * The map behind this is complete rather than warm: job-runner seeds it at
     * boot from `listResumableRuns`, which returns every non-terminal run. It
     * answers "is anything parked", never "is THIS row the one" — that stays a
     * question for the run file, so a stale entry costs a wasted scan and
     * cannot put the badge on the wrong row.
     */
    const anyApprovalParked = hasParkedApprovals();

    /**
     * Per-request memo of the job runs this response has had to open, keyed by
     * runId. `null` records a run whose file is gone, so a pruned run costs one
     * read and not one per row that still names it.
     *
     * Shared by the triggered-filter carve-out and the needs-you stamp below,
     * in that order: whatever the filter had to resolve, the stamp reuses.
     *
     * Reached only when `anyApprovalParked`. Past that gate it is one read per
     * distinct `jobRunId` among the rows examined, never one per row and never
     * bounded by the size of the run store. How many rows get examined depends
     * on the path, and the wide one is the *default*: `fetchLimit` above jumps
     * to 9999 whenever `needsPostFilter` is set, and `excludeTriggered` alone
     * sets it — so the sidebar's ordinary request examines the whole discovered
     * list, not a page. Only the unfiltered path examines just the page.
     */
    const runCache = new Map<string, { status: string; latestChatId?: string } | null>();
    const resolveRun = (runId: string) => {
      if (!runCache.has(runId)) {
        const run = getRun(runId);
        runCache.set(runId, run ? { status: run.status, latestChatId: latestRunChatId(run) } : null);
      }
      return runCache.get(runId)!;
    };

    /**
     * Is this row the single row that should carry "needs you"?
     *
     * "Waiting on your approval" is a property of the *run*, and a run owns
     * every chat it has ever opened — a step per attempt, a chat per parallel
     * branch, plus the notifier's. Painting all of them would flag a dozen rows
     * for one decision, none of which is more the place to make it than any
     * other, so the run elects one representative and only that row is flagged.
     */
    const isParkedApprovalRow = (chat: any, meta: any): boolean => {
      const runId = typeof meta.jobRunId === "string" ? meta.jobRunId : "";
      if (!runId) return false;
      const run = resolveRun(runId);
      return !!run && run.status === "waiting_approval" && run.latestChatId === chat.id;
    };

    /**
     * Does this row survive the triggered filter?
     *
     * Yes if it is not a triggered chat at all — and yes, too, if it is the one
     * row a job run is waiting on.
     *
     * Every job-step session is spawned with `triggered: true`, and "show
     * triggered chats" is off by default, so without this carve-out the filter
     * would remove precisely the rows the approval badge exists to surface and
     * the signal would be reachable only by users who had opted in. A run
     * parked on your signoff is not background automation, which is the thing
     * the filter is for.
     *
     * Order is untouched: re-admission is a predicate inside the existing
     * single filtering pass, not an append.
     */
    const survivesTriggeredFilter = (chat: any): boolean => {
      let meta: any;
      try {
        meta = JSON.parse(chat.metadata || "{}");
      } catch {
        return true;
      }
      if (meta.triggered !== true) return true;
      if (!anyApprovalParked) return false;
      return isParkedApprovalRow(chat, meta);
    };

    const dropTriggered = (chats: any[]): any[] => chats.filter(survivesTriggeredFilter);

    /**
     * Flag the one row a job run is waiting on — the sidebar's only signal that
     * a run is parked on your approval while you are working somewhere else.
     *
     * Sibling of {@link attachPreview}: computed per response, never stored, so
     * it cannot go stale in a chat record the way a written copy would.
     *
     * Only `jobRunNeedsYou` is stamped, and only on the representative. The
     * run's status is deliberately *not* attached to every job row: no chat-row
     * consumer reads it, and the frontend cannot derive representativeness from
     * it anyway, since no single row can see the others. The identically-named
     * key on the `chat_metadata_updated` stream event is a different payload
     * with a live consumer and is unaffected.
     */
    const attachJobNeedsYou = (chat: any) => {
      if (!anyApprovalParked) return chat;
      let meta: any;
      try {
        // Reachable: the lineage-append pass emits `{...fileChat}` for a
        // relative with no session in the window, and that bypasses the
        // normalisation augmentSession would otherwise have done. Without this
        // catch a single corrupt record 500s the whole chat list.
        meta = JSON.parse(chat.metadata || "{}");
      } catch {
        return chat;
      }
      if (!isParkedApprovalRow(chat, meta)) return chat;
      return { ...chat, metadata: JSON.stringify({ ...meta, jobRunNeedsYou: true }) };
    };

    /**
     * Slice a recency-ordered, already-filtered list into the requested
     * page. Without includeLineage, limit/offset count chats. With
     * includeLineage they count sidebar tree ROWS: chats sharing a
     * parentage root fold into one row, so a page always contributes
     * `limit` visible rows no matter how many chats fold together.
     *
     * Gated on includeLineage, not on the index existing: the cards-only
     * filter builds the same index for its descendant walk, and folding rows
     * for a request that did not ask for lineage would silently drop chats
     * from the page. The sidebar always asks; other API clients need not.
     */
    const paginateWindow = <T>(items: T[], chatIdOf: (item: T) => string): { page: T[]; total: number; windowRows: number } => {
      if (!includeLineage || !lineageIndex) {
        const page = items.slice(offset, offset + limit);
        return { page, total: items.length, windowRows: page.length };
      }
      // Multiple sessions can map to one chat (resume/compaction appends
      // to metadata.session_ids) — keep only the most recent so a folded
      // row can't emit duplicate chat entries (the tree view would render
      // a lineage-less chat as a phantom expandable group).
      const seenIds = new Set<string>();
      const unique = items.filter((item) => {
        const id = chatIdOf(item);
        if (seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });
      return paginateTreeRows(unique, (item) => lineageIndex.rootKeyOf(chatIdOf(item)), limit, offset);
    };

    let chatsFromLogs;
    let total: number;
    let windowRows: number;

    if (bookmarkedFilter && bookmarkedSessionIds) {
      // Filter to only bookmarked sessions, then augment and paginate
      const bookmarkedSessions = paginatedSessions.filter((s) => bookmarkedSessionIds!.has(s.sessionId));
      let augmented = bookmarkedSessions.map(augmentSession);
      if (excludeTriggered) {
        augmented = dropTriggered(augmented);
      }
      ({ page: chatsFromLogs, total, windowRows } = paginateWindow(augmented, (c) => c.id));
    } else if (excludeTriggered) {
      // Augment all fetched sessions, drop triggered chats, then paginate —
      // so the window is filled from what's left.
      const augmented = dropTriggered(paginatedSessions.map(augmentSession));
      ({ page: chatsFromLogs, total, windowRows } = paginateWindow(augmented, (c) => c.id));
    } else if (includeLineage || cardsOnly) {
      // Sessions were over-fetched (for lineage lookup, or so the cards-only
      // filter could run across the whole list) — paginate manually, by row
      // for the tree view, augmenting only the windowed sessions.
      const window = paginateWindow(paginatedSessions, (s) => fileChatsBySessionId.get(s.sessionId)?.id ?? s.sessionId);
      chatsFromLogs = window.page.map(augmentSession);
      ({ total, windowRows } = window);
    } else {
      // Normal path: sessions are already paginated
      chatsFromLogs = paginatedSessions.map(augmentSession);
      total = rawTotal;
      windowRows = chatsFromLogs.length;
    }
    const hasMore = offset + limit < total;

    // When the page touches a parentage tree, append the tree's remaining
    // members (ancestors and descendants outside the pagination window) so
    // the sidebar tree view can group and expand reliably. Appended chats
    // are flagged and do not count toward pagination.
    if (includeLineage && lineageIndex && fileChats.length > 0) {
      const { byId: fileById, childrenByParent, parentIdOf, rootKeyOf } = lineageIndex;

      // Union of full tree memberships (root + all descendants) for every
      // paged chat that participates in a lineage tree. rootKeyOf may
      // return a deleted ancestor's id — the traversal still reaches every
      // existing member through childrenByParent, and the append loop
      // below skips ids without a file record.
      const relatedIds = new Set<string>();
      for (const chat of chatsFromLogs) {
        if (!fileById.has(chat.id)) continue;
        if (!parentIdOf(chat.id) && !childrenByParent.has(chat.id)) continue;
        const stack = [rootKeyOf(chat.id)];
        while (stack.length > 0) {
          const currentId = stack.pop()!;
          if (relatedIds.has(currentId)) continue;
          relatedIds.add(currentId);
          for (const child of childrenByParent.get(currentId) || []) stack.push(child.id);
        }
      }

      // Most recent session per file chat id, for augmenting appended relatives
      const sessionByChatId = new Map<string, (typeof paginatedSessions)[0]>();
      for (const s of paginatedSessions) {
        const fileChat = fileChatsBySessionId.get(s.sessionId);
        if (fileChat && !sessionByChatId.has(fileChat.id)) sessionByChatId.set(fileChat.id, s);
      }

      const pageIds = new Set(chatsFromLogs.map((c: any) => c.id));
      const appended: any[] = [];
      for (const id of relatedIds) {
        if (pageIds.has(id)) continue;
        // An ancestor on a closed card (or no card) is outside the cards-only
        // view — appending it would smuggle back exactly what the filter drops.
        if (cardScopedChatIds && !cardScopedChatIds.has(id)) continue;
        const fc = fileById.get(id);
        if (!fc) continue;
        // Same rule the cards-only guard above states, applied to the other
        // scope filter: appending an unstarred relative would smuggle back
        // exactly what "Bookmarked only" drops. It costs nothing to expansion —
        // opening a group fetches the authoritative tree from
        // GET /chats/:id/tree, which no list filter has ever narrowed — but it
        // keeps the tally honest, because the section headers count the chats
        // the list returned and would otherwise count relatives no row shows.
        if (bookmarkedFilter && !isBookmarked(fc)) continue;
        const session = sessionByChatId.get(id);
        // This is the one path in the list route that can emit a chat
        // filesystem discovery did not return, so it is also the one that has
        // to re-apply discovery's verdict. A chat on a removed harness has a
        // record but no readable session — appending it would put a row in the
        // sidebar that renders as live and opens to an empty transcript. Its
        // surviving descendants are discovery-backed and stay; they simply fold
        // under a dangling root, which is the deleted-parent case rootKeyOf and
        // the client's lineageOf already agree on.
        if (isRetiredProvider(readProvider(fc))) continue;
        // Chats without a session log yet (e.g. freshly spawned) fall back
        // to the bare file record — the `else` here, and now the ordinary case:
        // every scope filter above re-guards, and paginateTreeRows never splits
        // a group across a page boundary, so a discovery-backed relative is
        // normally already ON the page rather than appended to it.
        //
        // The `if` is NOT dead, and is not merely defensive. rootKeyOf caps its
        // ascent at MAX_LINEAGE_DEPTH while the relatedIds descent below is
        // uncapped, so an unstamped chain (parentChatId/forkedFrom with no
        // rootChatId) longer than that cap keys its deep members on a different
        // row from its shallow ones. Those members are then genuinely off-page
        // AND discovery-backed. It is the corrupt-chain case the cap exists to
        // bound — do not delete this branch as unreachable.
        const augmented = session ? augmentSession(session) : { ...fc, displayFolder: fc.folder };
        if (excludeTriggered && !survivesTriggeredFilter(augmented)) continue;
        appended.push({ ...augmented, _lineage_appended: true });
      }
      chatsFromLogs = [...chatsFromLogs, ...appended];
    }

    // Last step, once the returned set is final: one preview read per row that
    // ships, instead of one per session discovered.
    chatsFromLogs = chatsFromLogs.map((chat: any) => attachJobNeedsYou(attachPreview(chat)));

    const responseData = { chats: chatsFromLogs, hasMore, total, windowRows };
    chatListCache.set(cacheKey, { data: responseData, createdAt: Date.now() });
    res.json({ ...responseData, stale: false });
  } catch (err: any) {
    log.error(`Error listing chats: ${err}`);
    res.status(500).json({ error: "Failed to list chats", details: err.message });
  }
});

// Get folder info for new chat (without creating a chat)
chatsRouter.get("/new/info", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Get folder info for new chat'
  // #swagger.description = 'Returns git info, slash commands, and plugins available for a given folder — used before creating a new chat.'
  /* #swagger.parameters['folder'] = { in: 'query', type: 'string', required: true, description: 'Absolute path to the project folder' } */
  /* #swagger.responses[200] = { description: "Folder info with git status, slash commands, and plugins" } */
  /* #swagger.responses[400] = { description: "Missing or invalid folder" } */
  const folder = req.query.folder as string;
  if (!folder) return res.status(400).json({ error: "folder query param is required" });

  // Check if folder exists
  if (!existsSync(folder)) {
    return res.status(400).json({ error: "folder does not exist" });
  }

  // Always fetch fresh git info for new chats so the branch is up-to-date
  let gitInfo: { isGitRepo: boolean; branch?: string } = { isGitRepo: false };
  try {
    gitInfo = getGitInfo(folder);
  } catch {}

  // Resolve worktree to get main repo path — through the same projection the
  // sidebar row uses, so the two cannot disagree about one directory.
  const view = viewForDirectory(folder, buildWorkspaceIndex());
  const isWorktree = view.isWorktree;
  const mainRepoPath = view.repoPath ?? folder;

  // Get slash commands and plugins for the folder
  let slashCommands: any[] = [];
  let plugins: any[] = [];
  try {
    const result = getCommandsAndPluginsForDirectory(folder);
    slashCommands = result.slashCommands;
    plugins = result.plugins;
  } catch {}

  // Get app-wide plugins
  let appPluginsData;
  try {
    appPluginsData = getAllAppPluginsData();
  } catch {
    appPluginsData = { scanRoots: [], plugins: [], mcpServers: [] };
  }

  res.json({
    folder,
    displayFolder: mainRepoPath,
    is_git_repo: gitInfo.isGitRepo,
    is_worktree: isWorktree,
    git_branch: gitInfo.branch,
    slash_commands: slashCommands,
    plugins: plugins,
    appPlugins: appPluginsData,
  });
});

// Create a chat (only when sessionId is known - for resuming sessions)
chatsRouter.post("/", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Create a chat'
  // #swagger.description = 'Create a chat record for an existing session ID. Used when resuming sessions that need file storage records.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["folder", "sessionId"],
          properties: {
            folder: { type: "string", description: "Absolute path to the project folder" },
            sessionId: { type: "string", description: "Existing Claude session ID" },
            defaultPermissions: { type: "object", description: "Default tool permissions for the session" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[201] = { description: "Chat created" } */
  /* #swagger.responses[400] = { description: "Missing required fields" } */
  const { folder, sessionId, defaultPermissions } = req.body;
  if (!folder) return res.status(400).json({ error: "folder is required" });
  if (!sessionId) return res.status(400).json({ error: "sessionId is required" });

  // Create metadata with default permissions if provided
  const metadata = {
    ...(defaultPermissions && { defaultPermissions }),
  };

  // Get cached git info for the folder
  const gitInfo = getCachedGitInfo(folder);

  // Get slash commands and plugins for the folder
  let slashCommands: any[] = [];
  let plugins: any[] = [];
  try {
    const result = getCommandsAndPluginsForDirectory(folder);
    slashCommands = result.slashCommands;
    plugins = result.plugins;
  } catch {}

  try {
    const chat = chatFileService.createChat(folder, sessionId, JSON.stringify(metadata));
    clearListCaches();
    res.status(201).json({
      ...chat,
      is_git_repo: gitInfo.isGitRepo,
      git_branch: gitInfo.branch,
      slash_commands: slashCommands,
      plugins: plugins,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Fork a chat: copy session history up to a message into a new chat
chatsRouter.post("/:id/fork", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Fork a chat'
  // #swagger.description = 'Create a new chat whose session history is a copy of this chat up to and including the message at the given timestamp. The forked chat is not auto-started — the user sends the next message. The fork inherits the original chat's card membership through the parentage tree (its root). Pass `provider` to hand the conversation to a different harness: the history is translated into that harness native session format, with tool calls flattened to text summaries.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID or session ID' } */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["timestamp"],
          properties: {
            timestamp: { type: "string", description: "ISO timestamp of the message to fork at (history up to and including it is copied)" },
            provider: { type: "string", enum: ["claude-code", "codex", "cline", "pi"], description: "Target harness. Omit to fork within the current harness of the chat (higher fidelity). Every routable kind except acp - see the route implementation for why acp is refused." },
            model: { type: "string", description: "Model for the new chat. Required-ish on a harness switch, where the source model id is meaningless to the target." },
            effort: { type: "string", description: "Reasoning effort for the new chat (codex only)." }
          }
        }
      }
    }
  } */
  /* #swagger.responses[201] = { description: "Forked chat created" } */
  /* #swagger.responses[400] = { description: "Missing timestamp or provider does not support forking" } */
  /* #swagger.responses[404] = { description: "Chat not found" } */
  const { timestamp } = req.body;
  if (!timestamp || typeof timestamp !== "string") {
    return res.status(400).json({ error: "timestamp is required" });
  }

  const chat = findChat(req.params.id, false) as any;
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  let meta: Record<string, any> = {};
  try {
    meta = JSON.parse(chat.metadata || "{}");
  } catch {}

  // Chats stamped with a removed harness are refused by name before the guard
  // below can silently call them claude-code chats — 155 records name the
  // OpenRouter one, and the fallback would send the fork looking for a session
  // log nothing can read. An explicit 400 beats a fork that appears to work.
  if (isRetiredProvider(meta.provider)) {
    return res.status(400).json({ error: "This chat ran on the OpenRouter agent harness, which has been removed. It cannot be forked." });
  }

  // The SOURCE kind comes off persisted metadata, so it is read with the
  // internal guard rather than the routable one: a kind that is implemented but
  // not yet offered must still be forkable out of.
  const providerKind: InternalProviderKind = isInternalProvider(meta.provider) ? meta.provider : "claude-code";
  const provider = getSessionProviders().find((p) => p.kind === providerKind);
  if (!provider) {
    return res.status(400).json({ error: "Forking is not supported for this chat's provider" });
  }

  // Target harness. Omitted (the common case) means "same harness", which
  // keeps the high-fidelity same-provider fork path below.
  if (req.body.provider !== undefined && !isRoutableProvider(req.body.provider)) {
    return res.status(400).json({ error: `Unknown target provider "${req.body.provider}"` });
  }
  const targetKind: InternalProviderKind = isRoutableProvider(req.body.provider) ? req.body.provider : providerKind;
  // Forking INTO ACP is refused on the kind itself, and this guard is the
  // route's own invariant rather than a consequence of some provider's missing
  // method. Two independent reasons, either one sufficient:
  //
  //  1. `"acp"` names a wire format, not a harness. The vendor rides in
  //     `acpProviderId`, which this route does not accept, so a fork here could
  //     only stamp a chat with a kind and no vendor — permanently unrunnable.
  //  2. Even given a vendor it could not work. ACP session state lives inside
  //     the agent's process, and the protocol gives a client no way to hand an
  //     agent a conversation it did not have; a seeded transcript would render
  //     correctly and lose every bit of context on the next message.
  //
  // `AcpSessionProvider` implements neither `forkSession` nor `seedSession`
  // today, which would also produce a 400 — but that is its decision to revisit,
  // and while `"acp"` was outside `ROUTABLE_PROVIDER_KINDS` the allowlist was
  // the real guard. Now that a request may name the kind, the guard has to live
  // here, or adding a transcript-seeding method later would silently start
  // minting wedged chats.
  if (targetKind === "acp") {
    return res.status(400).json({ error: `Forking into ${providerLabel("acp")} is not supported` });
  }
  const targetProvider = getSessionProviders().find((p) => p.kind === targetKind);
  if (!targetProvider) {
    return res.status(400).json({ error: `Forking into ${providerLabel(targetKind)} is not supported` });
  }
  const isHandoff = targetKind !== providerKind;

  const sessionIds: string[] = meta.session_ids || [];
  if (!sessionIds.includes(chat.session_id)) sessionIds.push(chat.session_id);

  const newSessionId = randomUUID();
  let forked: { logPath: string } | null = null;
  try {
    if (!isHandoff && provider.forkSession) {
      // Same harness: copy the native session log. Preserves everything the
      // engine wrote — real tool_use blocks, reasoning, ids — which the
      // neutral turn projection below necessarily drops.
      forked = provider.forkSession(sessionIds, timestamp, newSessionId);
    } else if (targetProvider.seedSession) {
      // Cross-harness (or a same-harness provider with no native fork): read
      // the history through the SOURCE provider's parser, then write it into
      // the TARGET's native format as conversational turns.
      const history = truncateAtCutoff(provider.parseSessionMessages(sessionIds), timestamp);
      const turns = buildHandoffTurns(history, providerKind, targetKind);
      forked = turns.length > 0 ? targetProvider.seedSession(turns, { folder: chat.folder, newSessionId }) : null;
    } else {
      return res.status(400).json({ error: `Forking into ${providerLabel(targetKind)} is not supported` });
    }
  } catch (error) {
    log.error(`Failed to fork session (${providerKind} → ${targetKind}): ${error}`);
  }
  if (!forked) {
    return res.status(400).json({ error: "Could not fork: no messages found at or before the fork point" });
  }

  // Title the fork off the original's title, falling back to its first-
  // user-message preview so the fork is distinguishable in the chat list.
  let baseTitle: string | null = meta.title || null;
  if (!baseTitle && chat.session_log_path) {
    baseTitle = provider.getSessionPreview(chat.session_log_path, 60);
  }
  baseTitle = baseTitle ? baseTitle.replace(/\s+/g, " ").trim() : null;

  // Model / effort for the new chat. A handoff cannot inherit the source's:
  // model ids and effort scales are per-harness ("claude-opus-5" means
  // nothing to Codex), so on a switch they come from the request or are left
  // unset for the target's defaults. Same-harness forks inherit as before.
  const requestedModel = typeof req.body.model === "string" && req.body.model.trim() ? req.body.model.trim() : undefined;
  const requestedEffort = typeof req.body.effort === "string" && req.body.effort.trim() ? req.body.effort.trim() : undefined;
  const model = requestedModel ?? (isHandoff ? undefined : meta.model);
  const effort = requestedEffort ?? (isHandoff ? undefined : meta.effort);

  const forkMeta = {
    session_ids: [newSessionId],
    title: baseTitle
      ? isHandoff
        ? `→ ${providerLabel(targetKind)}: ${baseTitle}`
        : `Fork: ${baseTitle}`
      : isHandoff
        ? `→ ${providerLabel(targetKind)}`
        : "Fork",
    // Legacy parent pointer (kept for compat) plus the parentage-tree
    // fields — the fork becomes a child of the original in the chat tree.
    forkedFrom: chat.id,
    parentChatId: chat.id,
    // Resolve rather than trusting a possibly stale/legacy stamp: deleting an
    // ancestor promotes the highest surviving chat, and old forkedFrom-only
    // chains may never have carried rootChatId at all.
    rootChatId: walkToRootId(chat.id),
    chatRole: isHandoff ? "engine-switch" : "fork",
    // Pin the target harness for the new chat's lifetime, mirroring
    // sendMessage's convention of omitting the "claude-code" default rather
    // than writing it (an explicit value there is redundant, and resolving an
    // absent provider already lands on claude-code).
    ...(targetKind !== "claude-code" && { provider: targetKind }),
    // Effort is meaningful only to the reasoning-capable harnesses.
    ...(effort && targetKind === "codex" && { effort }),
    // Model is honored by all three: `stream.ts` persists `metadata.model`
    // for any provider, and each harness's config block reads it (Codex's
    // per-chat override wins over the global codexModel default). Note
    // sendMessage's *new-chat* block guards which kinds may carry a model —
    // that guard doesn't apply here, since this route writes metadata itself.
    ...(model && { model }),
    // No card field is inherited: the fork is a child in the parentage tree
    // (parentChatId/rootChatId above), so its card membership — the root's
    // card — is derived from the tree by every reader.
    ...(meta.defaultPermissions && { defaultPermissions: meta.defaultPermissions }),
    ...(meta.agentAlias && { agentAlias: meta.agentAlias }),
    ...(meta.lastBranch && { lastBranch: meta.lastBranch }),
  };

  try {
    // The fork runs in the original's folder, so it belongs to the original's
    // workspace too. `workspaceId` is a top-level Chat field, not metadata, so
    // it is inherited here rather than in forkMeta above — without it a fork
    // of a worktree chat would be missing from the set Phase 2's archive
    // cascade interrupts when that directory is removed underneath it.
    const newChat = chatFileService.createChat(chat.folder, newSessionId, JSON.stringify(forkMeta), chat.workspaceId);
    clearListCaches();
    res.status(201).json(newChat);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get the parentage tree for a chat (ancestors + full descendant tree)
chatsRouter.get("/:id/tree", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Get the chat parentage tree'
  // #swagger.description = 'Returns the ancestors of this chat and the full tree of related chats spawned from the same root, across all engines. Nodes include chatId, title, role, provider, status, and folder.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID or session ID' } */
  /* #swagger.responses[200] = { description: "ChatTreeResponse: { targetChatId, rootChatId, ancestors, tree }" } */
  /* #swagger.responses[404] = { description: "Chat not found or has no stored record" } */
  try {
    const chat = findChat(req.params.id, false);
    const result = buildChatTree(chat?.id ?? req.params.id);
    if (!result) {
      return res.status(404).json({ error: "Chat not found or has no stored record" });
    }
    res.json(result);
  } catch (err: any) {
    log.error(`Error building chat tree for ${req.params.id}: ${err}`);
    res.status(500).json({ error: "Failed to build chat tree", details: err.message });
  }
});

// Toggle bookmark on a chat
chatsRouter.patch("/:id/bookmark", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Toggle bookmark on a chat'
  // #swagger.description = 'Set or unset the bookmarked flag in chat metadata. Creates a file storage record if the chat only exists on the filesystem.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID or session ID' } */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["bookmarked"],
          properties: {
            bookmarked: { type: "boolean", description: "Whether the chat should be bookmarked" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Updated chat" } */
  /* #swagger.responses[400] = { description: "Invalid request body" } */
  /* #swagger.responses[404] = { description: "Chat not found" } */
  const { bookmarked } = req.body;
  if (typeof bookmarked !== "boolean") {
    return res.status(400).json({ error: "bookmarked must be a boolean" });
  }

  try {
    const chat = findChat(req.params.id, false) as any;
    if (!chat) return res.status(404).json({ error: "Chat not found" });

    // Parse existing metadata and update bookmarked flag
    let meta: Record<string, any> = {};
    try {
      meta = JSON.parse(chat.metadata || "{}");
    } catch {}

    meta.bookmarked = bookmarked;
    const updatedMetadata = JSON.stringify(meta);

    // Upsert: creates file storage record if it only existed on filesystem
    const updatedChat = chatFileService.upsertChat(chat.id, chat.folder, chat.session_id, { metadata: updatedMetadata });

    clearListCaches();
    res.json(updatedChat);
  } catch (err: any) {
    log.error(`Error toggling bookmark: ${err}`);
    res.status(500).json({ error: "Failed to toggle bookmark", details: err.message });
  }
});

// Update default permissions on a chat
chatsRouter.patch("/:id/permissions", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Update chat permissions'
  // #swagger.description = 'Update the default tool permissions for a chat. Changes take effect immediately for future tool use checks.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID or session ID' } */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["defaultPermissions"],
          properties: {
            defaultPermissions: {
              type: "object",
              required: ["fileRead", "fileWrite", "codeExecution", "webAccess"],
              properties: {
                fileRead: { type: "string", enum: ["allow", "ask", "deny"] },
                fileWrite: { type: "string", enum: ["allow", "ask", "deny"] },
                codeExecution: { type: "string", enum: ["allow", "ask", "deny"] },
                webAccess: { type: "string", enum: ["allow", "ask", "deny"] }
              }
            }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Updated chat" } */
  /* #swagger.responses[400] = { description: "Invalid request body" } */
  /* #swagger.responses[404] = { description: "Chat not found" } */
  const { defaultPermissions } = req.body;
  if (!defaultPermissions || typeof defaultPermissions !== "object") {
    return res.status(400).json({ error: "defaultPermissions must be an object" });
  }

  const validLevels = ["allow", "ask", "deny"];
  const requiredKeys = ["fileRead", "fileWrite", "codeExecution", "webAccess"];
  for (const key of requiredKeys) {
    if (!validLevels.includes(defaultPermissions[key])) {
      return res.status(400).json({ error: `${key} must be one of: allow, ask, deny` });
    }
  }

  try {
    const chat = findChat(req.params.id, false) as any;
    if (!chat) return res.status(404).json({ error: "Chat not found" });

    // Parse existing metadata and update permissions
    let meta: Record<string, any> = {};
    try {
      meta = JSON.parse(chat.metadata || "{}");
    } catch {}

    meta.defaultPermissions = defaultPermissions;
    const updatedMetadata = JSON.stringify(meta);

    // Upsert: creates file storage record if it only existed on filesystem
    const updatedChat = chatFileService.upsertChat(chat.id, chat.folder, chat.session_id, { metadata: updatedMetadata });

    clearListCaches();
    res.json(updatedChat);
  } catch (err: any) {
    log.error(`Error updating permissions: ${err}`);
    res.status(500).json({ error: "Failed to update permissions", details: err.message });
  }
});

// Mark a chat as read (set lastReadAt timestamp in metadata)
chatsRouter.patch("/:id/read", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Mark a chat as read'
  // #swagger.description = 'Sets lastReadAt in chat metadata to the current time. Creates a file storage record if the chat only exists on the filesystem.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID or session ID' } */
  /* #swagger.responses[200] = { description: "Updated chat" } */
  /* #swagger.responses[404] = { description: "Chat not found" } */
  try {
    const chat = findChat(req.params.id, false) as any;
    if (!chat) return res.status(404).json({ error: "Chat not found" });

    // Parse existing metadata and set lastReadAt
    let meta: Record<string, any> = {};
    try {
      meta = JSON.parse(chat.metadata || "{}");
    } catch {}

    meta.lastReadAt = new Date().toISOString();
    const updatedMetadata = JSON.stringify(meta);

    // Upsert: creates file storage record if it only existed on filesystem
    const updatedChat = chatFileService.upsertChat(chat.id, chat.folder, chat.session_id, { metadata: updatedMetadata });

    clearListCaches();
    res.json(updatedChat);
  } catch (err: any) {
    log.error(`Error marking chat as read: ${err}`);
    res.status(500).json({ error: "Failed to mark chat as read", details: err.message });
  }
});

// (The old PATCH /:id/card assign/unassign endpoint is gone: card
// membership is lineage, derived from the parentage tree, so there is
// nothing to assign. Board membership edits go through PATCH /api/cards/:id
// — the id is the root chat.)

// Dismiss a summon on a chat
chatsRouter.patch("/:id/summon", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Dismiss a summon on a chat'
  // #swagger.description = 'Clear the summon notification from chat metadata.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID or session ID' } */
  /* #swagger.responses[200] = { description: "Updated chat" } */
  /* #swagger.responses[404] = { description: "Chat not found" } */
  try {
    const chat = findChat(req.params.id, false) as any;
    if (!chat) return res.status(404).json({ error: "Chat not found" });

    // Parse existing metadata and clear summon
    let meta: Record<string, any> = {};
    try {
      meta = JSON.parse(chat.metadata || "{}");
    } catch {}

    meta.summon = null;
    const updatedMetadata = JSON.stringify(meta);

    const updatedChat = chatFileService.upsertChat(chat.id, chat.folder, chat.session_id, { metadata: updatedMetadata });

    clearListCaches();

    // Clear summon from registry and notify metadata change
    sessionRegistry.clearSummon(chat.id);
    sessionRegistry.notifyMetadata(chat.id, { summon: null });

    res.json(updatedChat);
  } catch (err: any) {
    log.error(`Error dismissing summon: ${err}`);
    res.status(500).json({ error: "Failed to dismiss summon", details: err.message });
  }
});

// Delete a chat (deletes both file storage metadata and native session files)
chatsRouter.delete("/:id", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Delete a chat'
  // #swagger.description = 'Delete a chat from file storage and its session log from the provider\'s native storage.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID or session ID' } */
  /* #swagger.responses[200] = { description: "Chat deleted" } */
  try {
    // Find the chat (checks file storage + filesystem)
    const chat = findChat(req.params.id, false);

    // Delete the JSON metadata file from /data/chats/ if it exists
    const fileChat = chatFileService.getChat(req.params.id);
    if (fileChat) {
      chatFileService.deleteChat(fileChat.session_id);
    }

    // Delete native session files via the session provider
    const sessionId = chat?.session_id || req.params.id;
    for (const provider of getSessionProviders()) {
      provider.deleteSessionFiles(sessionId);
    }

    clearListCaches();
    // A chat is now also board state: deleting a root removes a card, and
    // deleting any member changes its rollup. Wake board/sidebar clients now
    // rather than leaving them stale until the 15-second safety poll.
    sessionRegistry.notifyMetadata(fileChat?.id ?? req.params.id, { cardEvent: "updated" });
    res.json({ ok: true });
  } catch (err: any) {
    log.error(`Error deleting chat: ${err}`);
    res.status(500).json({ error: "Failed to delete chat", details: err.message });
  }
});

// Get a single chat
chatsRouter.get("/:id", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Get a single chat'
  // #swagger.description = 'Retrieve a chat by ID from file storage or filesystem, including slash commands and plugins for the folder.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID or session ID' } */
  /* #swagger.responses[200] = { description: "Chat details with slash commands and plugins" } */
  /* #swagger.responses[404] = { description: "Chat not found" } */
  const chat = findChat(req.params.id) as any;
  if (!chat) return res.status(404).json({ error: "Not found" });

  // Include slash commands and plugins for the chat's folder
  let slashCommands: any[] = [];
  let plugins: any[] = [];
  try {
    if (chat.folder) {
      const result = getCommandsAndPluginsForDirectory(chat.folder);
      slashCommands = result.slashCommands;
      plugins = result.plugins;
    }
  } catch {}

  // Get app-wide plugins
  let appPluginsData;
  try {
    appPluginsData = getAllAppPluginsData();
  } catch {
    appPluginsData = { scanRoots: [], plugins: [], mcpServers: [] };
  }

  res.json({
    ...chat,
    slash_commands: slashCommands,
    plugins: plugins,
    appPlugins: appPluginsData,
  });
});

// Get messages from SDK session JSONL files (all sessions for this chat)
chatsRouter.get("/:id/messages", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Get chat messages'
  // #swagger.description = 'Returns parsed messages from all session files associated with this chat. Includes text, thinking, tool_use, and tool_result blocks.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID or session ID' } */
  /* #swagger.responses[200] = { description: "Array of parsed messages" } */
  /* #swagger.responses[404] = { description: "Chat not found" } */
  const chat = findChat(req.params.id) as any;
  if (!chat) return res.status(404).json({ error: "Not found" });
  if (!chat.session_id) return res.json([]);

  // Collect all session IDs from metadata + current
  const meta = JSON.parse(chat.metadata || "{}");
  const sessionIds: string[] = meta.session_ids || [];
  if (!sessionIds.includes(chat.session_id)) sessionIds.push(chat.session_id);

  // Determine which provider to use (from metadata, default to claude-code)
  const providerKind = meta.provider || "claude-code";
  const provider = getSessionProviders().find((p) => p.kind === providerKind) || getSessionProviders()[0];

  // Delegate full message parsing (including subagent merging) to the provider
  const allMessages = provider.parseSessionMessages(sessionIds);
  res.json(allMessages);
});

// Get slash commands and plugins for a chat
chatsRouter.get("/:id/slash-commands", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Get slash commands and plugins'
  // #swagger.description = 'Returns available slash commands, plugins, and all commands (including active plugin commands) for the chat folder.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID or session ID' } */
  /* #swagger.parameters['activePlugins'] = { in: 'query', type: 'array', items: { type: 'string' }, description: 'Active plugin IDs to include commands from' } */
  /* #swagger.responses[200] = { description: "Slash commands, plugins, and allCommands arrays" } */
  /* #swagger.responses[404] = { description: "Chat not found" } */
  const chat = findChat(req.params.id) as any;
  if (!chat) return res.status(404).json({ error: "Not found" });

  try {
    const result = getCommandsAndPluginsForDirectory(chat.folder);

    // Check if activePlugins query param is provided
    const activePluginIds = req.query.activePlugins
      ? Array.isArray(req.query.activePlugins)
        ? (req.query.activePlugins as string[])
        : [req.query.activePlugins as string]
      : [];

    // Get all commands including active plugin commands
    const allCommands = getAllCommandsForDirectory(chat.folder, activePluginIds);

    // Get app-wide plugins
    let appPluginsData;
    try {
      appPluginsData = getAllAppPluginsData();
    } catch {
      appPluginsData = { scanRoots: [], plugins: [], mcpServers: [] };
    }

    res.json({
      slashCommands: result.slashCommands,
      plugins: result.plugins,
      allCommands,
      appPlugins: appPluginsData,
    });
  } catch (error) {
    log.error(`Failed to get slash commands and plugins: ${error}`);
    res.json({ slashCommands: [], plugins: [], allCommands: [], appPlugins: { scanRoots: [], plugins: [], mcpServers: [] } });
  }
});

/**
 * Body of one slash command, resolved lazily.
 *
 * The composer chips a command the moment it is picked but fetches nothing;
 * these routes are what a chip's popover calls the first time it is opened,
 * which for most chips is never. That is the whole reason the body is not
 * folded into `GET /:id/slash-commands` — it would turn one cheap listing into
 * N file reads per composer mount.
 *
 * The name arrives as a QUERY parameter, not a path segment, because command
 * names contain colons (`callboard:foo`, `deep-research:investigate`).
 *
 * There are two doors because the composer has two lives. On an existing chat
 * the folder comes from the chat record; on `/chat/new` there is no chat yet
 * and the folder is the one the user picked — the same trade `/new/info` above
 * already makes, and the same pseudo-id (`/new/…`) it already claims. Both
 * doors call one resolver in slashCommands.ts, so the name gate cannot drift
 * apart between them.
 *
 * `null` back from the resolver means the string could not be a command name at
 * all → 400. Anything else is 200, including the built-in case with no body.
 */
function parseActivePlugins(req: Request): string[] {
  const raw = req.query.activePlugins;
  if (!raw) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === "string");
}

// Registered ahead of the `/:id/` variant below: `new` would otherwise be
// swallowed as a chat id, the same way `/new/info` has to precede `/:id`.
chatsRouter.get("/new/slash-commands/content", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Get the body of one slash command, by folder'
  // #swagger.description = 'Same as the per-chat route, for the new-chat composer, which has no chat id yet.'
  /* #swagger.parameters['folder'] = { in: 'query', required: true, type: 'string', description: 'Absolute path to the project folder' } */
  /* #swagger.parameters['name'] = { in: 'query', required: true, type: 'string', description: 'Full command name, e.g. callboard:my-skill' } */
  /* #swagger.parameters['activePlugins'] = { in: 'query', type: 'array', items: { type: 'string' }, description: 'Active per-directory plugin ids' } */
  /* #swagger.responses[200] = { description: "{ name, source, description, content }" } */
  /* #swagger.responses[400] = { description: "Missing folder, or missing/unusable command name" } */
  const folder = typeof req.query.folder === "string" ? req.query.folder : "";
  if (!folder) return res.status(400).json({ error: "folder query param is required" });
  if (!existsSync(folder)) return res.status(400).json({ error: "folder does not exist" });

  const name = typeof req.query.name === "string" ? req.query.name : "";
  if (!name) return res.status(400).json({ error: "name query parameter is required" });

  const result = resolveSlashCommandContent(folder, name, parseActivePlugins(req));
  if (!result) return res.status(400).json({ error: "Invalid command name" });
  res.json(result);
});

chatsRouter.get("/:id/slash-commands/content", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Get the body of one slash command'
  // #swagger.description = 'Returns the full markdown content behind a slash command (custom skill or plugin command). Harness built-ins resolve with content: null.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID or session ID' } */
  /* #swagger.parameters['name'] = { in: 'query', required: true, type: 'string', description: 'Full command name, e.g. callboard:my-skill' } */
  /* #swagger.parameters['activePlugins'] = { in: 'query', type: 'array', items: { type: 'string' }, description: 'Active per-directory plugin ids' } */
  /* #swagger.responses[200] = { description: "{ name, source, description, content }" } */
  /* #swagger.responses[400] = { description: "Missing or unusable command name" } */
  /* #swagger.responses[404] = { description: "Chat not found" } */
  const chat = findChat(req.params.id) as any;
  if (!chat) return res.status(404).json({ error: "Not found" });

  const name = typeof req.query.name === "string" ? req.query.name : "";
  if (!name) return res.status(400).json({ error: "name query parameter is required" });

  const result = resolveSlashCommandContent(chat.folder, name, parseActivePlugins(req));
  if (!result) return res.status(400).json({ error: "Invalid command name" });
  res.json(result);
});

// Session parsing functions have been extracted to
// agents/adapters/claude-code/sessionParser.ts and are accessed
// through the SessionProvider interface.
