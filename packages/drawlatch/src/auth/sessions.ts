import { randomBytes } from 'node:crypto';
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

/**
 * Every token `createSession` mints is 32 random bytes as lowercase hex. Anything else is rejected
 * before it is used as a key. Without this, a cookie such as `constructor`, `toString` or
 * `__proto__` reads an inherited member off the sessions object: its `expires_at` is `undefined`,
 * `Date.now() > undefined` is false, and the request is treated as authenticated. Extending such
 * a "session" would then write `expires_at` onto `Object.prototype`. cookie-parser also turns
 * `j:`-prefixed cookie values into JSON objects, so callers must not assume the token is a string.
 */
const SESSION_TOKEN_RE = /^[0-9a-f]{64}$/;

function isSessionToken(token: unknown): token is string {
  return typeof token === 'string' && SESSION_TOKEN_RE.test(token);
}

function emptySessions(): Record<string, SessionData> {
  return Object.create(null) as Record<string, SessionData>;
}

function loadSessions(): SessionsFile {
  const file = getSessionsFile();
  if (!existsSync(file)) {
    const initial: SessionsFile = {
      sessions: emptySessions(),
      metadata: { last_cleanup: Date.now(), version: 1 },
    };
    saveSessions(initial);
    return initial;
  }
  const data = JSON.parse(readFileSync(file, 'utf-8')) as SessionsFile;
  const stored: unknown = data.sessions;
  // A null-prototype map has no inherited keys, and an own "__proto__" key parsed from the file
  // stays plain data when copied onto it.
  data.sessions = Object.assign(
    emptySessions(),
    typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored : {},
  );
  return data;
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

/** The stored entry for a well-formed token, or undefined. Never reads an inherited member. */
function storedSession(data: SessionsFile, token: unknown): SessionData | undefined {
  if (!isSessionToken(token) || !Object.hasOwn(data.sessions, token)) return undefined;
  return data.sessions[token];
}

/** Fails closed: a malformed entry (missing, non-numeric or non-finite expiry) is not live. */
function isLive(session: unknown, now: number): session is SessionData {
  if (typeof session !== 'object' || session === null) return false;
  const expiresAt = (session as { expires_at?: unknown }).expires_at;
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && now < expiresAt;
}

/**
 * The single validity check: returns the session only if the token is well formed, stored, and
 * not expired. An expired or malformed stored entry is deleted.
 */
export function getSession(token: unknown): SessionData | undefined {
  const data = loadSessions();
  const session = storedSession(data, token);
  if (session === undefined) return undefined;
  if (isLive(session, Date.now())) return session;
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- token-keyed session store
  delete data.sessions[token as string];
  saveSessions(data);
  return undefined;
}

/** Mints a new session token, stores it, and returns it. The only place tokens are generated. */
export function createSession(expiresAt: number, ip?: string): string {
  const token = randomBytes(32).toString('hex');
  const data = loadSessions();
  data.sessions[token] = {
    expires_at: expiresAt,
    created_at: Date.now(),
    ip,
  };
  saveSessions(data);
  return token;
}

/** Returns true if a live session was extended; false (and no write) otherwise. */
export function extendSession(token: unknown, newExpiresAt: number): boolean {
  const data = loadSessions();
  const session = storedSession(data, token);
  if (!isLive(session, Date.now())) return false;
  session.expires_at = newExpiresAt;
  saveSessions(data);
  return true;
}

export function deleteSession(token: unknown): void {
  const data = loadSessions();
  if (storedSession(data, token) === undefined) return;
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- token-keyed session store
  delete data.sessions[token as string];
  saveSessions(data);
}

/** Used after change-password to log out every other session. */
export function deleteAllSessionsExcept(exceptToken?: unknown): void {
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
    if (!isLive(session, now)) {
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
