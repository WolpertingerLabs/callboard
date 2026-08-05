import { Router } from "express";
import { existsSync } from "fs";
import { randomUUID } from "node:crypto";
import { chatFileService } from "../services/chat-file-service.js";
import { getCommandsAndPluginsForDirectory, getAllCommandsForDirectory } from "../services/slashCommands.js";
import { getAllAppPluginsData } from "../services/app-plugins.js";
import { getGitInfo } from "../utils/git.js";
import { findChat } from "../utils/chat-lookup.js";
import { hasPendingRequest } from "../services/claude.js";
import { buildChatTree, buildLineageIndex, paginateTreeRows } from "../services/chat-lineage.js";
import { getCard } from "../services/card-store.js";
import { setChatCardMembership } from "../services/card-membership.js";
import { sessionRegistry } from "../services/session-registry.js";
import { getSessionProviders } from "../agents/factory.js";
import { isRoutableProvider, type RoutableProviderKind } from "../agents/ports/AgentProvider.js";
import { buildHandoffTurns, providerLabel, truncateAtCutoff } from "../agents/handoff.js";
import { createLogger } from "../utils/logger.js";
import { buildFolderSummaries } from "../services/folder-summaries.js";
import { buildWorkspaceIndex, viewForDirectory } from "../services/workspace-views.js";
import { describeWorkspaceDirectory } from "../services/workspace-service.js";
import { newDiskUsageBudget } from "../utils/disk-usage.js";
// Chat-list response cache lives in a standalone module so services can
// invalidate it without closing an import cycle back through this route.
import { chatListCache, CHAT_LIST_CACHE_TTL, CHAT_LIST_CACHE_MAX_AGE, clearChatListCache } from "../services/chat-list-cache.js";
export { clearChatListCache };

const log = createLogger("chats");

export const chatsRouter = Router();

// Cache for git info to avoid repeated expensive operations
const gitInfoCache = new Map<string, { isGitRepo: boolean; branch?: string; cachedAt: number }>();
const GIT_CACHE_TTL = 300000; // 5 minutes

/**
 * Get cached git info or fetch and cache it
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

/**
 * Extract the first user message text from a JSONL session file (up to maxLength chars).
 * Used as a chat preview/title in the chat list.
 * Delegates to the first session provider that can read the file.
 */
function getFirstUserMessage(filePath: string, maxLength: number = 200): string | null {
  for (const provider of getSessionProviders()) {
    const preview = provider.getSessionPreview(filePath, maxLength);
    if (preview) return preview;
  }
  return null;
}

/**
 * Discover session JSONL files using filesystem-level sorting for optimal performance.
 * Only processes the files needed for the current page.
 */
/**
 * Discover sessions across all registered providers.
 * Merges results, sorts globally by mtime DESC, and paginates.
 */
