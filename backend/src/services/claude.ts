import { query } from '@anthropic-ai/claude-code';
import type { PermissionResult } from '@anthropic-ai/claude-code';
import { EventEmitter } from 'events';
import db from '../db.js';

export interface StreamEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'done' | 'error'
    | 'permission_request' | 'user_question' | 'plan_review';
  content: string;
  toolName?: string;
  input?: Record<string, unknown>;
  questions?: unknown[];
  suggestions?: unknown[];
}

interface PendingRequest {
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: unknown[];
  eventType: 'permission_request' | 'user_question' | 'plan_review';
  eventData: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

interface ActiveSession {
  abortController: AbortController;
  emitter: EventEmitter;
}

const activeSessions = new Map<string, ActiveSession>();
const pendingRequests = new Map<string, PendingRequest>();

type PermissionLevel = 'allow' | 'ask' | 'deny';

interface DefaultPermissions {
  fileOperations: PermissionLevel;
  codeExecution: PermissionLevel;
  webAccess: PermissionLevel;
}

function categorizeToolPermission(toolName: string): keyof DefaultPermissions | null {
  // File operations
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep'].includes(toolName)) {
    return 'fileOperations';
  }

  // Code execution
  if (['Bash', 'NotebookEdit'].includes(toolName)) {
    return 'codeExecution';
  }

  // Web access
  if (['WebFetch', 'WebSearch'].includes(toolName)) {
    return 'webAccess';
  }

  // Tools that don't need permission checks (always allowed)
  if (['TodoWrite', 'Task', 'ExitPlanMode', 'AskUserQuestion', 'SlashCommand', 'BashOutput', 'KillShell'].includes(toolName)) {
    return null;
  }

  // Default to file operations for unknown tools
  return 'fileOperations';
}

export function getActiveSession(chatId: string): ActiveSession | undefined {
  return activeSessions.get(chatId);
}

export function hasPendingRequest(chatId: string): boolean {
  return pendingRequests.has(chatId);
}

export function getPendingRequest(chatId: string): Omit<PendingRequest, 'resolve'> | null {
  const p = pendingRequests.get(chatId);
  if (!p) return null;
  const { resolve: _, ...rest } = p;
  return rest;
}

export function respondToPermission(
  chatId: string,
  allow: boolean,
  updatedInput?: Record<string, unknown>,
  updatedPermissions?: unknown[],
): boolean {
  const pending = pendingRequests.get(chatId);
  if (!pending) return false;
  pendingRequests.delete(chatId);

  if (allow) {
    pending.resolve({
      behavior: 'allow',
      updatedInput: updatedInput || pending.input,
      updatedPermissions: updatedPermissions as any,
    });
  } else {
    pending.resolve({ behavior: 'deny', message: 'User denied', interrupt: true });
  }
  return true;
}

export function stopSession(chatId: string): boolean {
  const session = activeSessions.get(chatId);
  if (session) {
    session.abortController.abort();
    activeSessions.delete(chatId);
    pendingRequests.delete(chatId);
    return true;
  }
  return false;
}

export async function sendMessage(chatId: string, prompt: string): Promise<EventEmitter> {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId) as any;
  if (!chat) throw new Error('Chat not found');

  // Stop any existing session for this chat (web or CLI monitoring)
  stopSession(chatId);

  const emitter = new EventEmitter();
  const abortController = new AbortController();
  activeSessions.set(chatId, { abortController, emitter });

  const queryOpts: any = {
    prompt,
    options: {
      abortController,
      cwd: chat.folder,
      maxTurns: 50,
      ...(chat.session_id ? { resume: chat.session_id } : {}),
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        { signal, suggestions }: { signal: AbortSignal; suggestions?: unknown[] },
      ): Promise<PermissionResult> => {
        // Check for default permissions for this tool category
        const category = categorizeToolPermission(toolName);
        if (category) {
          try {
            const metadata = JSON.parse(chat.metadata || '{}');
            const defaultPermissions: DefaultPermissions = metadata.defaultPermissions;

            if (defaultPermissions && defaultPermissions[category]) {
              const permission = defaultPermissions[category];

              if (permission === 'allow') {
                // Auto-approve
                return { behavior: 'allow', updatedInput: input };
              } else if (permission === 'deny') {
                // Auto-deny
                return { behavior: 'deny', message: `Auto-denied by default ${category} policy`, interrupt: true };
              }
              // If 'ask' or not set, fall through to normal permission flow
            }
          } catch {
            // If metadata parsing fails, fall through to normal permission flow
          }
        }

        return new Promise<PermissionResult>((resolve) => {
          // Emit appropriate event type based on tool
          if (toolName === 'AskUserQuestion') {
            emitter.emit('event', {
              type: 'user_question',
              content: '',
              questions: input.questions as unknown[],
            } as StreamEvent);
          } else if (toolName === 'ExitPlanMode') {
            emitter.emit('event', {
              type: 'plan_review',
              content: JSON.stringify(input),
            } as StreamEvent);
          } else {
            emitter.emit('event', {
              type: 'permission_request',
              content: '',
              toolName,
              input,
              suggestions,
            } as StreamEvent);
          }

          let eventType: PendingRequest['eventType'];
          let eventData: Record<string, unknown>;
          if (toolName === 'AskUserQuestion') {
            eventType = 'user_question';
            eventData = { questions: input.questions };
          } else if (toolName === 'ExitPlanMode') {
            eventType = 'plan_review';
            eventData = { content: JSON.stringify(input) };
          } else {
            eventType = 'permission_request';
            eventData = { toolName, input, suggestions };
          }

          pendingRequests.set(chatId, { toolName, input, suggestions, eventType, eventData, resolve });

          // Clean up on abort
          signal.addEventListener('abort', () => {
            pendingRequests.delete(chatId);
            resolve({ behavior: 'deny', message: 'Aborted' });
          });
        });
      },
    },
  };

  (async () => {
    try {
      let sessionId: string | null = null;

      const conversation = query(queryOpts);

      for await (const message of conversation) {
        if (abortController.signal.aborted) break;

        if ('session_id' in message && message.session_id && !sessionId) {
          sessionId = message.session_id as string;
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
      pendingRequests.delete(chatId);
    }
  })();

  return emitter;
}
