import { query } from '@anthropic-ai/claude-code';
import { EventEmitter } from 'events';
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
          const logPath = `${chat.folder}/.claude/sessions/${sessionId}.jsonl`;
          db.prepare('UPDATE chats SET session_id = ?, session_log_path = ?, updated_at = ? WHERE id = ?')
            .run(sessionId, logPath, new Date().toISOString(), chatId);
        }

        if (message.type === 'assistant') {
          for (const block of (message as any).message?.content || []) {
            if (block.type === 'text') {
              emitter.emit('event', { type: 'text', content: block.text } as StreamEvent);
            } else if (block.type === 'thinking') {
              emitter.emit('event', { type: 'thinking', content: block.thinking } as StreamEvent);
            } else if (block.type === 'tool_use') {
              emitter.emit('event', {
                type: 'tool_use',
                content: JSON.stringify(block.input),
                toolName: block.name,
              } as StreamEvent);
            } else if (block.type === 'tool_result') {
              emitter.emit('event', {
                type: 'tool_result',
                content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              } as StreamEvent);
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
