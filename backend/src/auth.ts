import { randomBytes, createHash } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

const PASSWORD = process.env.AUTH_PASSWORD || 'REDACTED_PASSWORD';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// In-memory session store
const sessions = new Map<string, { expiresAt: number }>();

// Rate limiting: track attempts per IP
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 3;
const WINDOW_MS = 60 * 1000; // 1 minute

function getClientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
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

export function loginHandler(req: Request, res: Response) {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  }

  const { password } = req.body;
  if (password !== PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = randomBytes(32).toString('hex');
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });

  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ ok: true });
}

export function logoutHandler(_req: Request, res: Response) {
  const token = _req.cookies?.session;
  if (token) sessions.delete(token);
  res.clearCookie('session', { path: '/' });
  res.json({ ok: true });
}

export function checkAuthHandler(req: Request, res: Response) {
  const token = req.cookies?.session;
  if (!token) return res.json({ authenticated: false });
  const entry = sessions.get(token);
  if (!entry || Date.now() > entry.expiresAt) {
    sessions.delete(token);
    return res.json({ authenticated: false });
  }
  res.json({ authenticated: true });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Allow login/auth-check endpoints through
  if (req.path === '/api/auth/login' || req.path === '/api/auth/check' || req.path === '/api/auth/logout') {
    return next();
  }

  const token = req.cookies?.session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const entry = sessions.get(token);
  if (!entry || Date.now() > entry.expiresAt) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Session expired' });
  }

  next();
}
