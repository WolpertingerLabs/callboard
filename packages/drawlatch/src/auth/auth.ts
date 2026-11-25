import { randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

import {
  getSession,
  createSession,
  deleteSession,
  extendSession,
  cleanupExpiredSessions,
  deleteAllSessionsExcept,
} from './sessions.js';
import { verifyPassword, hashPassword, generateSalt } from './password.js';
import { updateEnvFile } from './env-writer.js';

export const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? 'drawlatch_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const NO_PASSWORD_MESSAGE = 'Server misconfigured: no password set. Run: drawlatch set-password';

// ── Password helpers ────────────────────────────────────────────────

export function isPasswordConfigured(): boolean {
  return !!process.env.AUTH_PASSWORD_HASH;
}

async function verifyConfiguredPassword(password: string): Promise<boolean> {
  const storedHash = process.env.AUTH_PASSWORD_HASH;
  if (!storedHash) return false;
  const salt = process.env.AUTH_PASSWORD_SALT ?? '';
  return verifyPassword(password, storedHash, salt);
}

// ── Session helpers ─────────────────────────────────────────────────

function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    // No `secure` flag — the daemon serves the dashboard over HTTP on
    // loopback/LAN. Setting `secure: true` would prevent the cookie from
    // being sent.
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

/** Roll the session: extend server-side expiry and refresh the cookie. */
function rollSession(token: string, res: Response): void {
  extendSession(token, Date.now() + SESSION_TTL_MS);
  setSessionCookie(res, token);
}

// Best-effort startup cleanup. Skipped when no password is configured —
// the dashboard is locked in that case anyway, but the import is still
// performed by tests, where an empty data dir is fine.
try {
  cleanupExpiredSessions();
} catch {
  // sessions file may not exist yet on first run; cleanup is best-effort.
}

// ── Handlers ────────────────────────────────────────────────────────

export async function loginHandler(req: Request, res: Response): Promise<void> {
  if (!isPasswordConfigured()) {
    res.status(503).json({ error: NO_PASSWORD_MESSAGE });
    return;
  }

  const { password } = req.body ?? {};
  if (typeof password !== 'string' || password.length === 0) {
    res.status(400).json({ error: 'Password is required' });
    return;
  }

  const valid = await verifyConfiguredPassword(password);
  if (!valid) {
    res.status(401).json({ error: 'Invalid password' });
    return;
  }

  const token = randomBytes(32).toString('hex');
  const forwarded = req.headers['x-forwarded-for'];
  const firstForwarded =
    typeof forwarded === 'string' ? forwarded.split(',')[0]?.trim() : undefined;
  const ip = firstForwarded ?? req.ip;
  createSession(token, Date.now() + SESSION_TTL_MS, ip);
  setSessionCookie(res, token);
  res.json({ ok: true });
}

export function logoutHandler(req: Request, res: Response): void {
  const token = req.cookies[SESSION_COOKIE_NAME];
  if (token) deleteSession(token);
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}

export function checkAuthHandler(req: Request, res: Response): void {
  if (!isPasswordConfigured()) {
    res.status(503).json({
      authenticated: false,
      error: NO_PASSWORD_MESSAGE,
    });
    return;
  }
  const token = req.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    res.status(401).json({ authenticated: false });
    return;
  }
  const entry = getSession(token);
  if (!entry || Date.now() > entry.expires_at) {
    if (entry) deleteSession(token);
    res.status(401).json({ authenticated: false });
    return;
  }
  rollSession(token, res);
  res.json({ authenticated: true });
}

export async function changePasswordHandler(req: Request, res: Response): Promise<void> {
  const { currentPassword, newPassword } = req.body ?? {};

  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
    res.status(400).json({ error: 'Both currentPassword and newPassword are required.' });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: 'New password must be at least 8 characters.' });
    return;
  }

  const valid = await verifyConfiguredPassword(currentPassword);
  if (!valid) {
    res.status(401).json({ error: 'Current password is incorrect.' });
    return;
  }

  const salt = generateSalt();
  const hash = await hashPassword(newPassword, salt);

  updateEnvFile({ AUTH_PASSWORD_HASH: hash, AUTH_PASSWORD_SALT: salt });
  process.env.AUTH_PASSWORD_HASH = hash;
  process.env.AUTH_PASSWORD_SALT = salt;

  // Invalidate every session except the caller's, so other browsers/devices
  // are forced to re-authenticate with the new password.
  const currentToken = req.cookies[SESSION_COOKIE_NAME];
  deleteAllSessionsExcept(currentToken);

  res.json({ ok: true });
}

// ── Middleware ───────────────────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isPasswordConfigured()) {
    res.status(503).json({ error: NO_PASSWORD_MESSAGE });
    return;
  }

  const token = req.cookies[SESSION_COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }

  const entry = getSession(token);
  if (!entry || Date.now() > entry.expires_at) {
    if (entry) deleteSession(token);
    res.status(401).json({ error: 'Session expired' });
    return;
  }

  rollSession(token, res);
  next();
}
