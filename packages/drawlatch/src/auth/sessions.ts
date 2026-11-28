import { randomBytes } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  rmSync,
} from 'node:fs';
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
//
// Three safeguards stand between a request value and the map: this format check, the
// null-prototype map, and the own-key lookup. Each alone blocks the bypass; the redundancy is
// intentional, so don't remove one because the others (or the tests) seem to cover it.
const SESSION_TOKEN_RE = /^[0-9a-f]{64}$/;

function isSessionToken(token: unknown): token is string {
  return typeof token === 'string' && SESSION_TOKEN_RE.test(token);
}

function emptySessions(): Record<string, SessionData> {
  return Object.create(null) as Record<string, SessionData>;
}

function freshStore(): SessionsFile {
  return { sessions: emptySessions(), metadata: { last_cleanup: Date.now(), version: 1 } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Never throws on a bad file: an unreadable, unparseable or wrong-shape `sessions.json` loads as a
 * fresh empty store (logged at warn), so a truncated file can't 500 every request, login included.
 * This fails closed: an empty store holds no session, and the next save replaces the bad file.
 */
function loadSessions(): SessionsFile {
  const file = getSessionsFile();
  if (!existsSync(file)) {
    const initial = freshStore();
    saveSessions(initial);
    return initial;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf-8'));
  } catch (err) {
    console.warn(`[auth] ${file} is unreadable (${(err as Error).message}); using an empty store`);
    return freshStore();
  }
  if (
    !isPlainObject(parsed) ||
    !isPlainObject(parsed.sessions) ||
    !isPlainObject(parsed.metadata)
  ) {
    console.warn(`[auth] ${file} does not have the expected shape; using an empty store`);
    return freshStore();
  }
  // A null-prototype map has no inherited keys, and an own "__proto__" key parsed from the file
  // stays plain data when copied onto it.
  return {
    sessions: Object.assign(emptySessions(), parsed.sessions),
    metadata: parsed.metadata as SessionsFile['metadata'],
  };
}

/** Atomic: writes a 0600 temp file in the same directory, then renames it over the store. */
function saveSessions(data: SessionsFile): void {
  const file = getSessionsFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  // The temp file is created 0600, but chmod anyway so the store stays 0600 even if the umask or
  // filesystem ignored the mode.
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
    // Also drop keys that could never be presented (e.g. a hand-written "__proto__").
    if (!isSessionToken(token) || !isLive(session, now)) {
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
