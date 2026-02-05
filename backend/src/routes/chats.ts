import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { chatFileService } from '../services/chat-file-service.js';
import { getSlashCommandsForDirectory } from '../services/slashCommands.js';
import { getGitInfo } from '../utils/git.js';

export const chatsRouter = Router();

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

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
 * Discover all session JSONL files across all project dirs.
 * Returns entries with sessionId, folder, and file stats.
 */
function discoverAllSessions(): { sessionId: string; folder: string; filePath: string; createdAt: Date; updatedAt: Date }[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];
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
  return results;
}

// List all chats (pull from log directories, augment with file storage data)
chatsRouter.get('/', (req, res) => {
  // Get all file chats for augmentation lookup
  const fileChats = chatFileService.getAllChats();

  // Create lookup map for file data by session ID
  const fileChatsBySessionId = new Map<string, any>();

  for (const chat of fileChats) {
    // Index by session_id
    if (chat.session_id) {
      fileChatsBySessionId.set(chat.session_id, chat);
    }

    // Also index by session_ids in metadata
    try {
      const meta = JSON.parse(chat.metadata || '{}');
      if (Array.isArray(meta.session_ids)) {
        for (const sid of meta.session_ids) {
          fileChatsBySessionId.set(sid, chat);
        }
      }
    } catch {}
  }

  // Discover all sessions from filesystem and augment with file storage data
  const allSessions = discoverAllSessions();
  const chatsFromLogs = allSessions.map(s => {
    // Try to find by session ID
    const fileChat = fileChatsBySessionId.get(s.sessionId);

    // Get git info for the folder
    const gitInfo = getGitInfo(s.folder);

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
      // No file record found, create from filesystem only
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

  const allChats = chatsFromLogs
    .sort((a: any, b: any) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  // Handle pagination
  const limit = parseInt(req.query.limit as string) || allChats.length;
  const offset = parseInt(req.query.offset as string) || 0;

  const paginatedChats = allChats.slice(offset, offset + limit);
  const hasMore = offset + limit < allChats.length;

  res.json({
    chats: paginatedChats,
    hasMore,
    total: allChats.length
  });
});

// Create a chat (sessionId optional - will be assigned when Claude session starts)
chatsRouter.post('/', (req, res) => {
  const { folder, sessionId, defaultPermissions } = req.body;
  if (!folder) return res.status(400).json({ error: 'folder is required' });

  // Create metadata with default permissions if provided
  const metadata = {
    ...(defaultPermissions && { defaultPermissions })
  };

  // If sessionId provided, create in file storage
  // Otherwise just return a temporary chat object (will be persisted when session starts)
  if (sessionId) {
    try {
      const chat = chatFileService.createChat(folder, sessionId, JSON.stringify(metadata));
      res.status(201).json(chat);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  } else {
    // Return a temporary chat object - will be saved to file storage when session_id is assigned
    const id = uuid();
    const now = new Date().toISOString();
    res.status(201).json({
      id,
      folder,
      session_id: null,
      session_log_path: null,
      metadata: JSON.stringify(metadata),
      created_at: now,
      updated_at: now,
      _temporary: true
    });
  }
});

// Delete a chat
chatsRouter.delete('/:id', (req, res) => {
  const chat = chatFileService.getChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });

  const deleted = chatFileService.deleteChat(chat.session_id);
  if (!deleted) return res.status(500).json({ error: 'Failed to delete chat' });

  res.json({ ok: true });
});

/**
 * Look up a chat by ID, checking the file storage first then falling back to filesystem.
 */
function findChat(id: string): any | null {
  // Try file storage first
  const fileChat = chatFileService.getChat(id);
  if (fileChat) {
    const logPath = findSessionLogPath(fileChat.session_id);
    const gitInfo = getGitInfo(fileChat.folder);
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
  const gitInfo = getGitInfo(folder);

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
}

// Get a single chat
chatsRouter.get('/:id', (req, res) => {
  const chat = findChat(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  res.json(chat);
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
