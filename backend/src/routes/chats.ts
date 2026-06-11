import { Router } from "express";
import { existsSync } from "fs";
import { randomUUID } from "node:crypto";
import { chatFileService } from "../services/chat-file-service.js";
import { getCommandsAndPluginsForDirectory, getAllCommandsForDirectory } from "../services/slashCommands.js";
import { getAllAppPluginsData } from "../services/app-plugins.js";
import { getGitInfo, resolveWorktreeToMainRepoCached } from "../utils/git.js";
import { findChat } from "../utils/chat-lookup.js";
import { hasPendingRequest } from "../services/claude.js";
import { sessionRegistry } from "../services/session-registry.js";
import { getSessionProviders } from "../agents/factory.js";
import { createLogger } from "../utils/logger.js";
import type { FolderSummary } from "shared/types/index.js";

const log = createLogger("chats");

export const chatsRouter = Router();

// Cache for chat list responses (stale-while-revalidate)
interface CachedChatListResponse {
  data: { chats: any[]; hasMore: boolean; total: number };
  createdAt: number;
}
const chatListCache = new Map<string, CachedChatListResponse>();
const CHAT_LIST_CACHE_TTL = 5_000; // 5 seconds — fresh
const CHAT_LIST_CACHE_MAX_AGE = 300_000; // 5 minutes — serve stale

