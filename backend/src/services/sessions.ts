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

function loadSessions(): SessionsFile {
  return store.load();
}

function saveSessions(data: SessionsFile): void {
  store.save(data);
}

export function getSession(token: string): SessionData | undefined {
  const data = loadSessions();
  return data.sessions[token];
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

// Every cookie-authenticated request rolls its session. The stored expiry only
// needs to be roughly current, so skip the rewrite unless it moves by more than
// this — the same throttle api-keys applies to last_used_at.
const EXTEND_WRITE_THRESHOLD_MS = 60 * 1000;

export function extendSession(token: string, newExpiresAt: number): void {
  const data = loadSessions();
  const session = data.sessions[token];
  if (session && newExpiresAt - session.expires_at > EXTEND_WRITE_THRESHOLD_MS) {
    session.expires_at = newExpiresAt;
    saveSessions(data);
  }
}

export function deleteSession(token: string): void {
  const data = loadSessions();
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
    if (now > session.expires_at) {
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
