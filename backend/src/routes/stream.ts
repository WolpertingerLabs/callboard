import { Router } from 'express';
import { EventEmitter } from 'events';
import { sendMessage, sendSlashCommand, getActiveSession, stopSession, respondToPermission, hasPendingRequest, getPendingRequest, type StreamEvent } from '../services/claude.js';
import { OpenRouterClient } from '../services/openrouter-client.js';
import { ImageStorageService } from '../services/image-storage.js';
import { statSync, existsSync, readdirSync, watchFile, unwatchFile, readFileSync, openSync, readSync, closeSync } from 'fs';
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


// Send a message and get SSE stream back
streamRouter.post('/:id/message', async (req, res) => {
  console.log('[DEBUG] Route hit:', req.method, req.path, JSON.stringify(req.body));
  const { prompt, imageIds } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  console.log(`[DEBUG] Received message request:`, {
    prompt: prompt?.substring(0, 100) + '...',
    imageIds,
    imageIdsLength: imageIds?.length || 0
  });

  try {
    // Fetch image data if imageIds are provided
    let imageMetadata: { buffer: Buffer; mimeType: string }[] = [];
    if (imageIds && imageIds.length > 0) {
      console.log(`[DEBUG] Processing ${imageIds.length} image IDs: ${imageIds}`);

      for (const imageId of imageIds) {
        try {
          console.log(`[DEBUG] Loading image: ${imageId}`);
          const result = ImageStorageService.getImage(imageId);
          if (result) {
            console.log(`[DEBUG] Successfully loaded image ${imageId}, size: ${result.buffer.length} bytes, mimeType: ${result.image.mimeType}`);
            imageMetadata.push({
              buffer: result.buffer,
              mimeType: result.image.mimeType
            });
          } else {
            console.warn(`[DEBUG] Image not found: ${imageId}`);
          }
        } catch (error) {
          console.error(`Failed to load image ${imageId}:`, error);
        }
      }

      console.log(`[DEBUG] Final imageMetadata count: ${imageMetadata.length}`);

      // Store image metadata in chat metadata for this message
      await storeMessageImages(req.params.id, imageIds);
    } else {
      console.log(`[DEBUG] No imageIds provided in request`);
    }

    // Auto-detect slash commands and route appropriately
    let emitter;
    if (prompt.startsWith('/')) {
      // Handle special commands
      if (prompt.trim().toLowerCase() === '/help') {
        emitter = await handleHelpCommand(req.params.id);
      } else {
        emitter = await sendSlashCommand(req.params.id, prompt);
      }
    } else {
      emitter = await sendMessage(req.params.id, prompt, imageMetadata.length > 0 ? imageMetadata : undefined);
    }

    // Generate title synchronously from first message
    await generateAndSaveTitle(req.params.id, prompt);

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

/**
 * Handle /help command by providing information about available slash commands
 */
async function handleHelpCommand(chatId: string): Promise<EventEmitter> {
  const emitter = new EventEmitter();

  // Simulate an immediate response with help information
  process.nextTick(() => {
    emitter.emit('event', {
      type: 'text',
      content: `# Claude Code Available Commands

Claude Code supports various slash commands for specialized tasks:

## Usage
Type any command starting with \`/\` and Claude Code will handle it appropriately.

## Getting Help
- \`/help\` - Show this help message (handled by the UI)

## Notes
- All other slash commands are processed directly by Claude Code
- Claude Code will provide feedback if a command is not recognized
- Commands are context-aware based on your project and current session

For more detailed information about Claude Code capabilities, visit the [Claude Code documentation](https://docs.claude.ai/docs/claude-code).
`
    });

    emitter.emit('event', { type: 'done', content: '' });
  });

  return emitter;
}

/**
 * Store image metadata for a message in chat metadata
 */
async function storeMessageImages(chatId: string, imageIds: string[]): Promise<void> {
  const chat = db.prepare('SELECT metadata FROM chats WHERE id = ?').get(chatId) as { metadata: string } | undefined;

  if (!chat) {
    console.warn(`Chat ${chatId} not found in database, skipping image metadata storage`);
    return;
  }

  const metadata = JSON.parse(chat.metadata || '{}');

  // Create a unique message ID for this set of images
  const messageId = `msg_${Date.now()}_${Math.random().toString(36).substring(2)}`;

  if (!metadata.messageImages) {
    metadata.messageImages = {};
  }

  metadata.messageImages[messageId] = {
    imageIds,
    timestamp: new Date().toISOString(),
    messageType: 'user'
  };

  // Update the chat metadata
  db.prepare('UPDATE chats SET metadata = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(metadata), new Date().toISOString(), chatId);
}

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
  let lastPosition = 0;
  try {
    lastPosition = statSync(logPath).size;
  } catch {}

  const watchHandler = () => {
    try {
      const newStats = statSync(logPath);
      if (newStats.size > lastPosition) {
        // Read only the new content since last position
        const buffer = Buffer.alloc(newStats.size - lastPosition);
        const fd = openSync(logPath, 'r');
        readSync(fd, buffer, 0, buffer.length, lastPosition);
        closeSync(fd);

        const newContent = buffer.toString('utf-8');
        const lines = newContent.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.message?.content) {
              // Convert CLI log format to our stream format (match web session logic)
              const blocks = Array.isArray(parsed.message.content) ? parsed.message.content : [parsed.message.content];
              for (const block of blocks) {
                if (typeof block === 'string') {
                  res.write(`data: ${JSON.stringify({ type: 'text', content: block })}\n\n`);
                } else if (block?.type === 'text') {
                  res.write(`data: ${JSON.stringify({ type: 'text', content: block.text })}\n\n`);
                } else if (block?.type === 'thinking') {
                  res.write(`data: ${JSON.stringify({ type: 'thinking', content: block.thinking })}\n\n`);
                } else if (block?.type === 'tool_use') {
                  res.write(`data: ${JSON.stringify({
                    type: 'tool_use',
                    content: JSON.stringify(block.input),
                    toolName: block.name
                  })}\n\n`);
                } else if (block?.type === 'tool_result') {
                  // This is the critical missing piece - handle tool results (including command errors)
                  const content = typeof block.content === 'string'
                    ? block.content
                    : Array.isArray(block.content)
                      ? block.content.map((c: any) => typeof c === 'string' ? c : c.text || JSON.stringify(c)).join('\n')
                      : JSON.stringify(block.content);
                  res.write(`data: ${JSON.stringify({ type: 'tool_result', content })}\n\n`);
                }
              }
            }
          } catch (err) {
            // Log parsing errors for debugging instead of silently ignoring
            console.warn('[CLI Monitor] Failed to parse log line:', err instanceof Error ? err.message : 'Unknown error', 'Line:', line.slice(0, 100));
          }
        }
        lastPosition = newStats.size;
      }
    } catch (err) {
      console.warn('[CLI Monitor] File watch error:', err instanceof Error ? err.message : 'Unknown error');
    }
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
