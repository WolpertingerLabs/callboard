import { randomBytes } from "crypto";
import { mkdirSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../utils/paths.js";
import { createJsonFileStore } from "../utils/json-file-store.js";

const sessionsFilePath = join(DATA_DIR, "sessions.json");

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

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

const store = createJsonFileStore<SessionsFile>(sessionsFilePath, () => ({
  sessions: {},
  metadata: {
    last_cleanup: Date.now(),
    version: 1,
  },
}));

/**
 * The only shape `createSession` mints: 32 random bytes as lowercase hex.
 *
 * Every helper that takes a token from a request checks it against this before
 * indexing the store. `sessions` is parsed JSON, so a plain lookup would answer
 * `constructor`, `__proto__`, `toString`, ... with an inherited Object.prototype
 * member — a truthy "session" whose `expires_at` is undefined.
 */
const SESSION_TOKEN_RE = /^[0-9a-f]{64}$/;

function isSessionToken(token: unknown): token is string {
  return typeof token === "string" && SESSION_TOKEN_RE.test(token);
}

function loadSessions(): SessionsFile {
  const data = store.load();
  // Defense in depth behind the token format check: a null-prototype map has
  // no inherited keys to find. Done once per parse; the store caches the result.
  if (Object.getPrototypeOf(data.sessions) !== null) {
    data.sessions = Object.assign(Object.create(null) as Record<string, SessionData>, data.sessions);
  }
  return data;
}

function saveSessions(data: SessionsFile): void {
  store.save(data);
}

/** The stored entry for a well-formed token the store actually owns, live or not. */
function storedSession(data: SessionsFile, token: unknown): SessionData | undefined {
  if (!isSessionToken(token) || !Object.hasOwn(data.sessions, token)) return undefined;
  return data.sessions[token];
}

/**
 * The absolute lifetime of a session, however actively it is used. Sessions
 * roll (`extendSession` on every cookie-authenticated request), so without this
 * a stolen cookie that is kept warm never expires.
 */
export const SESSION_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The latest instant a session may live until, or undefined when `created_at` is unusable. */
function lifetimeCap(session: SessionData): number | undefined {
  const createdAt: unknown = session.created_at;
  return isFiniteNumber(createdAt) ? createdAt + SESSION_MAX_LIFETIME_MS : undefined;
}

/**
 * Fails closed: an entry is live only while `now` is strictly before a finite
 * numeric `expires_at` AND strictly before `created_at` + the absolute
 * lifetime. A missing, non-numeric or NaN value for either means dead.
 *
 * Missing `created_at` is treated as dead rather than grandfathered:
 * `createSession` has written it since sessions moved to this file, so an entry
 * without one was not minted by this code, and "no start date" must not read as
 * "no cap". The cost is one re-login for such an entry.
 */
function isLive(session: SessionData | undefined, now: number): session is SessionData {
  if (typeof session !== "object" || session === null) return false;
  const expiresAt: unknown = session.expires_at;
  const cap = lifetimeCap(session);
  return isFiniteNumber(expiresAt) && now < expiresAt && cap !== undefined && now < cap;
}

/**
 * The live session for a request-supplied token, or undefined. This is the
 * whole validity check — callers must not re-derive it. A stored entry that is
 * expired or malformed is deleted on the way out.
 *
 * The store is loaded before the token is looked at, so a call with any token
 * (even "") still throws when sessions.json cannot be read; the
 * change-password handler relies on that as its readability probe.
 */
export function getSession(token: unknown): SessionData | undefined {
  const data = loadSessions();
  const session = storedSession(data, token);
  if (!session) return undefined;
  if (isLive(session, Date.now())) return session;
  delete data.sessions[token as string];
  saveSessions(data);
  return undefined;
}

/** Mint a session and return its token — the only place tokens are generated. */
export function createSession(expiresAt: number, ip?: string): string {
  const token = randomBytes(32).toString("hex");
  const data = loadSessions();
  data.sessions[token] = {
    expires_at: expiresAt,
    created_at: Date.now(),
    ip,
  };
  saveSessions(data);
  return token;
}

// Every cookie-authenticated request rolls its session. The stored expiry only
// needs to be roughly current, so skip the rewrite unless it moves by more than
// this — the same throttle api-keys applies to last_used_at.
const EXTEND_WRITE_THRESHOLD_MS = 60 * 1000;

/**
 * Roll a live session's expiry forward, never past its absolute lifetime cap.
 * Returns the clamped expiry to give the cookie, or undefined when the token is
 * not a live session. (The stored value can trail it by up to the write
 * throttle; the cap is exact in both.)
 */
export function extendSession(token: string, newExpiresAt: number): number | undefined {
  const data = loadSessions();
  const session = storedSession(data, token);
  if (!isLive(session, Date.now())) return undefined;
  // isLive guarantees a usable created_at.
  const cap = lifetimeCap(session)!;
  const target = Math.min(newExpiresAt, cap);
  if (target - session.expires_at > EXTEND_WRITE_THRESHOLD_MS) {
    session.expires_at = target;
    saveSessions(data);
  }
  return target;
}

export function deleteSession(token: string): void {
  const data = loadSessions();
  if (!storedSession(data, token)) return;
  delete data.sessions[token];
  saveSessions(data);
}

/**
 * Delete all sessions except the one with the given token.
 * Used when changing the password to invalidate all other sessions.
 */
export function deleteAllSessionsExcept(exceptToken?: string): void {
  const data = loadSessions();
  const tokens = Object.keys(data.sessions);
  for (const token of tokens) {
    if (token !== exceptToken) {
      delete data.sessions[token];
    }
  }
  saveSessions(data);
}

export function cleanupExpiredSessions(): number {
  const data = loadSessions();
  const now = Date.now();
  let removedCount = 0;

  for (const [token, session] of Object.entries(data.sessions)) {
    if (!isLive(session, now)) {
      delete data.sessions[token];
      removedCount++;
    }
  }

  if (removedCount > 0) {
    data.metadata.last_cleanup = now;
    saveSessions(data);
  }

  return removedCount;
}
