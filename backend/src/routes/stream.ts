import { Router } from 'express';
import { sendMessage, sendSlashCommand, getActiveSession, stopSession, respondToPermission, hasPendingRequest, getPendingRequest, type StreamEvent } from '../services/claude.js';
import { OpenRouterClient } from '../services/openrouter-client.js';
import { statSync, existsSync, readdirSync, watchFile, unwatchFile, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import db from '../db.js';

export const streamRouter = Router();

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Find the session JSONL file in ~/.claude/projects/.
 */
function findSessionLogPath(sessionId: string): string | null {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return null;
  try {
    for (const dir of readdirSync(CLAUDE_PROJECTS_DIR)) {
      const candidate = join(CLAUDE_PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}

/**
 * Find chat by ID, checking DB first then filesystem like in chats.ts
 */
function findChatForStatus(id: string): any | null {
  const dbChat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (dbChat) return dbChat;

  // Try filesystem: id might be a session ID
  const logPath = findSessionLogPath(id);
  if (!logPath) return null;

  return {
    id,
    session_id: id,
    session_log_path: logPath,
  };
}

/**
 * Generate a chat title from the first user message using OpenRouter,
 * then save it into the chat's metadata JSON.
 */
async function generateAndSaveTitle(chatId: string, prompt: string): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return;

  const client = new OpenRouterClient(apiKey);
  if (!client.isReady()) return;

  const chat = db.prepare('SELECT metadata FROM chats WHERE id = ?').get(chatId) as { metadata: string } | undefined;
  if (!chat) return;

  const meta = JSON.parse(chat.metadata || '{}');
  if (meta.title) return; // already has a title

  const result = await client.generateChatTitle({ userMessage: prompt });
  if (result.success && result.content) {
    meta.title = result.content;
    db.prepare('UPDATE chats SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(meta), new Date().toISOString(), chatId);
    console.log(`[OpenRouter] Generated title for ${chatId}: "${result.content}"`);
  } else {
    console.warn('[OpenRouter] Title generation failed:', result.error);
  }
}

// Send a slash command and get SSE stream back
streamRouter.post('/:id/command', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'command is required' });

  try {
    const emitter = await sendSlashCommand(req.params.id, command);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const onEvent = (event: StreamEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done' || event.type === 'error') {
        emitter.removeListener('event', onEvent);
        res.end();
      }
    };

    emitter.on('event', onEvent);

    req.on('close', () => {
      emitter.removeListener('event', onEvent);
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Send a message and get SSE stream back
streamRouter.post('/:id/message', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  try {
    const emitter = await sendMessage(req.params.id, prompt);

    // Fire-and-forget: generate title from first message
    generateAndSaveTitle(req.params.id, prompt).catch(err =>
      console.error('[OpenRouter] Title generation failed:', err)
    );

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const onEvent = (event: StreamEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done' || event.type === 'error') {
        emitter.removeListener('event', onEvent);
        res.end();
      }
    };

    emitter.on('event', onEvent);

    req.on('close', () => {
      emitter.removeListener('event', onEvent);
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// SSE endpoint for connecting to an active stream (web or CLI)
streamRouter.get('/:id/stream', (req, res) => {
  const chatId = req.params.id;
  const session = getActiveSession(chatId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // If there's an active web session, connect to it
  if (session) {
    const onEvent = (event: StreamEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'done' || event.type === 'error') {
        session.emitter.removeListener('event', onEvent);
        res.end();
      }
    };

    session.emitter.on('event', onEvent);

    req.on('close', () => {
      session.emitter.removeListener('event', onEvent);
    });
    return;
  }

  // No web session - check if we can watch CLI session
  const chat = findChatForStatus(chatId);
  if (!chat?.session_id) {
    res.write(`data: ${JSON.stringify({ type: 'error', content: 'No active session found' })}\n\n`);
    res.end();
    return;
  }

  const logPath = findSessionLogPath(chat.session_id);
  if (!logPath || !existsSync(logPath)) {
    res.write(`data: ${JSON.stringify({ type: 'error', content: 'Session log not found' })}\n\n`);
    res.end();
    return;
  }

  // Watch CLI session file for changes
  let lastSize = 0;
  try {
    lastSize = statSync(logPath).size;
  } catch {}

  const watchHandler = () => {
    try {
      const newStats = statSync(logPath);
      if (newStats.size > lastSize) {
        // File grew, read new content
        const content = readFileSync(logPath, 'utf-8');
        const lines = content.split('\n').slice(-10); // Get last 10 lines

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.message?.content) {
              // Convert CLI log format to our stream format
              const blocks = Array.isArray(parsed.message.content) ? parsed.message.content : [parsed.message.content];
              for (const block of blocks) {
                if (typeof block === 'string') {
                  res.write(`data: ${JSON.stringify({ type: 'text', content: block })}\n\n`);
                } else if (block?.type === 'text') {
                  res.write(`data: ${JSON.stringify({ type: 'text', content: block.text })}\n\n`);
                } else if (block?.type === 'tool_use') {
                  res.write(`data: ${JSON.stringify({
                    type: 'tool_use',
                    content: JSON.stringify(block.input),
                    toolName: block.name
                  })}\n\n`);
                }
              }
            }
          } catch {}
        }
        lastSize = newStats.size;
      }
    } catch {}
  };

  watchFile(logPath, { interval: 1000 }, watchHandler);

  req.on('close', () => {
    unwatchFile(logPath, watchHandler);
  });
});

// Check for a pending request (for page refresh reconnection)
streamRouter.get('/:id/pending', (req, res) => {
  const pending = getPendingRequest(req.params.id);
  if (!pending) return res.json({ pending: null });
  res.json({
    pending: {
      type: pending.eventType,
      ...pending.eventData,
    },
  });
});

// Respond to a pending permission/question/plan request
streamRouter.post('/:id/respond', (req, res) => {
  const { allow, updatedInput, updatedPermissions } = req.body;
  if (!hasPendingRequest(req.params.id)) {
    return res.status(404).json({ error: 'No pending request' });
  }
  const ok = respondToPermission(req.params.id, allow, updatedInput, updatedPermissions);
  res.json({ ok });
});

// Check session status - active in web, CLI, or inactive
streamRouter.get('/:id/status', (req, res) => {
  const chatId = req.params.id;

  // Check if session is active in web
  const webSession = getActiveSession(chatId);
  if (webSession) {
    return res.json({
      active: true,
      type: 'web',
      hasPending: hasPendingRequest(chatId)
    });
  }

  // Check if session exists and get its log path
  const chat = findChatForStatus(chatId);
  if (!chat || !chat.session_id) {
    return res.json({ active: false, type: 'none' });
  }

  // Check CLI activity by examining .jsonl file modification time
  const logPath = findSessionLogPath(chat.session_id);
  if (!logPath || !existsSync(logPath)) {
    return res.json({ active: false, type: 'none' });
  }

  try {
    const stats = statSync(logPath);
    const lastModified = stats.mtime.getTime();
    const now = Date.now();
    const fiveMinutesAgo = now - (5 * 60 * 1000);

    // Consider CLI session active if .jsonl was modified in last 5 minutes
    const isRecentlyActive = lastModified > fiveMinutesAgo;

    res.json({
      active: isRecentlyActive,
      type: isRecentlyActive ? 'cli' : 'inactive',
      lastActivity: stats.mtime.toISOString(),
      fileSize: stats.size
    });
  } catch {
    res.json({ active: false, type: 'none' });
  }
});

// Stop execution
streamRouter.post('/:id/stop', (_req, res) => {
  const stopped = stopSession(_req.params.id);
  res.json({ stopped });
});
