import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { getSession, createSession, deleteSession, extendSession, cleanupExpiredSessions, deleteAllSessionsExcept } from "./services/sessions.js";
import { verifyApiToken } from "./services/api-keys.js";
import { verifyPassword, hashPassword, generateSalt, validateNewPassword } from "./utils/password.js";
import { updateEnvFile } from "./utils/env-writer.js";
import { getClientKey } from "./utils/client-ip.js";
import { isIpAllowed, isPrivateOrLoopback } from "./utils/ip-allowlist.js";
import { readAgentSettings } from "./services/agent-settings.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("auth");

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

// ── Bearer token helpers ────────────────────────────────────────────

/**
 * Extract a `cbk_` API token from the Authorization header, if present.
 * Returns undefined when the header is absent or not a Bearer scheme.
 */
function getBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return undefined;
  return token;
}

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
  // Bearer API keys can validate themselves here too (e.g. a "test
  // connection" button in an external integration).
  const bearerToken = getBearerToken(req);
  if (bearerToken) {
    const apiKey = verifyApiToken(bearerToken);
    return res.json({ authenticated: !!apiKey });
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

/**
 * The remote-access IP allowlist, as its own middleware — and mounted **before**
 * the login route, which is the whole reason it is separate.
 *
 * It used to be the first block inside {@link requireAuth}, whose comment said
 * it "applies to ALL /api routes (including login), so a non-allowlisted remote
 * client can't even reach the login endpoint". That was false twice over, and
 * neither half was checked by anything:
 *
 * - `app.use("/api", requireAuth)` is registered **after**
 *   `/api/auth/login`, `/api/auth/logout` and `/api/auth/check`, so the
 *   middleware never ran for them at all. Measured against a settings file
 *   allowlisting one address that was not the caller's: `/api/system-info`
 *   returned 403, `/api/auth/login` returned **401** — it had reached the
 *   password check — and `/api/auth/check` returned **200**.
 * - Even had it run, the pass-through below it compared `req.path` against
 *   `"/api/auth/login"`. Under `app.use("/api", …)` Express rewrites the url to
 *   the mount-relative `"/auth/login"`, so that comparison could never match
 *   either.
 *
 * Login is the endpoint an allowlist most exists to protect: it is the one an
 * off-list client can attack without a credential. Per-IP login throttling is
 * not a substitute — through the tunnel every request arrives from loopback and
 * the client's own `X-Forwarded-For` picks the bucket, so an attacker can mint
 * fresh ones by varying one header. That is correct for rate limiting (see
 * `utils/client-ip.ts`) and it is exactly why the address gate has to come
 * first.
 *
 * Loopback and private/LAN clients are never gated, and an empty or absent
 * allowlist means no restriction. See `utils/ip-allowlist.ts`.
 */
export function requireAllowedIp(req: Request, res: Response, next: NextFunction) {
  const clientIp = getClientKey(req);
  if (isPrivateOrLoopback(clientIp)) return next();

  // `readAgentSettings`, not `getAgentSettings`, and the distinction is the
  // whole of this branch.
  //
  // `getAgentSettings` folds "no file" and "file exists and did not parse"
  // into the same `{ proxyMode: "local" }` — a valid object with
  // `remoteAccessIpAllowlist` absent, which `?? []` turns into the empty
  // list, which `isIpAllowed` reads as **no restriction**. It swallows the
  // error internally, so there was nothing here to catch: a truncated write
  // or a `chmod 000` silently removed an operator's IP restriction. Measured:
  // a request from an off-list public address got 200 against a corrupt
  // settings file that listed a single allowlist entry.
  //
  // A setting whose absence means "allowed" cannot be read through a channel
  // that returns absence on failure. This reads the state explicitly and
  // refuses on `unreadable`, while still treating a genuinely missing file as
  // the documented default of no restriction.
  //
  // The cost is real and is accepted: an operator who reaches this daemon
  // only through the tunnel is locked out until the file is repaired. It is
  // the right way round — the alternative silently drops the restriction —
  // and it is survivable because loopback and LAN clients are never gated at
  // all, so a shell or a browser on the same network still gets in.
  const { settings, state, error } = readAgentSettings();
  if (state === "unreadable") {
    log.error(`Refusing remote client ${clientIp}: agent-settings.json exists but could not be read (${error ?? "unknown error"}), so the IP allowlist is unknown`);
    return res.status(403).json({
      error: `Access denied: Callboard's settings file exists but could not be read (${error ?? "unknown error"}), so it cannot tell whether your address is on the allowlist — and it will not assume it is. Fix or remove agent-settings.json from a local or LAN client, which is never gated.`,
    });
  }
  if (!isIpAllowed(clientIp, settings.remoteAccessIpAllowlist ?? [])) {
    return res.status(403).json({ error: "Access denied: your IP is not on the allowlist." });
  }
  next();
}

/**
 * Session / bearer-key authentication for every `/api` route registered after
 * it — which deliberately does not include login, logout or auth-check.
 *
 * Those three are registered earlier in `index.ts` and so never reach this. The
 * pass-through that used to sit here for them was doubly dead (unreachable, and
 * comparing a path that could not match under the mount) and is gone with the
 * allowlist it followed; {@link requireAllowedIp} is what now runs ahead of
 * them.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!isPasswordConfigured()) {
    return res.status(503).json({ error: "Server misconfigured: no password is set." });
  }

  // Bearer API keys are accepted alongside session cookies. When an
  // Authorization header is present it takes precedence — no fallthrough to
  // the cookie, so an invalid/expired key fails loudly instead of silently
  // riding a browser session.
  const bearerToken = getBearerToken(req);
  if (bearerToken) {
    const apiKey = verifyApiToken(bearerToken);
    if (!apiKey) {
      return res.status(401).json({ error: "Invalid or expired API key" });
    }
    res.locals.authMethod = "bearer";
    res.locals.apiKeyId = apiKey.id;
    return next();
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
  res.locals.authMethod = "session";

  next();
}

/**
 * Guard for routes that manage credentials (e.g. the API-key CRUD routes):
 * only a cookie session — someone who logged in with the password — may use
 * them. A bearer key minting more bearer keys would defeat expiry/revocation.
 */
export function requireSessionAuth(req: Request, res: Response, next: NextFunction) {
  if (res.locals.authMethod !== "session") {
    return res.status(403).json({ error: "This endpoint requires a logged-in session, not an API key." });
  }
  next();
}