export function clearChatListCache() {
  chatListCache.clear();
}

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
  // #swagger.description = 'Returns folders with aggregated chat info, ordered by most recently created chat. Filters out folders that no longer exist on disk.'
  /* #swagger.parameters['maxAgeDays'] = { in: 'query', type: 'integer', description: 'Maximum age in days (default: 5)' } */
  try {
    const maxAgeDays = parseInt(req.query.maxAgeDays as string, 10) || 5;
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

    // Fetch all sessions (large limit to get everything within range)
    const { sessions } = discoverSessionsPaginated(9999, 0);

    // Filter by age and group by folder
    const folderMap = new Map<string, typeof sessions>();
    for (const session of sessions) {
      if (session.createdAt < cutoff) continue;
      const group = folderMap.get(session.folder) || [];
      group.push(session);
      folderMap.set(session.folder, group);
    }

    const folders: FolderSummary[] = [];

    for (const [folder, chats] of folderMap) {
      // Skip folders that no longer exist on disk
      if (!existsSync(folder)) continue;

      // Sort by created_at descending to find most recent
      chats.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const mostRecent = chats[0];

      // Find latest updated_at across all chats
      const lastUpdatedAt = chats.reduce((latest, c) => (c.updatedAt > latest ? c.updatedAt : latest), chats[0].updatedAt);

      // Get metadata from file storage for the most recent chat
      const storedChat = chatFileService.getChat(mostRecent.sessionId);
      const metadata = storedChat ? JSON.parse(storedChat.metadata || "{}") : {};

      // Determine status
      let status: "ongoing" | "waiting" | "stopped" = "stopped";
      if (sessionRegistry.has(mostRecent.sessionId)) {
        status = "ongoing";
      } else if (hasPendingRequest(mostRecent.sessionId)) {
        status = "waiting";
      }

      // Get git info
      const gitInfo = getCachedGitInfo(folder);
      const { isWorktree } = resolveWorktreeToMainRepoCached(folder);

      // Extract folder display name (last path segment)
      const displayName = folder.split("/").pop() || folder;

      folders.push({
        folder,
        displayName,
        mostRecentChatId: mostRecent.sessionId,
        mostRecentChatCreatedAt: mostRecent.createdAt.toISOString(),
        lastUpdatedAt: lastUpdatedAt.toISOString(),
        status,
        isGitRepo: gitInfo.isGitRepo,
        isWorktree,
        gitBranch: gitInfo.branch,
        isTriggered: !!metadata.triggered,
        triggeredBy: metadata.triggeredBy,
        chatCount: chats.length,
        chatStatus: metadata.chatStatus || undefined,
        chatStatusEmoji: metadata.chatStatusEmoji || undefined,
        hasSummon: !!metadata.summon,
        chatTitle: metadata.title || undefined,
        mostRecentChatProvider: metadata.provider || undefined,
      });
    }

    // Sort by last updated descending (most recently active folders first)
    folders.sort((a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());

    res.json({ folders });
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
  /* #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Number of chats per page (default: 20)' } */
  /* #swagger.parameters['offset'] = { in: 'query', type: 'integer', description: 'Offset for pagination (default: 0)' } */
  /* #swagger.parameters['bookmarked'] = { in: 'query', type: 'string', description: 'Filter to only bookmarked chats when set to true' } */
  /* #swagger.parameters['excludeTriggered'] = { in: 'query', type: 'string', description: 'Exclude triggered/agent chats from results when set to true. Returns LIMIT non-triggered chats so the list always has content.' } */
  /* #swagger.parameters['cached'] = { in: 'query', type: 'string', description: 'Set to false to bypass cache and force fresh data' } */
  /* #swagger.responses[200] = { description: "Paginated chat list with hasMore, total, and stale fields" } */
  try {
    // Check cache (stale-while-revalidate)
    const bypassCache = req.query.cached === "false";
    const cacheKey = `${req.query.limit || ""}:${req.query.offset || ""}:${req.query.bookmarked || ""}:${req.query.excludeTriggered || ""}`;
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
    // over-fetch to ensure we get enough non-triggered results.
    const needsPostFilter = bookmarkedFilter || excludeTriggered;
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

    let chatsFromLogs;
    let total: number;
    let hasMore: boolean;

    if (bookmarkedFilter && bookmarkedSessionIds) {
      // Filter to only bookmarked sessions, then augment and paginate
      const bookmarkedSessions = paginatedSessions.filter((s) => bookmarkedSessionIds!.has(s.sessionId));
      let augmented = bookmarkedSessions.map(augmentSession);
      if (excludeTriggered) {
        augmented = augmented.filter((c) => !isTriggered(c));
      }
      total = augmented.length;
      chatsFromLogs = augmented.slice(offset, offset + limit);
      hasMore = offset + limit < total;
    } else if (excludeTriggered) {
      // Augment all fetched sessions, filter out triggered, then paginate
      const allAugmented = paginatedSessions.map(augmentSession);
      const nonTriggered = allAugmented.filter((c) => !isTriggered(c));
      total = nonTriggered.length;
      chatsFromLogs = nonTriggered.slice(offset, offset + limit);
      hasMore = offset + limit < total;
    } else {
      // Normal path: sessions are already paginated
      chatsFromLogs = paginatedSessions.map(augmentSession);
      total = rawTotal;
      hasMore = offset + limit < total;
    }

    const responseData = { chats: chatsFromLogs, hasMore, total };
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

  // Resolve worktree to get main repo path
  const { mainRepoPath, isWorktree } = resolveWorktreeToMainRepoCached(folder);

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
  // #swagger.description = 'Create a new chat whose session history is a copy of this chat up to and including the message at the given timestamp. The forked chat is not auto-started — the user sends the next message.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Chat ID or session ID' } */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["timestamp"],
          properties: {
            timestamp: { type: "string", description: "ISO timestamp of the message to fork at (history up to and including it is copied)" }
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

  const providerKind = meta.provider || "claude-code";
  const provider = getSessionProviders().find((p) => p.kind === providerKind);
  if (!provider?.forkSession) {
    return res.status(400).json({ error: "Forking is not supported for this chat's provider" });
  }

  const sessionIds: string[] = meta.session_ids || [];
  if (!sessionIds.includes(chat.session_id)) sessionIds.push(chat.session_id);

  const newSessionId = randomUUID();
  let forked: { logPath: string } | null = null;
  try {
    forked = provider.forkSession(sessionIds, timestamp, newSessionId);
  } catch (error) {
    log.error(`Failed to fork session: ${error}`);
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

  const forkMeta = {
    session_ids: [newSessionId],
    title: baseTitle ? `Fork: ${baseTitle}` : "Fork",
    forkedFrom: chat.id,
    ...(meta.defaultPermissions && { defaultPermissions: meta.defaultPermissions }),
    ...(meta.agentAlias && { agentAlias: meta.agentAlias }),
    ...(meta.lastBranch && { lastBranch: meta.lastBranch }),
  };

  try {
    const newChat = chatFileService.createChat(chat.folder, newSessionId, JSON.stringify(forkMeta));
    clearChatListCache();
    res.status(201).json(newChat);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
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
