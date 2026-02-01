import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { readFileSync, existsSync, readdirSync } from 'fs';
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

// List all chats
chatsRouter.get('/', (_req, res) => {
  const chats = db.prepare('SELECT * FROM chats ORDER BY updated_at DESC').all();
  res.json(chats);
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

// Get a single chat
chatsRouter.get('/:id', (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Not found' });
  res.json(chat);
});

// Get messages from SDK session JSONL
chatsRouter.get('/:id/messages', (req, res) => {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(req.params.id) as any;
  if (!chat) return res.status(404).json({ error: 'Not found' });
  if (!chat.session_id) return res.json([]);

  // Always derive path from session_id (it may change across resumes)
  const logPath = findSessionLogPath(chat.session_id);

  if (!logPath || !existsSync(logPath)) return res.json([]);

  try {
    const content = readFileSync(logPath, 'utf-8');
    const messages = content
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);

    const parsed = parseMessages(messages);
    res.json(parsed);
  } catch {
    res.json([]);
  }
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
