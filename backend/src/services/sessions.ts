import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../utils/paths.js";

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

let sessionsCache: SessionsFile | null = null;
let lastModified = 0;

function loadSessions(): SessionsFile {
  if (!existsSync(sessionsFilePath)) {
    const initialData: SessionsFile = {
      sessions: {},
      metadata: {
        last_cleanup: Date.now(),
        version: 1,
      },
    };
    saveSessions(initialData);
    return initialData;
  }

  const stats = statSync(sessionsFilePath);
  const currentModified = stats.mtime.getTime();

  if (!sessionsCache || currentModified !== lastModified) {
    const data = readFileSync(sessionsFilePath, "utf8");
    sessionsCache = JSON.parse(data);
    lastModified = currentModified;
  }

  return sessionsCache!;
}

function saveSessions(data: SessionsFile): void {
  writeFileSync(sessionsFilePath, JSON.stringify(data, null, 2));
  sessionsCache = data;
  lastModified = Date.now();
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

export function extendSession(token: string, newExpiresAt: number): void {
  const data = loadSessions();
  const session = data.sessions[token];
  if (session) {
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
