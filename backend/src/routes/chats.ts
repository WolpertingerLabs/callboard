import { Router } from "express";
import { readFileSync, existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { chatFileService } from "../services/chat-file-service.js";
import { getCommandsAndPluginsForDirectory, getAllCommandsForDirectory } from "../services/slashCommands.js";
import { getAllAppPluginsData } from "../services/app-plugins.js";
import { getGitInfo, resolveWorktreeToMainRepoCached } from "../utils/git.js";
import { CLAUDE_PROJECTS_DIR, projectDirToFolder } from "../utils/paths.js";
import { findSessionLogPath, findSubagentFiles } from "../utils/session-log.js";
import { findChat } from "../utils/chat-lookup.js";
import type { ParsedMessage } from "shared/types/index.js";
import { createLogger } from "../utils/logger.js";

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
 */
function getFirstUserMessage(filePath: string, maxLength: number = 200): string | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "user" && msg.message?.role === "user") {
          const contentBlocks = msg.message.content;
          if (typeof contentBlocks === "string") {
            return contentBlocks.slice(0, maxLength);
          }
          if (Array.isArray(contentBlocks)) {
            for (const block of contentBlocks) {
              if (block.type === "text" && block.text) {
                return block.text.slice(0, maxLength);
              }
            }
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * Discover session JSONL files using filesystem-level sorting for optimal performance.
 * Only processes the files needed for the current page.
 */
function discoverSessionsPaginated(
  limit: number,
  offset: number,
): {
  sessions: { sessionId: string; folder: string; displayFolder: string; filePath: string; createdAt: Date; updatedAt: Date }[];
  total: number;
} {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return { sessions: [], total: 0 };

  try {
    // Use the fastest approach: find + xargs + ls -t for time-sorted file listing
    // This is orders of magnitude faster than per-file operations
    // Use -maxdepth 2 to only get .jsonl files directly inside project folders,
    // excluding subagents/ subdirectories (projects/<name>/subagents/<id>.jsonl)
    const findCommand = `find "${CLAUDE_PROJECTS_DIR}" -maxdepth 2 -name "*.jsonl" -type f -print0 | xargs -0 ls -lt`;
    const output = execSync(findCommand, { encoding: "utf8" }).trim();

    if (!output) return { sessions: [], total: 0 };

    // Parse ls -lt output and extract file paths
    // Since ls -t already sorts by modification time, we can use statSync only on paginated files
    const filePathsFromLs = output
      .split("\n")
      .filter((line) => line.trim() && line.includes(".jsonl"))
      .map((line) => {
        // Extract filepath from the end of ls -l output
        const parts = line.trim().split(/\s+/);
        if (parts.length < 9) return null;

        const filePath = parts.slice(8).join(" "); // Handle spaces in filenames
        if (!filePath.endsWith(".jsonl")) return null;

        return filePath;
      })
      .filter((filePath): filePath is string => filePath !== null);

    const total = filePathsFromLs.length;

    // Only process the files we need for this page (already sorted by ls -t)
    const pageFiles = filePathsFromLs.slice(offset, offset + limit);
    const results: { sessionId: string; folder: string; displayFolder: string; filePath: string; createdAt: Date; updatedAt: Date }[] = [];

    // Only call statSync on the paginated files we actually need
    for (const filePath of pageFiles) {
      try {
        const sessionId = filePath.split("/").pop()?.replace(".jsonl", "");
        if (!sessionId) continue;

        const projectDir = filePath.split("/").slice(0, -1).pop();
        if (!projectDir) continue;

        const originalFolder = projectDirToFolder(projectDir);
        // Resolve worktree paths to the main repo for display/grouping only
        const { mainRepoPath } = resolveWorktreeToMainRepoCached(originalFolder);

        // Get timestamps only for paginated files (much faster than all files)
        const st = statSync(filePath);
        results.push({
          sessionId,
          folder: originalFolder,
          displayFolder: mainRepoPath,
          filePath,
          createdAt: st.birthtime,
          updatedAt: st.mtime,
        });
      } catch {
        continue;
      }
    }

    return { sessions: results, total };
  } catch (error) {
    log.error(`Error in optimized session discovery: ${error}`);
    // Fallback to Node.js method if find command fails
    return discoverAllSessionsFallback(limit, offset);
  }
}

/**
 * Fallback method that mimics original behavior
 */
function discoverAllSessionsFallback(
  limit?: number,
  offset?: number,
): {
  sessions: { sessionId: string; folder: string; displayFolder: string; filePath: string; createdAt: Date; updatedAt: Date }[];
  total: number;
} {
  const results: { sessionId: string; folder: string; displayFolder: string; filePath: string; createdAt: Date; updatedAt: Date }[] = [];
  for (const dir of readdirSync(CLAUDE_PROJECTS_DIR)) {
    const dirPath = join(CLAUDE_PROJECTS_DIR, dir);
    try {
      const dirStat = statSync(dirPath);
      if (!dirStat.isDirectory()) continue;
    } catch {
      continue;
    }
    const originalFolder = projectDirToFolder(dir);
    const { mainRepoPath } = resolveWorktreeToMainRepoCached(originalFolder);
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith(".jsonl")) continue;
      const sessionId = file.replace(".jsonl", "");
      const filePath = join(dirPath, file);
      try {
        const st = statSync(filePath);
        results.push({ sessionId, folder: originalFolder, displayFolder: mainRepoPath, filePath, createdAt: st.birthtime, updatedAt: st.mtime });
      } catch {
        continue;
      }
    }
  }
  results.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const total = results.length;

  // Apply pagination if specified
  if (typeof limit === "number" && typeof offset === "number") {
    const paginatedResults = results.slice(offset, offset + limit);
    return { sessions: paginatedResults, total };
  }

  return { sessions: results, total };
}

