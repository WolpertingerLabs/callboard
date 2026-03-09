import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { getSession, createSession, deleteSession, extendSession, cleanupExpiredSessions, deleteAllSessionsExcept } from "./services/sessions.js";
import { verifyPassword, hashPassword, generateSalt } from "./utils/password.js";
import { updateEnvFile } from "./utils/env-writer.js";

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
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "unknown";
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

  if (!newPassword) {
    return res.status(400).json({ error: "New password cannot be empty." });
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
