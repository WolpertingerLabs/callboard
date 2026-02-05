import { Router } from 'express';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { chatFileService } from '../services/chat-file-service.js';
import { getSlashCommandsForDirectory } from '../services/slashCommands.js';
import { getGitInfo } from '../utils/git.js';

export const chatsRouter = Router();

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Cache for git info to avoid repeated expensive operations
const gitInfoCache = new Map<string, { isGitRepo: boolean; branch?: string; cachedAt: number }>();
const GIT_CACHE_TTL = 300000; // 5 minutes

/**
 * Find the session JSONL file in ~/.claude/projects/.
 * The SDK names project dirs by replacing / with - in the cwd.
 * We search all project dirs for the session ID since the SDK may
 * resolve the cwd differently than what we passed.
 */
function findSessionLogPath(sessionId: string): string | null {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;
  for (const dir of readdirSync(CLAUDE_PROJECTS_DIR)) {
    const candidate = join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Convert a project directory name back to a folder path.
 * The SDK encodes paths by replacing / with -, so "-home-exedev-my-app"
 * is ambiguous (could be /home/exedev/my-app or /home/exedev/my/app).
 * We try all possible splits and return the first path that exists on disk.
 */
function projectDirToFolder(dirName: string): string {
  // Strip leading dash (represents the root /)
  const parts = dirName.slice(1).split('-');

  // Try all possible ways to rejoin the parts with / or -
  function resolve(index: number, current: string): string | null {
    if (index === parts.length) {
      return existsSync(current) ? current : null;
    }
    // Try joining with / first (prefer deeper paths)
    const withSlash = resolve(index + 1, current + '/' + parts[index]);
    if (withSlash) return withSlash;
    // Then try joining with - (keeps it as part of the folder name)
    const withDash = resolve(index + 1, current + '-' + parts[index]);
    if (withDash) return withDash;
    return null;
  }

  const resolved = resolve(1, '/' + parts[0]);
  if (resolved) return resolved;

  // Fallback: naive replacement
  return '/' + parts.join('/');
}

/**
 * Get cached git info or fetch and cache it
 */
function getCachedGitInfo(folder: string): { isGitRepo: boolean; branch?: string } {
  const cached = gitInfoCache.get(folder);
  const now = Date.now();

  if (cached && (now - cached.cachedAt) < GIT_CACHE_TTL) {
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
 * Discover session JSONL files using filesystem-level sorting for optimal performance.
 * Only processes the files needed for the current page.
 */
function discoverSessionsPaginated(limit: number, offset: number): {
  sessions: { sessionId: string; folder: string; filePath: string; createdAt: Date; updatedAt: Date }[];
  total: number;
} {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return { sessions: [], total: 0 };

  try {
    // Use cross-platform find command to get all .jsonl files
    // Try different approaches for different systems
    let findCommand: string;
    let output: string;

    // First try with GNU stat format (Linux)
    try {
      findCommand = `find "${CLAUDE_PROJECTS_DIR}" -name "*.jsonl" -type f -exec stat -c "%Y %n" {} + 2>/dev/null | sort -rn`;
      output = execSync(findCommand, { encoding: 'utf8' }).trim();
    } catch {
      // Fallback to BSD stat format (macOS)
      try {
        findCommand = `find "${CLAUDE_PROJECTS_DIR}" -name "*.jsonl" -type f -exec stat -f "%m %N" {} + 2>/dev/null | sort -rn`;
        output = execSync(findCommand, { encoding: 'utf8' }).trim();
      } catch {
        // If both fail, throw to trigger Node.js fallback
        throw new Error('Cross-platform find commands failed');
      }
    }

    if (!output) return { sessions: [], total: 0 };

    const allFiles = output.split('\n').map(line => {
      const [timestamp, filePath] = line.split(' ', 2);
      return { timestamp: parseFloat(timestamp), filePath };
    });

    const total = allFiles.length;

    // Only process the files we need for this page
    const pageFiles = allFiles.slice(offset, offset + limit);
    const results: { sessionId: string; folder: string; filePath: string; createdAt: Date; updatedAt: Date }[] = [];

    for (const { filePath } of pageFiles) {
      try {
        const sessionId = filePath.split('/').pop()?.replace('.jsonl', '');
        if (!sessionId) continue;

        const projectDir = filePath.split('/').slice(0, -1).pop();
        if (!projectDir) continue;

        const folder = projectDirToFolder(projectDir);

        // Get file stats only for files we're actually processing
        const st = statSync(filePath);
        results.push({
          sessionId,
          folder,
          filePath,
          createdAt: st.birthtime,
          updatedAt: st.mtime
        });
      } catch {
        continue;
      }
    }

    return { sessions: results, total };
  } catch (error) {
    console.error('Error in optimized session discovery:', error);
    // Fallback to Node.js method if find command fails
    return discoverAllSessionsFallback(limit, offset);
  }
}

/**
 * Fallback method that mimics original behavior
 */
function discoverAllSessionsFallback(limit?: number, offset?: number): {
  sessions: { sessionId: string; folder: string; filePath: string; createdAt: Date; updatedAt: Date }[];
  total: number;
} {
  const results: { sessionId: string; folder: string; filePath: string; createdAt: Date; updatedAt: Date }[] = [];
  for (const dir of readdirSync(CLAUDE_PROJECTS_DIR)) {
    const dirPath = join(CLAUDE_PROJECTS_DIR, dir);
    try {
      const dirStat = statSync(dirPath);
      if (!dirStat.isDirectory()) continue;
    } catch { continue; }
    const folder = projectDirToFolder(dir);
    for (const file of readdirSync(dirPath)) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.replace('.jsonl', '');
      const filePath = join(dirPath, file);
      try {
        const st = statSync(filePath);
        results.push({ sessionId, folder, filePath, createdAt: st.birthtime, updatedAt: st.mtime });
      } catch { continue; }
    }
  }
  results.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

  const total = results.length;

  // Apply pagination if specified
  if (typeof limit === 'number' && typeof offset === 'number') {
    const paginatedResults = results.slice(offset, offset + limit);
    return { sessions: paginatedResults, total };
  }

  return { sessions: results, total };
}

// List all chats (pull from log directories, augment with file storage data)
chatsRouter.get('/', (req, res) => {
  try {
    // Get all file chats for augmentation lookup (may be empty if no file storage)
    let fileChats: any[] = [];
    try {
      fileChats = chatFileService.getAllChats() || [];
    } catch (err) {
      console.error('Error reading file chats, continuing with filesystem only:', err);
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
        const meta = JSON.parse(chat?.metadata || '{}');
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

    // Use optimized pagination to discover only the sessions we need
    const { sessions: paginatedSessions, total } = discoverSessionsPaginated(limit, offset);
    const chatsFromLogs = paginatedSessions.map(s => {
      // Try to find by session ID (may not exist in file storage - that's fine)
      const fileChat = fileChatsBySessionId.get(s.sessionId);

      // Get cached git info for the folder (with fallback)
      const gitInfo = getCachedGitInfo(s.folder);

      if (fileChat) {
        // Augment with file storage data while keeping filesystem as source of truth for timestamps
        return {
          ...fileChat,
          // Keep filesystem timestamps as they're more accurate for actual activity
          created_at: s.createdAt.toISOString(),
          updated_at: s.updatedAt.toISOString(),
          // Ensure session info from filesystem
          session_id: s.sessionId,
          session_log_path: s.filePath,
          // Add git information
          is_git_repo: gitInfo.isGitRepo,
          git_branch: gitInfo.branch,
          // Merge session_ids in metadata
          metadata: (() => {
            try {
              const meta = JSON.parse(fileChat.metadata || '{}');
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
          folder: s.folder,
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
    });

    // Sessions are already sorted by the optimized discovery function
    const hasMore = offset + limit < total;

    res.json({
      chats: chatsFromLogs,
      hasMore,
      total
    });
  } catch (err: any) {
    console.error('Error listing chats:', err);
    res.status(500).json({ error: 'Failed to list chats', details: err.message });
  }
});

// Get folder info for new chat (without creating a chat)
chatsRouter.get('/new/info', (req, res) => {
  const folder = req.query.folder as string;
  if (!folder) return res.status(400).json({ error: 'folder query param is required' });

  // Check if folder exists
  if (!existsSync(folder)) {
    return res.status(400).json({ error: 'folder does not exist' });
  }

  // Get git info for the folder
  let gitInfo: { isGitRepo: boolean; branch?: string } = { isGitRepo: false };
  try {
    gitInfo = getGitInfo(folder);
  } catch {}

  // Get slash commands for the folder
  let slashCommands: any[] = [];
  try {
    slashCommands = getSlashCommandsForDirectory(folder);
  } catch {}

  res.json({
    folder,
    is_git_repo: gitInfo.isGitRepo,
    git_branch: gitInfo.branch,
    slash_commands: slashCommands,
  });
});

// Create a chat (only when sessionId is known - for resuming sessions)
chatsRouter.post('/', (req, res) => {
  const { folder, sessionId, defaultPermissions } = req.body;
  if (!folder) return res.status(400).json({ error: 'folder is required' });
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

  // Create metadata with default permissions if provided
  const metadata = {
    ...(defaultPermissions && { defaultPermissions })
  };

  // Get git info for the folder
  let gitInfo: { isGitRepo: boolean; branch?: string } = { isGitRepo: false };
  try {
    gitInfo = getGitInfo(folder);
  } catch {}

  // Get slash commands for the folder
  let slashCommands: any[] = [];
  try {
    slashCommands = getSlashCommandsForDirectory(folder);
  } catch {}

  try {
    const chat = chatFileService.createChat(folder, sessionId, JSON.stringify(metadata));
    res.status(201).json({
      ...chat,
      is_git_repo: gitInfo.isGitRepo,
      git_branch: gitInfo.branch,
      slash_commands: slashCommands,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a chat (only deletes from file storage if it exists there)
chatsRouter.delete('/:id', (req, res) => {
  try {
    const chat = chatFileService.getChat(req.params.id);
    if (chat) {
      const deleted = chatFileService.deleteChat(chat.session_id);
      if (!deleted) {
        return res.status(500).json({ error: 'Failed to delete chat from storage' });
      }
    }
    // Even if chat wasn't in file storage, return success (it may only exist in filesystem)
    res.json({ ok: true });
  } catch (err: any) {
    console.error('Error deleting chat:', err);
    res.status(500).json({ error: 'Failed to delete chat', details: err.message });
  }
});

/**
 * Look up a chat by ID, checking the file storage first then falling back to filesystem.
 * Returns null if chat not found in either location. Does not throw errors.
 */
function findChat(id: string): any | null {
  try {
    // Try file storage first
    let fileChat = null;
    try {
      fileChat = chatFileService.getChat(id);
    } catch (err) {
      console.error('Error reading chat from file storage:', err);
    }

    if (fileChat) {
      const logPath = findSessionLogPath(fileChat.session_id);
      let gitInfo: { isGitRepo: boolean; branch?: string } = { isGitRepo: false };
      try {
        gitInfo = getGitInfo(fileChat.folder);
      } catch {}
      return {
        ...fileChat,
        session_log_path: logPath,
        is_git_repo: gitInfo.isGitRepo,
        git_branch: gitInfo.branch,
      };
    }

    // Try filesystem fallback: id might be a session ID with no file storage
    const logPath = findSessionLogPath(id);
    if (!logPath) return null;

    const projectDir = join(logPath, '..');
    const dirName = projectDir.split('/').pop()!;
    const st = statSync(logPath);
    const folder = projectDirToFolder(dirName);
    let gitInfo: { isGitRepo: boolean; branch?: string } = { isGitRepo: false };
    try {
      gitInfo = getGitInfo(folder);
    } catch {}

    return {
      id,
      folder,
      session_id: id,
      session_log_path: logPath,
      metadata: JSON.stringify({ session_ids: [id] }),
      created_at: st.birthtime.toISOString(),
      updated_at: st.mtime.toISOString(),
      is_git_repo: gitInfo.isGitRepo,
      git_branch: gitInfo.branch,
      _from_filesystem: true,
    };
  } catch (err) {
    console.error('Error finding chat:', err);
    return null;
  }
}

// Get a single chat
chatsRouter.get('/:id', (req, res) => {
  const chat = findChat(req.params.id) as any;
  if (!chat) return res.status(404).json({ error: 'Not found' });

  // Include slash commands for the chat's folder
  let slashCommands: any[] = [];
  try {
    if (chat.folder) {
      slashCommands = getSlashCommandsForDirectory(chat.folder);
    }
  } catch {}

  res.json({
    ...chat,
    slash_commands: slashCommands,
  });
});

function readJsonlFile(path: string): any[] {
  try {
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Get messages from SDK session JSONL files (all sessions for this chat)
chatsRouter.get('/:id/messages', (req, res) => {
  const chat = findChat(req.params.id) as any;
  if (!chat) return res.status(404).json({ error: 'Not found' });
  if (!chat.session_id) return res.json([]);

  // Collect all session IDs from metadata + current
  const meta = JSON.parse(chat.metadata || '{}');
  const sessionIds: string[] = meta.session_ids || [];
  if (!sessionIds.includes(chat.session_id)) sessionIds.push(chat.session_id);

  // Load only JSONL files for sessions belonging to this chat
  const allRaw: any[] = [];
  for (const sid of sessionIds) {
    const logPath = findSessionLogPath(sid);
    if (logPath) allRaw.push(...readJsonlFile(logPath));
  }

  if (allRaw.length === 0) return res.json([]);

  const parsed = parseMessages(allRaw);
  res.json(parsed);
});

// Get slash commands for a chat
chatsRouter.get('/:id/slash-commands', (req, res) => {
  const chat = findChat(req.params.id) as any;
  if (!chat) return res.status(404).json({ error: 'Not found' });

  try {
    const slashCommands = getSlashCommandsForDirectory(chat.folder);
    res.json({ slashCommands });
  } catch (error) {
    console.error('Failed to get slash commands:', error);
    res.json({ slashCommands: [] });
  }
});

interface ParsedMessage {
  role: 'user' | 'assistant';
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
  timestamp?: string;
}

function extractToolResultContent(block: any): string {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((c: any) => {
        if (typeof c === 'string') return c;
        if (c.type === 'text') return c.text;
        return JSON.stringify(c);
      })
      .join('\n');
  }
  return JSON.stringify(block.content);
}

function parseMessages(rawMessages: any[]): ParsedMessage[] {
  const result: ParsedMessage[] = [];

  for (const msg of rawMessages) {
    // Skip summary/metadata lines
    if (msg.type === 'summary' || msg.type === 'queue-operation') continue;

    const role: 'user' | 'assistant' = msg.message?.role || msg.type;
    const content = msg.message?.content || msg.content;
    const timestamp = msg.timestamp;
    if (!content) continue;

    if (typeof content === 'string') {
      result.push({ role, type: 'text', content, timestamp });
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      switch (block.type) {
        case 'text':
          if (block.text) result.push({ role, type: 'text', content: block.text, timestamp });
          break;
        case 'thinking':
          result.push({ role: 'assistant', type: 'thinking', content: block.thinking || '', timestamp });
          break;
        case 'tool_use':
          result.push({
            role: 'assistant',
            type: 'tool_use',
            content: JSON.stringify(block.input),
            toolName: block.name,
            timestamp,
          });
          break;
        case 'tool_result':
          result.push({
            role: 'assistant',
            type: 'tool_result',
            content: extractToolResultContent(block),
            toolName: block.tool_use_id,
            timestamp,
          });
          break;
      }
    }
  }

  return result;
}
