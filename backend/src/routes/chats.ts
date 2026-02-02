import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import db from '../db.js';

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

// List all chats (DB chats + untracked sessions from filesystem)
chatsRouter.get('/', (_req, res) => {
  const dbChats = db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all() as any[];

  // Collect all session IDs already tracked in the DB
  const trackedSessionIds = new Set<string>();
  for (const chat of dbChats) {
    if (chat.session_id) trackedSessionIds.add(chat.session_id);
    try {
      const meta = JSON.parse(chat.metadata || '{}');
      if (Array.isArray(meta.session_ids)) {
        for (const sid of meta.session_ids) trackedSessionIds.add(sid);
      }
    } catch {}
  }

  // Discover untracked sessions from the filesystem
  const allSessions = discoverAllSessions();
  const untrackedChats = allSessions
    .filter(s => !trackedSessionIds.has(s.sessionId))
    .map(s => ({
      id: s.sessionId,
      folder: s.folder,
      session_id: s.sessionId,
      session_log_path: s.filePath,
      metadata: JSON.stringify({ session_ids: [s.sessionId] }),
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
      _from_filesystem: true,
    }));

  const allChats = [...dbChats, ...untrackedChats]
    .sort((a: any, b: any) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  res.json(allChats);
});

// Create a chat
chatsRouter.post('/', (req, res) => {
  const { folder } = req.body;
  if (!folder) return res.status(400).json({ error: 'folder is required' });

  const id = uuid();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO chats (id, folder, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, folder, '{}', now, now);

  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  res.status(201).json(chat);
});

// Delete a chat
chatsRouter.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM chats WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

/**
 * Look up a chat by ID, checking the DB first then falling back to filesystem.
 */
function findChat(id: string): any | null {
  const dbChat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (dbChat) return dbChat;

  // Try filesystem: id might be a session ID
  const logPath = findSessionLogPath(id);
  if (!logPath) return null;

  const projectDir = join(logPath, '..');
  const dirName = projectDir.split('/').pop()!;
  const st = statSync(logPath);
  return {
    id,
    folder: projectDirToFolder(dirName),
    session_id: id,
    session_log_path: logPath,
    metadata: JSON.stringify({ session_ids: [id] }),
    created_at: st.birthtime.toISOString(),
    updated_at: st.mtime.toISOString(),
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

interface ParsedMessage {
  role: 'user' | 'assistant';
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
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
    if (!content) continue;

    if (typeof content === 'string') {
      result.push({ role, type: 'text', content });
      continue;
    }

    if (!Array.isArray(content)) continue;

    for (const block of content) {
      switch (block.type) {
        case 'text':
          if (block.text) result.push({ role, type: 'text', content: block.text });
          break;
        case 'thinking':
          result.push({ role: 'assistant', type: 'thinking', content: block.thinking || '' });
          break;
        case 'tool_use':
          result.push({
            role: 'assistant',
            type: 'tool_use',
            content: JSON.stringify(block.input),
            toolName: block.name,
          });
          break;
        case 'tool_result':
          result.push({
            role: 'assistant',
            type: 'tool_result',
            content: extractToolResultContent(block),
            toolName: block.tool_use_id,
          });
          break;
      }
    }
  }

  return result;
}
