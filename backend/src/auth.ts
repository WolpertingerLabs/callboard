import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { getSession, createSession, deleteSession, extendSession, cleanupExpiredSessions } from "./services/sessions.js";

// Read password lazily so dotenv.config() in index.ts has time to load .env first
// (ES module imports are hoisted and run before dotenv.config)
function getPassword(): string | null {
  return process.env.AUTH_PASSWORD || null;
}

export function isPasswordConfigured(): boolean {
  return !!process.env.AUTH_PASSWORD;
}

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "ccui_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Rate limiting: track attempts per IP
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

// Extend (roll) a session: reset both the server-side expiry and the browser cookie
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

export function loginHandler(req: Request, res: Response) {
  const configuredPassword = getPassword();
  if (!configuredPassword) {
    return res.status(503).json({ error: "Server misconfigured: AUTH_PASSWORD is not set." });
  }

  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: "Too many attempts. Try again in a minute." });
  }

  const { password } = req.body;
  if (password !== configuredPassword) {
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
    return res.json({ authenticated: false, error: "Server misconfigured: AUTH_PASSWORD is not set." });
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

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Allow login/auth-check endpoints through
  if (req.path === "/api/auth/login" || req.path === "/api/auth/check" || req.path === "/api/auth/logout") {
    return next();
  }

  if (!isPasswordConfigured()) {
    return res.status(503).json({ error: "Server misconfigured: AUTH_PASSWORD is not set." });
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
