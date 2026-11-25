import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getConfigDir } from '../shared/config.js';

/** File-backed session store at ~/.drawlatch/data/sessions.json (mode 0o600). */
function getSessionsFile(): string {
  return join(getConfigDir(), 'data', 'sessions.json');
}

interface SessionData {
  expires_at: number;
  created_at: number;
  ip?: string;
}

interface SessionsFile {
  sessions: Record<string, SessionData>;
  metadata: {
    last_cleanup: number;
    version: number;
  };
}

function loadSessions(): SessionsFile {
  const file = getSessionsFile();
  if (!existsSync(file)) {
    const initial: SessionsFile = {
      sessions: {},
      metadata: { last_cleanup: Date.now(), version: 1 },
    };
    saveSessions(initial);
    return initial;
  }
  return JSON.parse(readFileSync(file, 'utf-8')) as SessionsFile;
}

function saveSessions(data: SessionsFile): void {
  const file = getSessionsFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  // writeFileSync only applies mode on file creation; chmod on every write
  // ensures stricter perms even if the file was created externally.
  try {
    chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

export function getSession(token: string): SessionData | undefined {
  return loadSessions().sessions[token];
}

export function createSession(token: string, expiresAt: number, ip?: string): void {
  const data = loadSessions();
  data.sessions[token] = {
    expires_at: expiresAt,
    created_at: Date.now(),
    ip,
  };
  saveSessions(data);
}

export function extendSession(token: string, newExpiresAt: number): void {
  const data = loadSessions();
  if (!(token in data.sessions)) return;
  data.sessions[token].expires_at = newExpiresAt;
  saveSessions(data);
}

export function deleteSession(token: string): void {
  const data = loadSessions();
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- token-keyed session store
  delete data.sessions[token];
  saveSessions(data);
}

/** Used after change-password to log out every other session. */
export function deleteAllSessionsExcept(exceptToken?: string): void {
  const data = loadSessions();
  for (const token of Object.keys(data.sessions)) {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- token-keyed session store
    if (token !== exceptToken) delete data.sessions[token];
  }
  saveSessions(data);
}

export function cleanupExpiredSessions(): number {
  const data = loadSessions();
  const now = Date.now();
  let removed = 0;
  for (const [token, session] of Object.entries(data.sessions)) {
    if (now > session.expires_at) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- token-keyed session store
      delete data.sessions[token];
      removed++;
    }
  }
  if (removed > 0) {
    data.metadata.last_cleanup = now;
    saveSessions(data);
  }
  return removed;
}
