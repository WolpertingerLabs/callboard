import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { readFileSync, existsSync } from 'fs';
import db from '../db.js';

export const chatsRouter = Router();

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
  if (!chat.session_log_path || !existsSync(chat.session_log_path)) {
    return res.json([]);
  }

  try {
    const content = readFileSync(chat.session_log_path, 'utf-8');
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

function parseMessages(rawMessages: any[]): ParsedMessage[] {
  const result: ParsedMessage[] = [];

  for (const msg of rawMessages) {
    if (msg.type === 'user' || msg.role === 'user') {
      const content = msg.message?.content || msg.content;
      if (typeof content === 'string') {
        result.push({ role: 'user', type: 'text', content });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            result.push({ role: 'user', type: 'text', content: block.text });
          }
        }
      }
    } else if (msg.type === 'assistant' || msg.role === 'assistant') {
      const content = msg.message?.content || msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            result.push({ role: 'assistant', type: 'text', content: block.text });
          } else if (block.type === 'thinking') {
            result.push({ role: 'assistant', type: 'thinking', content: block.thinking });
          } else if (block.type === 'tool_use') {
            result.push({
              role: 'assistant',
              type: 'tool_use',
              content: JSON.stringify(block.input),
              toolName: block.name,
            });
          } else if (block.type === 'tool_result') {
            result.push({
              role: 'assistant',
              type: 'tool_result',
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
            });
          }
        }
      }
    }
  }

  return result;
}
