import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { getSession, createSession, deleteSession, extendSession, cleanupExpiredSessions, deleteAllSessionsExcept } from "./services/sessions.js";
import { verifyPassword, hashPassword, generateSalt, validateNewPassword } from "./utils/password.js";
import { updateEnvFile } from "./utils/env-writer.js";
import { getClientKey } from "./utils/client-ip.js";
import { isIpAllowed, isPrivateOrLoopback } from "./utils/ip-allowlist.js";
import { getAgentSettings } from "./services/agent-settings.js";

// ── Password helpers ────────────────────────────────────────────────

/** True when a hashed password is configured. */
export function isPasswordConfigured(): boolean {
  return !!process.env.AUTH_PASSWORD_HASH;
}

/**
 * Verify a submitted password against the configured credential.
 * Uses AUTH_PASSWORD_HASH + AUTH_PASSWORD_SALT with scrypt.
 */
async function verifyConfiguredPassword(password: string): Promise<boolean> {
  const storedHash = process.env.AUTH_PASSWORD_HASH;
  if (!storedHash) return false;
  const salt = process.env.AUTH_PASSWORD_SALT || "";
  return verifyPassword(password, storedHash, salt);
}

// ── Session constants ───────────────────────────────────────────────

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "callboard_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Rate limiting ───────────────────────────────────────────────────

const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 3;
const WINDOW_MS = 60 * 1000; // 1 minute

function getClientIp(req: Request): string {
  // Loopback-gated: trusts forwarding headers only for the local cloudflared tunnel,
  // otherwise keys on the direct socket address (local/LAN). See utils/client-ip.ts.
  return getClientKey(req);
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS) return false;
  entry.count++;
  return true;
}

// ── Session helpers ─────────────────────────────────────────────────

/** Extend (roll) a session: reset both the server-side expiry and the browser cookie. */
function rollSession(token: string, res: Response): void {
  const newExpiry = Date.now() + SESSION_TTL_MS;
  extendSession(token, newExpiry);
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

// Session cleanup on startup
cleanupExpiredSessions();

// ── Handlers ────────────────────────────────────────────────────────

export async function loginHandler(req: Request, res: Response) {
  if (!isPasswordConfigured()) {
    return res.status(503).json({ error: "Server misconfigured: no password is set." });
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a minute." });
  }

  const { password } = req.body;
  const valid = await verifyConfiguredPassword(password);
  if (!valid) {
    return res.status(401).json({ error: "Invalid password" });
  }

  const token = randomBytes(32).toString("hex");
  createSession(token, Date.now() + SESSION_TTL_MS, ip);

  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
  res.json({ ok: true });
}

export function logoutHandler(_req: Request, res: Response) {
  const token = _req.cookies?.[SESSION_COOKIE_NAME];
  if (token) deleteSession(token);
  res.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
}

export function checkAuthHandler(req: Request, res: Response) {
  if (!isPasswordConfigured()) {
    return res.json({ authenticated: false, error: "Server misconfigured: no password is set." });
  }
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) return res.json({ authenticated: false });
  const entry = getSession(token);
  if (!entry || Date.now() > entry.expires_at) {
    if (entry) deleteSession(token);
    return res.json({ authenticated: false });
  }

  // Auto-extend the session when actively checking auth status
  rollSession(token, res);

  res.json({ authenticated: true });
}

export async function changePasswordHandler(req: Request, res: Response) {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Both currentPassword and newPassword are required." });
  }

  const strength = validateNewPassword(newPassword);
  if (!strength.valid) {
    return res.status(400).json({ error: strength.error });
  }

  // Verify current password
  const valid = await verifyConfiguredPassword(currentPassword);
  if (!valid) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  // Hash the new password
  const salt = generateSalt();
  const hash = await hashPassword(newPassword, salt);

  // Write to .env
  updateEnvFile({
    AUTH_PASSWORD_HASH: hash,
    AUTH_PASSWORD_SALT: salt,
  });

  // Update process.env so the running server uses the new credentials immediately
  process.env.AUTH_PASSWORD_HASH = hash;
  process.env.AUTH_PASSWORD_SALT = salt;

  // Invalidate all sessions except the current one
  const currentToken = req.cookies?.[SESSION_COOKIE_NAME];
  deleteAllSessionsExcept(currentToken);

  res.json({ ok: true });
}

// ── Middleware ───────────────────────────────────────────────────────

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Remote-access IP allowlist — applies to ALL /api routes (including login),
  // so a non-allowlisted remote client can't even reach the login endpoint.
  // Local & LAN clients (loopback / private ranges) are never gated, and an
  // empty allowlist means no restriction. See utils/ip-allowlist.ts.
  const clientIp = getClientKey(req);
  if (!isPrivateOrLoopback(clientIp)) {
    const allowlist = getAgentSettings().remoteAccessIpAllowlist ?? [];
    if (!isIpAllowed(clientIp, allowlist)) {
      return res.status(403).json({ error: "Access denied: your IP is not on the allowlist." });
    }
  }

  // Allow login/auth-check endpoints through
  if (req.path === "/api/auth/login" || req.path === "/api/auth/check" || req.path === "/api/auth/logout") {
    return next();
  }

  if (!isPasswordConfigured()) {
    return res.status(503).json({ error: "Server misconfigured: no password is set." });
  }

  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  const entry = getSession(token);
  if (!entry || Date.now() > entry.expires_at) {
    if (entry) deleteSession(token);
    return res.status(401).json({ error: "Session expired" });
  }

  // Auto-extend the session on every authenticated request (rolling session)
  rollSession(token, res);

  next();
}