// List all chats (pull from log directories, augment with file storage data)
chatsRouter.get("/", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'List all chats'
  // #swagger.description = 'Returns paginated list of chats from filesystem session logs, augmented with file storage metadata. Sorted by most recently updated.'
  /* #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Number of chats per page (default: 20)' } */
  /* #swagger.parameters['offset'] = { in: 'query', type: 'integer', description: 'Offset for pagination (default: 0)' } */
  /* #swagger.parameters['bookmarked'] = { in: 'query', type: 'string', description: 'Filter to only bookmarked chats when set to true' } */
  /* #swagger.responses[200] = { description: "Paginated chat list with hasMore and total fields" } */
  try {
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

    // When filtering by bookmarks, fetch all sessions since bookmarked chats may be
    // spread across pages. The bookmarked set is typically small so this is fine.
    // Otherwise, use optimized pagination to discover only the sessions we need.
    const fetchLimit = bookmarkedFilter ? 9999 : limit;
    const fetchOffset = bookmarkedFilter ? 0 : offset;
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

    let chatsFromLogs;
    let total: number;
    let hasMore: boolean;

    if (bookmarkedFilter && bookmarkedSessionIds) {
      // Filter to only bookmarked sessions, then augment and paginate
      const bookmarkedSessions = paginatedSessions.filter((s) => bookmarkedSessionIds!.has(s.sessionId));
      total = bookmarkedSessions.length;
      const paged = bookmarkedSessions.slice(offset, offset + limit);
      chatsFromLogs = paged.map(augmentSession);
      hasMore = offset + limit < total;
    } else {
      // Normal path: sessions are already paginated
      chatsFromLogs = paginatedSessions.map(augmentSession);
      total = rawTotal;
      hasMore = offset + limit < total;
    }

    res.json({
      chats: chatsFromLogs,
      hasMore,
      total,
    });
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

    res.json(updatedChat);
  } catch (err: any) {
    log.error(`Error toggling bookmark: ${err}`);
    res.status(500).json({ error: "Failed to toggle bookmark", details: err.message });
  }
});

