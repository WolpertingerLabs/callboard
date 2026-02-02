const BASE = '/api';

export interface Chat {
  id: string;
  folder: string;
  session_id: string | null;
  session_log_path: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface ParsedMessage {
  role: 'user' | 'assistant';
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
}

export async function listChats(): Promise<Chat[]> {
  const res = await fetch(`${BASE}/chats`);
  return res.json();
}

export type PermissionLevel = 'allow' | 'ask' | 'deny';

export interface DefaultPermissions {
  fileOperations: PermissionLevel;
  codeExecution: PermissionLevel;
  webAccess: PermissionLevel;
}

export async function createChat(folder: string, defaultPermissions?: DefaultPermissions): Promise<Chat> {
  const res = await fetch(`${BASE}/chats`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder, defaultPermissions }),
  });
  return res.json();
}

export async function deleteChat(id: string): Promise<void> {
  await fetch(`${BASE}/chats/${id}`, { method: 'DELETE' });
}

export async function getChat(id: string): Promise<Chat> {
  const res = await fetch(`${BASE}/chats/${id}`);
  return res.json();
}

export async function getMessages(id: string): Promise<ParsedMessage[]> {
  const res = await fetch(`${BASE}/chats/${id}/messages`);
  return res.json();
}

export async function getPending(id: string): Promise<any | null> {
  const res = await fetch(`${BASE}/chats/${id}/pending`);
  const data = await res.json();
  return data.pending;
}

export async function stopChat(id: string): Promise<void> {
  await fetch(`${BASE}/chats/${id}/stop`, { method: 'POST' });
}

export async function respondToChat(
  id: string,
  allow: boolean,
  updatedInput?: Record<string, unknown>,
  updatedPermissions?: unknown[],
): Promise<void> {
  await fetch(`${BASE}/chats/${id}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ allow, updatedInput, updatedPermissions }),
  });
}

export interface SessionStatus {
  active: boolean;
  type: 'web' | 'cli' | 'inactive' | 'none';
  hasPending?: boolean;
  lastActivity?: string;
  fileSize?: number;
}

export async function getSessionStatus(id: string): Promise<SessionStatus> {
  const res = await fetch(`${BASE}/chats/${id}/status`, { credentials: 'include' });
  return res.json();
}
