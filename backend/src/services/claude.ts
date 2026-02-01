import { query } from '@anthropic-ai/claude-code';
import { EventEmitter } from 'events';
import { homedir } from 'os';
import { join } from 'path';
import db from '../db.js';

export interface StreamEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'done' | 'error';
  content: string;
  toolName?: string;
}

interface ActiveSession {
  abortController: AbortController;
  emitter: EventEmitter;
}

const activeSessions = new Map<string, ActiveSession>();

export function getActiveSession(chatId: string): ActiveSession | undefined {
  return activeSessions.get(chatId);
}

export function stopSession(chatId: string): boolean {
  const session = activeSessions.get(chatId);
  if (session) {
    session.abortController.abort();
    activeSessions.delete(chatId);
    return true;
  }
  return false;
}

export async function sendMessage(chatId: string, prompt: string): Promise<EventEmitter> {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId) as any;
  if (!chat) throw new Error('Chat not found');

  const emitter = new EventEmitter();
  const abortController = new AbortController();
  activeSessions.set(chatId, { abortController, emitter });

  const options: any = {
    prompt,
    abortController,
    cwd: chat.folder,
    options: {
      maxTurns: 50,
    },
  };

  if (chat.session_id) {
    options.resume = { id: chat.session_id, transcript: [] };
  }

  (async () => {
    try {
      let sessionId: string | null = null;

      const conversation = query(options);

      for await (const message of conversation) {
        if (abortController.signal.aborted) break;

        if ('session_id' in message && message.session_id && !sessionId) {
          sessionId = message.session_id as string;
          // Append new session_id to metadata.session_ids array for full history
          const meta = JSON.parse(chat.metadata || '{}');
          const ids: string[] = meta.session_ids || [];
          if (!ids.includes(sessionId)) ids.push(sessionId);
          meta.session_ids = ids;
          db.prepare('UPDATE chats SET session_id = ?, metadata = ?, updated_at = ? WHERE id = ?')
            .run(sessionId, JSON.stringify(meta), new Date().toISOString(), chatId);
        }

        const blocks = (message as any).message?.content || [];
        for (const block of blocks) {
          switch (block.type) {
            case 'text':
              emitter.emit('event', { type: 'text', content: block.text } as StreamEvent);
              break;
            case 'thinking':
              emitter.emit('event', { type: 'thinking', content: block.thinking } as StreamEvent);
              break;
            case 'tool_use':
              emitter.emit('event', {
                type: 'tool_use',
                content: JSON.stringify(block.input),
                toolName: block.name,
              } as StreamEvent);
              break;
            case 'tool_result': {
              const content = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c: any) => typeof c === 'string' ? c : c.text || JSON.stringify(c)).join('\n')
                  : JSON.stringify(block.content);
              emitter.emit('event', { type: 'tool_result', content } as StreamEvent);
              break;
            }
          }
        }
      }

      db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), chatId);
      emitter.emit('event', { type: 'done', content: '' } as StreamEvent);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        emitter.emit('event', { type: 'error', content: err.message } as StreamEvent);
      }
    } finally {
      activeSessions.delete(chatId);
    }
  })();

  return emitter;
}