function discoverSessionsPaginated(
  limit: number,
  offset: number,
): {
  sessions: { sessionId: string; folder: string; displayFolder: string; filePath: string; createdAt: Date; updatedAt: Date }[];
  total: number;
} {
  const providers = getSessionProviders();

  if (providers.length === 1) {
    // Single provider: delegate directly (preserves existing performance)
    return providers[0].discoverSessions({ limit, offset });
  }

  // Multi-provider: collect all, merge, sort, paginate
  const allSessions: { sessionId: string; folder: string; displayFolder: string; filePath: string; createdAt: Date; updatedAt: Date }[] = [];
  for (const provider of providers) {
    const { sessions } = provider.discoverSessions({ limit: 9999, offset: 0 });
    allSessions.push(...sessions);
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
chatsRouter.get("/folders", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'List chats grouped by folder'
  // #swagger.description = 'Returns folders with aggregated chat info, ordered by most recently created chat. Folders that no longer exist on disk are filtered out, except when an active workspace record claims them — those are listed with directoryState "missing" so the stale record can be seen and archived. Each row also carries the active workspace records claiming the directory (id, name, isolation, owned, branch, directory state); it deliberately carries no removal verdict, which costs several git subprocesses per record — ask GET /api/workspaces for that.'
  /* #swagger.parameters['maxAgeDays'] = { in: 'query', type: 'integer', description: 'Maximum age in days (default: 5)' } */
  /* #swagger.parameters['includeDiskUsage'] = { in: 'query', type: 'string', description: 'Pass the string true to measure each listed directory with du -sk. Off by default: it is the slow part, and this endpoint is polled. Measurements are memoised for five minutes.' } */
  try {
    const maxAgeDays = parseInt(req.query.maxAgeDays as string, 10) || 5;
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);
    const includeDiskUsage = req.query.includeDiskUsage === "true";
    // One budget across the listing, not one timeout per row: `du` is
    // synchronous, so an unbounded listing is an unbounded freeze. What it did
    // not get to is reported rather than silently absent — `diskUsageNote` has
    // been in FolderListResponse since Phase 4a and this is what sets it.
    const budget = newDiskUsageBudget();

    // Fetch all sessions (large limit to get everything within range)
    const { sessions } = discoverSessionsPaginated(9999, 0);

    // One registry read for the whole listing, not one per row.
    const workspaces = buildWorkspaceIndex();

    const folders = buildFolderSummaries(sessions, {
      cutoff,
      workspaces,
      directoryExists: (folder) => existsSync(folder),
      chatMetadata: (sessionId) => {
        const storedChat = chatFileService.getChat(sessionId);
        return storedChat ? JSON.parse(storedChat.metadata || "{}") : {};
      },
      isOngoing: (sessionId) => sessionRegistry.has(sessionId),
      isWaiting: (sessionId) => hasPendingRequest(sessionId),
      gitInfo: (folder) => getCachedGitInfo(folder),
      describeDirectory: (workspace) => describeWorkspaceDirectory(workspace),
      // Absent unless asked for — that absence *is* the opt-in.
      ...(includeDiskUsage && { diskUsage: (folder: string) => budget.measure(folder) }),
    });

    const diskUsageNote = budget.note(folders.length);
    res.json({ folders, ...(diskUsageNote && { diskUsageNote }) });
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
  /* #swagger.parameters['cached'] = { in: 'query', type: 'string', description: 'Set to false to bypass cache and force fresh data' } */
  /* #swagger.responses[200] = { description: "Paginated chat list with hasMore, total, windowRows, and stale fields" } */
  try {
    // Check cache (stale-while-revalidate)
    const bypassCache = req.query.cached === "false";
    const cacheKey = `${req.query.limit || ""}:${req.query.offset || ""}:${req.query.bookmarked || ""}:${req.query.excludeTriggered || ""}:${req.query.includeLineage || ""}`;
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

    // Build set of bookmarked session IDs when filtering
    let bookmarkedSessionIds: Set<string> | null = null;
    if (bookmarkedFilter) {
      bookmarkedSessionIds = new Set<string>();
      for (const [sessionId, fileChat] of fileChatsBySessionId) {
        try {
          const meta = JSON.parse(fileChat?.metadata || "{}");
          if (meta.bookmarked === true) {
            bookmarkedSessionIds.add(sessionId);
          }
        } catch {}
      }
    }

    // When filtering by bookmarks or excluding triggered chats, we need to fetch
    // more sessions than requested since we filter after augmentation (the triggered
    // flag lives in chat file metadata). For bookmarks, fetch all. For excludeTriggered,
    // over-fetch to ensure we get enough non-triggered results. includeLineage also
    // needs the full session list so out-of-window tree relatives can be augmented.
    const needsPostFilter = bookmarkedFilter || excludeTriggered || includeLineage;
    const fetchLimit = needsPostFilter ? 9999 : limit;
    const fetchOffset = needsPostFilter ? 0 : offset;
    const { sessions: paginatedSessions, total: rawTotal } = discoverSessionsPaginated(fetchLimit, fetchOffset);

    const augmentSession = (s: (typeof paginatedSessions)[0]) => {
      // Try to find by session ID (may not exist in file storage - that's fine)
      const fileChat = fileChatsBySessionId.get(s.sessionId);

      // Get cached git info using the original folder (may be a worktree) for correct branch
      const gitInfo = getCachedGitInfo(s.folder);

      // Extract preview from the first user message in the JSONL file
      const preview = getFirstUserMessage(s.filePath);

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
          // Merge session_ids in metadata and add preview
          metadata: (() => {
            try {
              const meta = JSON.parse(fileChat.metadata || "{}");
              const sessionIds = Array.isArray(meta.session_ids) ? meta.session_ids : [];
              if (!sessionIds.includes(s.sessionId)) {
                sessionIds.push(s.sessionId);
              }
              return JSON.stringify({ ...meta, session_ids: sessionIds, ...(preview && { preview }) });
            } catch {
              return JSON.stringify({ session_ids: [s.sessionId], ...(preview && { preview }) });
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
          metadata: JSON.stringify({ session_ids: [s.sessionId], ...(preview && { preview }) }),
          created_at: s.createdAt.toISOString(),
          updated_at: s.updatedAt.toISOString(),
          // Add git information
          is_git_repo: gitInfo.isGitRepo,
          git_branch: gitInfo.branch,
          _from_filesystem: true,
        };
      }
    };

    /** Check if an augmented chat has the triggered flag set in its metadata */
    const isTriggered = (chat: any): boolean => {
      try {
        return JSON.parse(chat.metadata || "{}").triggered === true;
      } catch {
        return false;
      }
    };

    // Lineage index over file-storage chats — built only when the tree
    // view asks for lineage; shared by row-based pagination and the
    // lineage-append pass below. One metadata parse per chat, memoized
    // root resolution.
    const lineageIndex = includeLineage ? buildLineageIndex(fileChats) : null;

    /**
     * Slice a recency-ordered, already-filtered list into the requested
     * page. Without includeLineage, limit/offset count chats. With
     * includeLineage they count sidebar tree ROWS: chats sharing a
     * parentage root fold into one row, so a page always contributes
     * `limit` visible rows no matter how many chats fold together.
     */
    const paginateWindow = <T>(items: T[], chatIdOf: (item: T) => string): { page: T[]; total: number; windowRows: number } => {
      if (!lineageIndex) {
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
        augmented = augmented.filter((c) => !isTriggered(c));
      }
      ({ page: chatsFromLogs, total, windowRows } = paginateWindow(augmented, (c) => c.id));
    } else if (excludeTriggered) {
      // Augment all fetched sessions, drop triggered chats, then paginate —
      // so the window is filled from what's left.
      const augmented = paginatedSessions.map(augmentSession).filter((c) => !isTriggered(c));
      ({ page: chatsFromLogs, total, windowRows } = paginateWindow(augmented, (c) => c.id));
    } else if (includeLineage) {
      // Sessions were over-fetched for lineage lookup — paginate manually
      // (by row), augmenting only the windowed sessions.
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
    if (lineageIndex && fileChats.length > 0) {
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
        const fc = fileById.get(id);
        if (!fc) continue;
        const session = sessionByChatId.get(id);
        // Chats without a session log yet (e.g. freshly spawned) fall back
        // to the bare file record.
        const augmented = session ? augmentSession(session) : { ...fc, displayFolder: fc.folder };
        if (excludeTriggered && isTriggered(augmented)) continue;
        appended.push({ ...augmented, _lineage_appended: true });
      }
      chatsFromLogs = [...chatsFromLogs, ...appended];
    }

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
    clearChatListCache();
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
  // #swagger.description = 'Create a new chat whose session history is a copy of this chat up to and including the message at the given timestamp. The forked chat is not auto-started — the user sends the next message. The fork inherits the card membership of the original chat. Pass `provider` to hand the conversation to a different harness: the history is translated into that harness native session format, with tool calls flattened to text summaries.'
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
            provider: { type: "string", enum: ["claude-code", "openrouter", "codex", "cline", "pi"], description: "Target harness. Omit to fork within the current harness of the chat (higher fidelity). Every routable kind except acp - see the route implementation for why acp is refused." },
            model: { type: "string", description: "Model for the new chat. Required-ish on a harness switch, where the source model id is meaningless to the target." },
            effort: { type: "string", description: "Reasoning effort for the new chat (openrouter / codex only)." }
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

  const providerKind: RoutableProviderKind = isRoutableProvider(meta.provider) ? meta.provider : "claude-code";
  const provider = getSessionProviders().find((p) => p.kind === providerKind);
  if (!provider) {
    return res.status(400).json({ error: "Forking is not supported for this chat's provider" });
  }

  // Target harness. Omitted (the common case) means "same harness", which
  // keeps the high-fidelity same-provider fork path below.
  if (req.body.provider !== undefined && !isRoutableProvider(req.body.provider)) {
    return res.status(400).json({ error: `Unknown target provider "${req.body.provider}"` });
  }
  const targetKind: RoutableProviderKind = isRoutableProvider(req.body.provider) ? req.body.provider : providerKind;
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
    rootChatId: meta.rootChatId || chat.id,
    chatRole: isHandoff ? "engine-switch" : "fork",
    // Pin the target harness for the new chat's lifetime, mirroring
    // sendMessage's convention of omitting the "claude-code" default rather
    // than writing it (an explicit value there is redundant, and resolving an
    // absent provider already lands on claude-code).
    ...(targetKind !== "claude-code" && { provider: targetKind }),
    // Effort is meaningful only to the two reasoning-capable harnesses.
    ...(effort && (targetKind === "openrouter" || targetKind === "codex") && { effort }),
    // Model is honored by all three: `stream.ts` persists `metadata.model`
    // for any provider, and each harness's config block reads it (Codex's
    // per-chat override wins over the global codexModel default). Note
    // sendMessage's *new-chat* block guards model to openrouter/claude-code —
    // that guard doesn't apply here, since this route writes metadata itself.
    ...(model && { model }),
    // Model routing is an OpenRouter-only feature keyed to OR rank ids —
    // carry it only when the target is still OpenRouter.
    ...(meta.modelRouting && targetKind === "openrouter" && { modelRouting: true }),
    ...(meta.modelRouting && targetKind === "openrouter" && meta.modelRoutingRankId && { modelRoutingRankId: meta.modelRoutingRankId }),
    // A fork stays on the original's card. Unassign merges `cardId: null`,
    // so a string check (not key presence) decides whether to inherit.
    ...(typeof meta.cardId === "string" && meta.cardId && { cardId: meta.cardId }),
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
    clearChatListCache();
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

    clearChatListCache();
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

    clearChatListCache();
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

    clearChatListCache();
    res.json(updatedChat);
  } catch (err: any) {
    log.error(`Error marking chat as read: ${err}`);
    res.status(500).json({ error: "Failed to mark chat as read", details: err.message });
  }
});

// Assign a chat to a card (or unassign with cardId: null)
chatsRouter.patch("/:id/card", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Assign or unassign a chat to a card'
  // #swagger.description = 'Sets metadata.cardId, making the chat a member of the card on the board view. Pass cardId: null to unassign.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID or session ID' } */
  /* #swagger.responses[200] = { description: "Updated chat" } */
  /* #swagger.responses[404] = { description: "Chat or card not found" } */
  /* #swagger.responses[409] = { description: "Card is closed" } */
  const { cardId } = req.body ?? {};
  if (cardId !== null && (typeof cardId !== "string" || !cardId)) {
    return res.status(400).json({ error: "cardId must be a non-empty string or null" });
  }
  try {
    if (typeof cardId === "string") {
      const card = getCard(cardId);
      if (!card) return res.status(404).json({ error: "Card not found" });
      if (card.lifecycle === "closed") return res.status(409).json({ error: "Card is closed — reopen it to add chats" });
    }

    // View-only write: preserves updated_at and clears the chat-list cache.
    const ok = setChatCardMembership(req.params.id, cardId);
    if (!ok) return res.status(404).json({ error: "Chat not found" });
    res.json({ success: true, cardId });
  } catch (err: any) {
    log.error(`Error assigning chat to card: ${err}`);
    res.status(500).json({ error: "Failed to assign chat to card", details: err.message });
  }
});

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

    clearChatListCache();

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

    clearChatListCache();
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

// Session parsing functions have been extracted to
// agents/adapters/claude-code/sessionParser.ts and are accessed
// through the SessionProvider interface.