// Delete a chat (deletes both file storage metadata and JSONL session log)
chatsRouter.delete("/:id", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Delete a chat'
  // #swagger.description = 'Delete a chat from file storage and its JSONL session log from the filesystem.'
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

    // Delete the JSONL session log file from ~/.claude/projects/
    if (chat?.session_log_path && existsSync(chat.session_log_path)) {
      unlinkSync(chat.session_log_path);
    }

    // Delete subagent files for this session
    const sessionId = chat?.session_id || req.params.id;
    const subagentFiles = findSubagentFiles(sessionId);
    for (const sub of subagentFiles) {
      try {
        unlinkSync(sub.filePath);
      } catch {}
    }

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

function readJsonlFile(path: string): any[] {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Get messages from SDK session JSONL files (all sessions for this chat)
chatsRouter.get("/:id/messages", (req, res) => {
  // #swagger.tags = ['Chats']
  // #swagger.summary = 'Get chat messages'
  // #swagger.description = 'Returns parsed messages from all SDK session JSONL files associated with this chat. Includes text, thinking, tool_use, and tool_result blocks.'
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

  // Load only JSONL files for sessions belonging to this chat
  const allRaw: any[] = [];
  for (const sid of sessionIds) {
    const logPath = findSessionLogPath(sid);
    if (logPath) allRaw.push(...readJsonlFile(logPath));
  }

  if (allRaw.length === 0) return res.json([]);

  // Build agentId -> description map from parent Task tool_use blocks
  const agentDescMap = buildSubagentMap(allRaw);

  // Parse parent messages
  const parentMessages = parseMessages(allRaw);

  // Find and parse subagent messages
  const subagentMessages: ParsedMessage[] = [];
  for (const sid of sessionIds) {
    const subagentFiles = findSubagentFiles(sid);
    for (const { agentId, filePath } of subagentFiles) {
      const subRaw = readJsonlFile(filePath);
      if (subRaw.length === 0) continue;

      // Get display name: prefer description from parent Task, fall back to slug, then agentId
      const description = agentDescMap.get(agentId);
      const slug = subRaw[0]?.slug;
      const displayName = description || slug || `Agent ${agentId}`;

      subagentMessages.push(...parseSubagentMessages(subRaw, displayName));
    }
  }

  // Merge parent + subagent messages and sort by timestamp
  const allMessages = [...parentMessages, ...subagentMessages];
  if (subagentMessages.length > 0) {
    allMessages.sort((a, b) => {
      if (!a.timestamp || !b.timestamp) return 0;
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });
  }

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

function extractToolResultContent(block: any): string {
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((c: any) => {
        if (typeof c === "string") return c;
        if (c.type === "text") return c.text;
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(block.content);
}

/**
 * Build a mapping from agentId to a human-readable display name.
 * Scans parent JSONL lines for Task tool_use blocks (which have input.description)
 * and their corresponding tool_result lines (which have toolUseResult.agentId).
 */
function buildSubagentMap(rawMessages: any[]): Map<string, string> {
  const toolUseDescriptions = new Map<string, string>(); // tool_use block id -> description
  const agentDescriptions = new Map<string, string>(); // agentId -> description

  for (const msg of rawMessages) {
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;

    // Capture Task tool_use descriptions
    for (const block of content) {
      if (block.type === "tool_use" && block.name === "Task" && block.input?.description) {
        toolUseDescriptions.set(block.id, block.input.description);
      }
    }

    // The toolUseResult field is on the JSONL line itself (not inside message.content)
    if (msg.toolUseResult?.agentId) {
      // Find the tool_use_id from the tool_result block in this line's content
      const toolResultBlock = Array.isArray(content) ? content.find((b: any) => b.type === "tool_result") : undefined;
      const toolUseId = toolResultBlock?.tool_use_id;
      const desc = toolUseId ? toolUseDescriptions.get(toolUseId) : undefined;
      agentDescriptions.set(msg.toolUseResult.agentId, desc || `Agent ${msg.toolUseResult.agentId}`);
    }
  }

  return agentDescriptions;
}

/**
 * Parse subagent JSONL messages and stamp them with a teamName for display.
 * Reuses the existing parseMessages() function, then adds teamName to every result.
 */
function parseSubagentMessages(rawMessages: any[], teamName: string): ParsedMessage[] {
  const parsed = parseMessages(rawMessages);
  return parsed.map((msg) => ({ ...msg, teamName }));
}

function parseMessages(rawMessages: any[]): ParsedMessage[] {
  const result: ParsedMessage[] = [];

  for (const msg of rawMessages) {
    // Skip internal metadata lines
    if (msg.type === "summary" || msg.type === "queue-operation") continue;

    // Emit system messages (e.g. compact_boundary) as visible markers
    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      result.push({
        role: "system",
        type: "system",
        content: msg.content || "Conversation compacted",
        subtype: "compact_boundary",
        timestamp: msg.timestamp,
      });
      continue;
    }

    // Skip other system messages (e.g. turn_duration) that aren't user-facing
    if (msg.type === "system") continue;

    const role: "user" | "assistant" = msg.message?.role || msg.type;
    const content = msg.message?.content || msg.content;
    const timestamp = msg.timestamp;
    const teamName = msg.teamName;
    if (!content) continue;

    // Extract per-entry metadata (shared across all content blocks from this JSONL line)
    const model = msg.message?.model;
    const gitBranch = msg.gitBranch;
    const rawUsage = msg.message?.usage;
    const usage = rawUsage
      ? {
          input_tokens: rawUsage.input_tokens,
          output_tokens: rawUsage.output_tokens,
          cache_creation_input_tokens: rawUsage.cache_creation_input_tokens,
          cache_read_input_tokens: rawUsage.cache_read_input_tokens,
        }
      : undefined;
    const serviceTier = rawUsage?.service_tier;
    const meta = {
      ...(model && { model }),
      ...(gitBranch && { gitBranch }),
      ...(usage && { usage }),
      ...(serviceTier && { serviceTier }),
    };

    if (typeof content === "string") {
      result.push({ role, type: "text", content, timestamp, ...(teamName && { teamName }), ...meta });
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      switch (block.type) {
        case "text":
          if (block.text) result.push({ role, type: "text", content: block.text, timestamp, ...(teamName && { teamName }), ...meta });
          break;
        case "thinking":
          result.push({ role: "assistant", type: "thinking", content: block.thinking || "", timestamp, ...meta });
          break;
        case "tool_use":
          result.push({
            role: "assistant",
            type: "tool_use",
            content: JSON.stringify(block.input),
            toolName: block.name,
            toolUseId: block.id,
            timestamp,
            ...meta,
          });
          break;
        case "tool_result":
          result.push({
            role: "assistant",
            type: "tool_result",
            content: extractToolResultContent(block),
            toolName: block.tool_use_id,
            toolUseId: block.tool_use_id,
            timestamp,
            ...meta,
          });
          break;
      }
    }
  }

  return result;
}
