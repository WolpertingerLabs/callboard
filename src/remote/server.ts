/**
 * Remote Secure Server — the secrets-holding side.
 *
 * Runs as an HTTP server (localhost or remote). Holds secrets and only
 * communicates through encrypted channels established via mutual auth.
 *
 * This server:
 *   - Authenticates incoming MCP proxy clients via Ed25519 signatures
 *   - Establishes encrypted channels via X25519 ECDH + AES-256-GCM
 *   - Receives encrypted tool requests, injects secrets, executes, encrypts results
 *   - Never exposes secrets in plaintext over the wire
 *   - Maintains an audit log of all operations
 *   - Rate-limits requests per session
 */

import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import express from 'express';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadRemoteConfig,
  resolveRoutes,
  connectorWithholdingWarnings,
  resolveCallerRoutes,
  validateRemoteConfig,
  connectionOverlapWarnings,
  resolveSecrets,
  getEnvFilePath,
  getRemoteConfigPath,
  type RemoteServerConfig,
  type CallerConfig,
  type ResolvedRoute,
} from '../shared/config.js';
import {
  loadKeyBundle,
  loadPublicKeys,
  EncryptedChannel,
  type PublicKeyBundle,
} from '../shared/crypto/index.js';
import {
  HandshakeResponder,
  type HandshakeInit,
  type HandshakeFinish,
  type ProxyRequest,
  type ProxyResponse,
} from '../shared/protocol/index.js';
import {
  getCallerKeysDir,
  getServerKeysDir,
  SHUTDOWN_FLUSH_MS,
  SHUTDOWN_FORCE_EXIT_MS,
} from '../shared/config.js';
import { IngestorManager } from './ingestors/index.js';
import { callerRequiredSecrets, listConnectionTemplates } from '../shared/connections.js';
import { googleBootNotes } from '../shared/google.js';
import { isSecretSetForCaller } from '../shared/env-utils.js';
import { beginAuditShutdown, flushQuotaMarkersWithin, resumeAuditIngest } from './audit-log.js';
import { toolHandlers, type ToolContext } from './tool-dispatch.js';
import { releaseAllWaits, resumeWaits } from './wait-for-events.js';
import { setTunnelUrl, getTunnelUrl } from './tunnel-state.js';
import { migrateConfigDir } from '../shared/migrations.js';
import { maybeIssueLocalCaller } from './caller-bootstrap.js';
import { createAdminRouter } from './admin.js';
import {
  loginHandler,
  logoutHandler,
  checkAuthHandler,
  changePasswordHandler,
  requireAuth,
} from '../auth/auth.js';

// ── Environment loading ─────────────────────────────────────────────────────

/** Load environment from ~/.drawlatch/.env, falling back to cwd .env (legacy). */
function loadEnvFile(): void {
  const configDirEnvPath = getEnvFilePath();
  if (fs.existsSync(configDirEnvPath)) {
    dotenv.config({ path: configDirEnvPath, quiet: true });
    return;
  }
  // Backward compat: fall back to cwd .env
  const result = dotenv.config({ quiet: true });
  if (result.parsed) {
    console.warn(
      `[remote] Loaded .env from working directory. ` +
        `Move it to ${configDirEnvPath} for portable operation.`,
    );
  }
}

loadEnvFile();

// ── Types ──────────────────────────────────────────────────────────────────

/** An authorized peer with its alias and optional display name */
export interface AuthorizedPeer {
  /** Caller alias — the key from the callers config object */
  alias: string;
  /** Human-readable name for audit logs */
  name?: string;
  /** The peer's public keys (signing + exchange) */
  keys: PublicKeyBundle;
}

export interface Session {
  channel: EncryptedChannel;
  /** Caller alias for this session (from the matched AuthorizedPeer) */
  callerAlias: string;
  /** Per-caller resolved routes for this session */
  resolvedRoutes: ResolvedRoute[];
  createdAt: number;
  lastActivity: number;
  requestCount: number;
  /** Requests in the current rate-limit window */
  windowRequests: number;
  windowStart: number;
}

export interface PendingHandshake {
  responder: HandshakeResponder;
  init: HandshakeInit;
  createdAt: number;
}

/** Sanitized session projection — never includes channel keys or resolved
 *  routes (which carry decrypted secrets). Returned by getSessionsSnapshot()
 *  for the read-only /admin API. */
export interface SessionSnapshot {
  /** First 12 chars of the session ID — enough to disambiguate, doesn't
   *  expose enough material to forge or replay encrypted requests. */
  sessionIdShort: string;
  callerAlias: string;
  createdAt: number;
  lastActivity: number;
  requestCount: number;
  windowRequests: number;
  windowStart: number;
}

// ── State ──────────────────────────────────────────────────────────────────

const sessions = new Map<string, Session>();
const pendingHandshakes = new Map<string, PendingHandshake>();

let rateLimitPerMinute = 240;

/** Read package.json version once at module load. */
const PKG_VERSION: string = (() => {
  try {
    const raw = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

/** Resolve the listen port from DRAWLATCH_PORT (env override) or fall back to
 *  the configured port. Guards against non-numeric env values that would
 *  otherwise be silently coerced to NaN by parseInt. */
function resolvePort(envValue: string | undefined, fallback: number): number {
  if (envValue === undefined) return fallback;
  const parsed = parseInt(envValue, 10);
  if (Number.isNaN(parsed)) {
    console.warn(
      `[remote] Ignoring DRAWLATCH_PORT="${envValue}" (not a number); falling back to configured port ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

/** Loopback guard — used by /events/stream, /admin.
 *  Hoisted to module scope so the admin router and its tests can reuse it. */
export function requireLoopback(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const addr = req.socket.remoteAddress;
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') {
    next();
  } else {
    res.status(403).json({ error: 'Forbidden: local access only' });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Load authorized peers from per-caller config.
 * Caller public keys are loaded from keys/callers/<alias>/.
 */
function loadCallerPeers(callers: Record<string, CallerConfig>): AuthorizedPeer[] {
  const peers: AuthorizedPeer[] = [];
  const callersDir = getCallerKeysDir();

  for (const [alias, caller] of Object.entries(callers)) {
    const keysDir = path.join(callersDir, alias);
    if (!fs.existsSync(keysDir)) {
      console.error(`[remote] Caller keys not found for "${alias}": ${keysDir}`);
      continue;
    }
    try {
      peers.push({ alias, name: caller.name, keys: loadPublicKeys(keysDir) });
      console.log(`[remote] Loaded authorized peer: ${alias}`);
    } catch (err) {
      console.error(`[remote] Failed to load peer ${alias}:`, err);
    }
  }

  if (peers.length === 0 && Object.keys(callers).length > 0) {
    console.error(
      '[remote] WARNING: No authorized peers loaded. No clients will be able to connect.',
    );
    console.error('[remote] Check peer key directories in remote.config.json.');
  }

  return peers;
}

function auditLog(sessionId: string, action: string, details: Record<string, unknown> = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    sessionId: sessionId.substring(0, 12) + '...',
    action,
    ...details,
  };

  console.log(`[audit] ${JSON.stringify(entry)}`);
}

export function checkRateLimit(
  session: Pick<Session, 'windowRequests' | 'windowStart'>,
  limit: number,
): boolean {
  const now = Date.now();
  const windowMs = 60_000;

  if (now - session.windowStart > windowMs) {
    session.windowStart = now;
    session.windowRequests = 0;
  }

  session.windowRequests++;
  return session.windowRequests <= limit;
}

/**
 * Whole seconds until the session's rate-limit window resets, minimum 1.
 * Sent as `Retry-After` on a per-session 429 so clients can back off precisely
 * instead of guessing.
 */
export function retryAfterSeconds(
  session: Pick<Session, 'windowStart'>,
  now: number = Date.now(),
): number {
  const resetAt = session.windowStart + 60_000;
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

// ── Session cleanup ────────────────────────────────────────────────────────

export const SESSION_TTL = 30 * 60 * 1000; // 30 minutes
export const HANDSHAKE_TTL = 30 * 1000; // 30 seconds

export function cleanupSessions(
  sessionsMap: Map<string, Pick<Session, 'lastActivity'>>,
  pendingMap: Map<string, Pick<PendingHandshake, 'createdAt'>>,
  now: number = Date.now(),
): { expiredSessions: string[]; expiredHandshakes: string[] } {
  const expiredSessions: string[] = [];
  const expiredHandshakes: string[] = [];

  for (const [id, session] of sessionsMap) {
    if (now - session.lastActivity > SESSION_TTL) {
      const caller = 'callerAlias' in session ? (session as Session).callerAlias : undefined;
      auditLog(id, 'session_expired', caller ? { caller } : {});
      sessionsMap.delete(id);
      expiredSessions.push(id);
    }
  }

  for (const [id, hs] of pendingMap) {
    if (now - hs.createdAt > HANDSHAKE_TTL) {
      pendingMap.delete(id);
      expiredHandshakes.push(id);
    }
  }

  return { expiredSessions, expiredHandshakes };
}

// unref'd so merely importing this module (e.g. to resolve its path) doesn't
// hold the event loop open. The running daemon stays alive via its listening
// HTTP server.
setInterval(() => {
  cleanupSessions(sessions, pendingHandshakes);
}, 60_000).unref();

/**
 * Project the active sessions into a sanitized snapshot for read-only use.
 *
 * Drops `channel` (holds AES keys) and `resolvedRoutes` (carry decrypted
 * secrets). Used by the loopback /admin API; never call res.json(session).
 */
export function getSessionsSnapshot(): SessionSnapshot[] {
  const out: SessionSnapshot[] = [];
  for (const [id, s] of sessions) {
    out.push({
      sessionIdShort: id.substring(0, 12),
      callerAlias: s.callerAlias,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      requestCount: s.requestCount,
      windowRequests: s.windowRequests,
      windowStart: s.windowStart,
    });
  }
  return out;
}

// ── Session route invalidation ────────────────────────────────────────────

/**
 * Re-resolve routes for all active sessions belonging to a caller.
 * Called after secrets or connection list changes to ensure the session
 * uses up-to-date resolved routes without requiring a reconnection.
 */
function refreshCallerSessions(callerAlias: string): void {
  const config = loadRemoteConfig();
  const caller = config.callers[callerAlias] as CallerConfig | undefined;
  if (!caller) return;

  const callerRoutes = resolveCallerRoutes(config, callerAlias);
  const callerEnvResolved = resolveSecrets(caller.env ?? {});
  const callerResolvedRoutes = resolveRoutes(callerRoutes, callerEnvResolved, callerAlias);

  for (const session of sessions.values()) {
    if (session.callerAlias === callerAlias) {
      session.resolvedRoutes = callerResolvedRoutes;
    }
  }
}

// ── Express app ────────────────────────────────────────────────────────────

/** Options for creating the app — allows dependency injection for tests */
export interface CreateAppOptions {
  /** Override config instead of loading from disk */
  config?: RemoteServerConfig;
  /** Override key bundle instead of loading from disk */
  ownKeys?: import('../shared/crypto/index.js').KeyBundle;
  /** Override authorized peers instead of loading from disk */
  authorizedPeers?: AuthorizedPeer[];
  /** Override the ingestor manager instead of creating one from config */
  ingestorManager?: IngestorManager;
  /** Disable per-IP rate limiting (for tests that make many requests from localhost) */
  disableRateLimiting?: boolean;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = express();

  // Parse JSON for handshake endpoints (64kb limit — handshake messages are <2KB)
  app.use('/handshake', express.json({ limit: '64kb' }));

  // Raw buffer for encrypted request endpoint (50 MB to accommodate base64-encoded file uploads)
  app.use('/request', express.raw({ type: 'application/octet-stream', limit: '50mb' }));

  // Raw buffer for webhook endpoints (needed for signature verification)
  app.use('/webhooks', express.raw({ type: 'application/json', limit: '1mb' }));

  // ── Dashboard auth body/cookie parsers ───────────────────────────────────
  // Scoped to the dashboard surface only — the daemon keeps its per-route
  // body-parser pattern, so no global JSON parser is introduced. cookie-parser
  // is needed by requireAuth on both /api/auth and /api/admin to read the
  // session cookie; JSON parsing is needed only by the auth handlers.
  app.use('/api', cookieParser());
  app.use('/api/auth', express.json({ limit: '1mb' }));

  // ── Per-IP rate limiting for pre-auth endpoints ──────────────────────────
  // The per-session rate limit (checkRateLimit) only applies to authenticated
  // /request calls. These limiters protect unauthenticated endpoints against
  // volumetric abuse and brute-force attacks.
  if (!options.disableRateLimiting) {
    const ipRequestCounts = new Map<string, { windowStart: number; count: number }>();

    function getIpRateLimit(
      ip: string,
      windowMs: number,
      max: number,
    ): { allowed: boolean; remaining: number } {
      const now = Date.now();
      const key = `${ip}:${windowMs}:${max}`;
      let entry = ipRequestCounts.get(key);

      if (!entry || now - entry.windowStart > windowMs) {
        entry = { windowStart: now, count: 0 };
        ipRequestCounts.set(key, entry);
      }

      entry.count++;
      const allowed = entry.count <= max;
      return { allowed, remaining: Math.max(0, max - entry.count) };
    }

    function ipRateLimiter(windowMs: number, max: number) {
      return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
        const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
        const { allowed, remaining } = getIpRateLimit(ip, windowMs, max);

        res.setHeader('X-RateLimit-Limit', max);
        res.setHeader('X-RateLimit-Remaining', remaining);

        if (!allowed) {
          res.status(429).json({ error: 'Too many requests' });
          return;
        }
        next();
      };
    }

    app.use('/handshake', ipRateLimiter(60_000, 30));
    app.use('/webhooks', ipRateLimiter(60_000, 120));
    app.use('/health', ipRateLimiter(60_000, 60));
    // /api/admin is password-gated but the dashboard polls — give it more headroom than /health
    app.use('/api/admin', ipRateLimiter(60_000, 300));
  }

  const config = options.config ?? loadRemoteConfig();
  const ownKeys = options.ownKeys ?? loadKeyBundle(getServerKeysDir());
  const authorizedPeers = options.authorizedPeers ?? loadCallerPeers(config.callers);

  // Capture for /admin/meta. Resolves the same way main() picks the listen port.
  const startedAt = Date.now();
  const port = resolvePort(process.env.DRAWLATCH_PORT, config.port);

  rateLimitPerMinute = config.rateLimitPerMinute;

  // A host that ran gracefulShutdown() and builds a new app in the same
  // process must not inherit the old app's draining state.
  resumeWaits();
  resumeAuditIngest();

  // Create or use the provided ingestor manager.
  // When config is loaded from disk (production), pass loadRemoteConfig as the
  // config loader so startOne()/restartOne() read fresh config, picking up
  // changes made by tool handlers without requiring a server restart.
  // When config is injected via options (tests), omit the loader so the
  // IngestorManager uses the injected config snapshot.
  const configLoader = options.config ? undefined : loadRemoteConfig;
  const ingestorManager = options.ingestorManager ?? new IngestorManager(config, configLoader);
  app.locals.ingestorManager = ingestorManager;

  // Log connector and caller summary
  const connectorCount = config.connectors?.length ?? 0;
  const callerCount = Object.keys(config.callers).length;
  console.log(`[remote] ${connectorCount} custom connector(s), ${callerCount} caller(s)`);
  for (const [alias, caller] of Object.entries(config.callers)) {
    console.log(`[remote]   Caller "${alias}": ${caller.connections.length} connection(s)`);
  }
  console.log(`[remote] ${authorizedPeers.length} authorized peer(s)`);
  console.log(`[remote] Rate limit: ${rateLimitPerMinute} req/min per session`);

  // Boot-time connection health table: check required secrets for each caller's connections
  const templates = listConnectionTemplates();
  const templateMap = new Map(templates.map((t) => [t.alias, t]));

  for (const [callerAlias, caller] of Object.entries(config.callers)) {
    const secretIssues: string[] = [];

    for (const connName of caller.connections) {
      const tpl = templateMap.get(connName);
      if (!tpl) continue; // custom connector, skip

      for (const secret of callerRequiredSecrets(tpl, caller)) {
        const isSet = isSecretSetForCaller(secret, callerAlias, caller.env);
        if (!isSet) {
          secretIssues.push(`    ${connName.padEnd(16)} ${secret.padEnd(28)} [NOT SET]`);
        }
      }
    }

    if (secretIssues.length > 0) {
      console.log(`[remote] Connection secrets for "${callerAlias}":`);
      for (const issue of secretIssues) {
        console.log(issue);
      }
      console.log(`[remote] Set missing secrets in ${getEnvFilePath()}`);
    }
  }

  // Boot-time config check: invalid custom-connector oauth2 blocks,
  // oauth2Overrides entries and google selections, and removed template IDs.
  // Each one drops only that connection for that caller (see
  // resolveCallerRoutesChecked), so log them up front.
  for (const problem of validateRemoteConfig(config)) {
    console.error(`[remote] ${problem}`);
  }
  for (const note of googleBootNotes(config.callers)) {
    console.log(`[remote] Note: ${note}`);
  }
  for (const warning of connectionOverlapWarnings(config)) {
    console.warn(`[remote] Warning: ${warning}`);
  }

  // ── Handshake init ─────────────────────────────────────────────────────

  app.post('/handshake/init', (req, res) => {
    try {
      const init: HandshakeInit = req.body;
      const responder = new HandshakeResponder(
        ownKeys,
        authorizedPeers.map((p) => p.keys),
      );

      const { reply, initiatorPubKey } = responder.processInit(init);
      const sessionKeys = responder.deriveKeys(init);

      // Look up the caller alias by matching the returned PublicKeyBundle
      const matchedPeer = authorizedPeers.find((p) => p.keys === initiatorPubKey);
      const callerAlias = matchedPeer?.alias ?? 'unknown';

      // Reload config from disk so new sessions pick up changes made by tool
      // handlers (e.g. set_connection_enabled, set_secrets) without a restart.
      const freshConfig = options.config ?? loadRemoteConfig();

      // Resolve per-caller routes (with optional env overrides)
      const callerRoutes = resolveCallerRoutes(freshConfig, callerAlias);
      const caller = freshConfig.callers[callerAlias];
      const callerEnvResolved = resolveSecrets(caller.env ?? {});
      const callerResolvedRoutes = resolveRoutes(callerRoutes, callerEnvResolved, callerAlias);

      // Store pending handshake for the finish step
      pendingHandshakes.set(sessionKeys.sessionId, {
        responder,
        init,
        createdAt: Date.now(),
      });

      // Create the session preemptively (will be activated on finish)
      sessions.set(sessionKeys.sessionId, {
        channel: new EncryptedChannel(sessionKeys),
        callerAlias,
        resolvedRoutes: callerResolvedRoutes,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        requestCount: 0,
        windowRequests: 0,
        windowStart: Date.now(),
      });

      auditLog(sessionKeys.sessionId, 'handshake_init_ok', { caller: callerAlias });
      res.json(reply);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[remote] Handshake init failed:', message);
      res.status(403).json({ error: message });
    }
  });

  // ── Handshake finish ───────────────────────────────────────────────────

  app.post('/handshake/finish', (req, res) => {
    const sessionId = req.headers['x-session-id'] as string;
    if (!sessionId) {
      res.status(400).json({ error: 'Missing X-Session-Id header' });
      return;
    }

    const session = sessions.get(sessionId);
    const pending = pendingHandshakes.get(sessionId);

    if (!session || !pending) {
      res.status(404).json({ error: 'No pending handshake for this session' });
      return;
    }

    try {
      const finish: HandshakeFinish = req.body;
      // The responder's session keys already have the correct orientation:
      // recvKey decrypts messages from the initiator (which is what the finish msg is)
      const verified = pending.responder.verifyFinish(finish, session.channel.getKeys());

      if (!verified) {
        sessions.delete(sessionId);
        throw new Error('Finish verification failed — key derivation mismatch');
      }

      pendingHandshakes.delete(sessionId);
      auditLog(sessionId, 'handshake_complete', { caller: session.callerAlias });
      res.json({ status: 'established', sessionId });
    } catch (err) {
      pendingHandshakes.delete(sessionId);
      sessions.delete(sessionId);
      const message = err instanceof Error ? err.message : String(err);
      console.error('[remote] Handshake finish failed:', message);
      res.status(403).json({ error: message });
    }
  });

  // ── Encrypted request ──────────────────────────────────────────────────

  app.post('/request', async (req, res) => {
    const sessionId = req.headers['x-session-id'] as string;
    if (!sessionId) {
      res.status(400).send('Missing X-Session-Id header');
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      res.status(401).send('Unknown or expired session');
      return;
    }

    // Rate limit check
    if (!checkRateLimit(session, rateLimitPerMinute)) {
      auditLog(sessionId, 'rate_limited', { caller: session.callerAlias });
      res.set('Retry-After', String(retryAfterSeconds(session)));
      res.status(429).send('Rate limit exceeded');
      return;
    }

    session.lastActivity = Date.now();
    session.requestCount++;

    // Aborts when the client goes away before we respond, so long-held tools
    // (wait_for_events) release their waiter instead of holding until timeout.
    // `res` 'close' rather than `req` 'close': the latter fires as soon as the
    // request body has been consumed.
    const disconnect = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) disconnect.abort();
    });

    try {
      // Decrypt the request
      const encryptedBody = Buffer.from(req.body);
      const request = session.channel.decryptJSON<ProxyRequest>(encryptedBody);

      auditLog(sessionId, 'request', {
        caller: session.callerAlias,
        toolName: request.toolName,
        requestId: request.id,
      });

      // Dispatch to handler
      const handler = toolHandlers[request.toolName];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime validation for untrusted input
      if (!handler) {
        throw new Error(`Unknown tool: ${request.toolName}`);
      }

      const context: ToolContext = {
        callerAlias: session.callerAlias,
        origin: 'agent',
        ingestorManager: app.locals.ingestorManager as IngestorManager,
        refreshRoutes: () => refreshCallerSessions(session.callerAlias),
        sessionId,
        signal: disconnect.signal,
        // Absent on requests from older local proxies — that means "no clamp",
        // i.e. the pre-existing behavior, not a zero budget.
        ...(request.outboundBudgetMs !== undefined && {
          outboundBudgetMs: request.outboundBudgetMs,
        }),
      };
      const result = await handler(request.toolInput, session.resolvedRoutes, context);

      // Build and encrypt response
      const response: ProxyResponse = {
        type: 'proxy_response',
        id: request.id,
        success: true,
        result,
        timestamp: Date.now(),
      };

      const encrypted = session.channel.encryptJSON(response);

      auditLog(sessionId, 'response', {
        caller: session.callerAlias,
        toolName: request.toolName,
        requestId: request.id,
        success: true,
      });

      res.set('Content-Type', 'application/octet-stream');
      res.send(encrypted);
    } catch (err) {
      if (disconnect.signal.aborted) {
        // Nobody is listening; there is no response to send.
        auditLog(sessionId, 'client_disconnected', { caller: session.callerAlias });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[remote] Request error (${sessionId}):`, message);

      try {
        // Try to send an encrypted error response
        const errorResponse: ProxyResponse = {
          type: 'proxy_response',
          id: 'error',
          success: false,
          error: message,
          timestamp: Date.now(),
        };
        const encrypted = session.channel.encryptJSON(errorResponse);
        res.set('Content-Type', 'application/octet-stream');
        res.send(encrypted);
      } catch {
        // If encryption fails, the session is broken
        sessions.delete(sessionId);
        res.status(500).send('Session error');
      }
    }
  });

  // ── Health check (unencrypted, no secrets exposed) ─────────────────────

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      activeSessions: sessions.size,
      uptime: process.uptime(),
      // Public tunnel URL (not a secret) so `drawlatch status` and the start
      // command's tunnel-URL probe can surface it without authenticating.
      tunnelUrl: getTunnelUrl(),
    });
  });

  // ── Event stream (loopback-only, for `drawlatch watch`) ─────────────

  app.get('/events/stream', requireLoopback, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const mgr = app.locals.ingestorManager as IngestorManager;

    const listener = (event: import('./ingestors/types.js').IngestedEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    mgr.onEvent(listener);

    req.on('close', () => {
      mgr.offEvent(listener);
    });
  });

  // ── Dashboard auth routes ────────────────────────────────────────────
  // Public login/logout/check + auth-gated change-password. The scrypt
  // password is the trust boundary for the dashboard surface, replacing the
  // old loopback-only posture so it can be host-bound (DRAWLATCH_HOST=0.0.0.0)
  // while staying password-protected.
  //
  // Two rate limiters (same config as the former drawlatch-ui backend):
  //   - 3/min for the auth-mutating endpoints (login + change-password)
  //   - 20/min for the cheap, polling-friendly endpoints (check + logout)
  const loginLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 3,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Try again in a minute.' },
  });
  const checkLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Try again in a minute.' },
  });

  app.post('/api/auth/login', loginLimiter, loginHandler);
  app.post('/api/auth/logout', checkLimiter, logoutHandler);
  app.get('/api/auth/check', checkLimiter, checkAuthHandler);
  app.post('/api/auth/change-password', loginLimiter, requireAuth, changePasswordHandler);

  // ── Admin API (password-gated) ────────────────────────────────────────
  // Powers the merged dashboard at /api/admin/* (the path the frontend uses).
  // Mounted behind requireAuth — the password gate replaces the old loopback
  // guard. Read endpoints never expose secrets; mutating endpoints (item A) are
  // write-only for secrets and live-reload routes/ingestors after every change.
  // When no password is configured, requireAuth returns 503 and the SPA shows a
  // locked state (the daemon must never exit just because it is unconfigured).

  /** Resolve the live routes (with secrets) for a caller, for tool dispatch. */
  const resolveRoutesForCaller = (alias: string): ResolvedRoute[] => {
    const freshConfig = options.config ?? loadRemoteConfig();
    const caller = freshConfig.callers[alias] as CallerConfig | undefined;
    if (!caller) return [];
    const callerRoutes = resolveCallerRoutes(freshConfig, alias);
    const callerEnvResolved = resolveSecrets(caller.env ?? {});
    return resolveRoutes(callerRoutes, callerEnvResolved, alias);
  };

  /** Register or refresh the authorized peer for a (possibly new) caller. */
  const reloadPeer = (alias: string): void => {
    const freshConfig = options.config ?? loadRemoteConfig();
    const callerConfig = freshConfig.callers[alias] as CallerConfig | undefined;
    if (!callerConfig) return;
    for (const p of loadCallerPeers({ [alias]: callerConfig })) {
      const idx = authorizedPeers.findIndex((e) => e.alias === p.alias);
      if (idx >= 0) authorizedPeers[idx] = p;
      else authorizedPeers.push(p);
    }
  };

  /** Drop the authorized peer + any active sessions for a deleted caller. */
  const removePeer = (alias: string): void => {
    const idx = authorizedPeers.findIndex((e) => e.alias === alias);
    if (idx >= 0) authorizedPeers.splice(idx, 1);
    for (const [id, s] of sessions) {
      if (s.callerAlias === alias) sessions.delete(id);
    }
  };

  // Co-located callboard auto-share now happens at daemon boot via
  // maybeIssueLocalCaller() (write-to-path over the shared filesystem). The old
  // loopback `/sync/auto-enroll` enroll-token endpoint has been retired.

  /** Endpoint URL to pin in an issued bundle when the request omits one:
   *  the public tunnel URL if active, else the daemon's own host:port. */
  const defaultEndpointUrl = (): string => {
    const tunnel = getTunnelUrl();
    if (tunnel) return tunnel;
    const bindHost = process.env.DRAWLATCH_HOST ?? config.host;
    const reachable = bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost;
    return `http://${reachable}:${port}`;
  };

  // JSON body parsing for the mutating admin endpoints (cookie-parser for /api
  // is already installed above; the daemon keeps its per-route parser pattern).
  app.use('/api/admin', express.json({ limit: '1mb' }));

  app.use(
    '/api/admin',
    requireAuth,
    createAdminRouter({
      getSessionsSnapshot,
      ingestorManager: () => app.locals.ingestorManager as IngestorManager,
      loadConfig: () => options.config ?? loadRemoteConfig(),
      resolveRoutesForCaller,
      refreshCaller: refreshCallerSessions,
      reloadPeer,
      removePeer,
      audit: (action, details) => auditLog('admin', action, details ?? {}),
      defaultEndpointUrl,
      version: PKG_VERSION,
      port,
      startedAt,
    }),
  );

  // ── Webhook receiver ─────────────────────────────────────────────────

  // Trello (and potentially other services) send a HEAD request to the
  // callback URL to verify it is reachable before activating the webhook.
  // Respond with 200 if at least one ingestor is registered for the path.
  app.head('/webhooks/:path', (req, res) => {
    const webhookPath = req.params.path;
    const mgr = app.locals.ingestorManager as IngestorManager;
    const ingestors = mgr.getWebhookIngestors(webhookPath);

    if (ingestors.length === 0) {
      res.status(404).end();
    } else {
      res.status(200).end();
    }
  });

  app.post('/webhooks/:path', (req, res) => {
    const webhookPath = req.params.path;
    const mgr = app.locals.ingestorManager as IngestorManager;

    // Find all ingestor instances matching this webhook path
    const ingestors = mgr.getWebhookIngestors(webhookPath);

    if (ingestors.length === 0) {
      res.status(404).json({ error: `No webhook ingestor registered for path: ${webhookPath}` });
      return;
    }

    // Ensure we have a raw Buffer for signature verification
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

    // Fan out to all matching ingestors (multiple callers may share a webhook path)
    let anyAccepted = false;
    const results: { connection: string; accepted: boolean; reason?: string }[] = [];

    for (const ingestor of ingestors) {
      const result = ingestor.handleWebhook(
        req.headers as Record<string, string | string[] | undefined>,
        rawBody,
      );
      results.push({ connection: ingestor.webhookPath, ...result });
      if (result.accepted) anyAccepted = true;
    }

    // Return 200 if any ingestor accepted (GitHub retries on non-2xx)
    if (anyAccepted) {
      res.status(200).json({ received: true });
    } else {
      // Log details server-side for debugging; never expose ingestor internals to callers
      console.error('[remote] Webhook rejected by all ingestors:', JSON.stringify(results));
      res.status(403).json({ error: 'Webhook rejected' });
    }
  });

  // ── SPA serving ───────────────────────────────────────────────────────────
  // Mounted LAST, after every API and protocol route. Static assets are served
  // from frontend/dist; any unmatched GET/HEAD falls back to index.html so
  // client-side deep links resolve on reload.
  //
  // Express 5 removed string-pattern wildcards (`app.get("*", …)` throws), so
  // the SPA fallback is a terminal middleware instead. It skips the API and
  // protocol prefixes so unmatched routes there return their own status (e.g.
  // a JSON 404 from the admin router) rather than index.html.
  //
  // The mount is gated on the bundle existing on disk (rather than NODE_ENV),
  // so it works in any context where the SPA has been built — production
  // installs, local `npm start`, or a dev clone after `npm run build:frontend`.
  // In a pure dev workflow you should still use `vite` on its own port for
  // hot reload; this mount just makes hitting the daemon port directly do
  // something useful.
  const distDir = fileURLToPath(new URL('../../frontend/dist', import.meta.url));
  const indexHtml = path.join(distDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    const apiPrefixes = ['/api', '/handshake', '/request', '/events', '/webhooks', '/health'];

    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      if (apiPrefixes.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
        next();
        return;
      }
      // IMPORTANT: pass `root` instead of an absolute path. Express 5 / send 1.x
      // walk the absolute path components looking for "dotfiles" (segments
      // starting with "."), and the default dotfile policy is "ignore" — which
      // turns into a 404. When drawlatch is bundled inside callboard installed
      // under `~/.nvm/...`, the `.nvm` segment matches the dotfile rule and
      // every SPA deep-link reload becomes "Not Found". Routing the file
      // through `root` makes send only inspect the relative path's parts
      // (`./index.html`), so the dotfile guard never trips.
      res.sendFile('index.html', { root: distDir });
    });
  } else {
    console.warn(
      `[remote] Dashboard bundle not found at ${distDir}. ` +
        `Run \`npm run build:frontend\` (or reinstall drawlatch) to enable the dashboard UI; ` +
        `the daemon API will still work.`,
    );
  }

  return app;
}

// ── Shutdown ───────────────────────────────────────────────────────────────

/**
 * Graceful shutdown: answer held waits, write pending audit quota markers,
 * stop the tunnel, stop ingestors, then close the HTTP server and write any
 * markers added meanwhile. Resolves once the server has closed.
 *
 * Held `wait_for_events` requests are released first. Otherwise each one keeps
 * its request open for up to 55s, `server.close()` cannot finish, and the
 * forced-exit timer turns every restart into exit(1). Releasing also starts
 * draining: a client that re-polls on the reply gets "server shutting down"
 * and backs off instead of parking a fresh wait on (or spinning against) the
 * dying process.
 */
export async function gracefulShutdown(
  server: import('node:http').Server,
  ingestorManager: IngestorManager,
  stopTunnel?: () => Promise<void>,
): Promise<void> {
  const released = releaseAllWaits();
  if (released > 0) console.log(`[remote] Released ${released} held wait(s)`);

  // From here ingest_logs refuses new calls ("shutting down"), and a call
  // already in flight writes any quota_exceeded marker inline, so nothing
  // refused during shutdown is left pending. Then, before anything that can
  // stall (server.close() waits on every open socket), write what is pending,
  // bounded so a stuck disk can't stall shutdown.
  beginAuditShutdown();
  await flushQuotaMarkersWithin(SHUTDOWN_FLUSH_MS);

  // Stop tunnel first (fast — just kills a child process)
  setTunnelUrl(null);
  if (stopTunnel) {
    await stopTunnel().catch((err: unknown) => {
      console.error('[remote] Error stopping tunnel:', err);
    });
  }

  await ingestorManager.stopAll().catch((err: unknown) => {
    console.error('[remote] Error stopping ingestors:', err);
  });

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  // Again after close: retries a pre-close flush that failed or timed out.
  await flushQuotaMarkersWithin(SHUTDOWN_FLUSH_MS);
}

/**
 * Force exit if connections don't drain within SHUTDOWN_FORCE_EXIT_MS, after
 * a last bounded flush of quota_exceeded markers. `drawlatch stop` waits
 * STOP_KILL_AFTER_MS, which is derived from the same constants and longer
 * than this whole path, before it sends SIGKILL.
 */
export function armForcedExit(
  exit: (code: number) => void = (code) => process.exit(code),
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    console.error('[remote] Forced shutdown after timeout.');
    void exitAfterFlushingMarkers(exit);
  }, SHUTDOWN_FORCE_EXIT_MS);
  timer.unref();
  return timer;
}

/**
 * The forced-exit path: one last bounded flush of pending quota markers,
 * then exit(1). Finishes within SHUTDOWN_FLUSH_MS of being called, so with
 * SHUTDOWN_FORCE_EXIT_MS it stays inside the CLI's STOP_KILL_AFTER_MS.
 */
export async function exitAfterFlushingMarkers(
  exit: (code: number) => void = (code) => process.exit(code),
): Promise<void> {
  await flushQuotaMarkersWithin(SHUTDOWN_FLUSH_MS);
  exit(1);
}

// waitForTunnelReady is now exported from tunnel.ts — imported dynamically
// alongside startTunnel in the tunnel startup block below.

// ── Start ──────────────────────────────────────────────────────────────────

export function main(): void {
  console.log('[remote] Starting drawlatch server...');

  // Own our on-disk layout: migrate any legacy key directories before loading
  // keys/config (item G). Idempotent and safe on every startup.
  migrateConfigDir();

  // Pre-flight validation: check for common setup issues before starting
  const remoteConfigPath = getRemoteConfigPath();
  if (!fs.existsSync(remoteConfigPath)) {
    console.error(`[remote] Error: No remote config found at ${remoteConfigPath}`);
    console.error('[remote] Run: drawlatch init');
    process.exit(1);
  }

  const config = loadRemoteConfig();

  // Custom connectors that the header-only withholding rules affect. Warn,
  // don't fail: the connector still works for everything else.
  for (const connector of config.connectors ?? []) {
    for (const warning of connectorWithholdingWarnings(connector)) {
      console.error(`[remote] Warning: ${warning}`);
    }
  }

  const serverKeysDirPath = getServerKeysDir();
  const requiredKeyFiles = [
    'signing.key.pem',
    'signing.pub.pem',
    'exchange.key.pem',
    'exchange.pub.pem',
  ];
  const missingKeyFiles = requiredKeyFiles.filter(
    (f) => !fs.existsSync(path.join(serverKeysDirPath, f)),
  );
  if (missingKeyFiles.length > 0) {
    if (!fs.existsSync(serverKeysDirPath)) {
      console.error(`[remote] Error: Server keys not found at ${serverKeysDirPath}`);
    } else {
      console.error(`[remote] Error: Incomplete server keys in ${serverKeysDirPath}`);
      console.error(`[remote] Missing: ${missingKeyFiles.join(', ')}`);
    }
    console.error('[remote] Run: drawlatch generate-keys server');
    process.exit(1);
  }

  if (Object.keys(config.callers).length === 0) {
    console.log('[remote] No callers configured.');
    console.log(
      '[remote] To add callers, run: drawlatch issue-caller <alias> (or use the dashboard Callers page)',
    );
  }

  // First-boot auto-share: when supervised by a co-located callboard (which sets
  // DRAWLATCH_LOCAL_CALLER_KEYS_DIR), mint a default caller and write the unpacked
  // key files straight into callboard's keys dir. Idempotent (skipped once the
  // caller exists). Replaces the retired enroll-token / /sync/auto-enroll path.
  try {
    const local = maybeIssueLocalCaller();
    if (local) {
      console.log(
        `[remote] Auto-shared local caller "${local.alias}" → ${local.callerKeysDir} ` +
          `(fingerprint ${local.fingerprint})`,
      );
    }
  } catch (err) {
    console.warn('[remote] Could not auto-share local caller:', err);
  }

  const port = resolvePort(process.env.DRAWLATCH_PORT, config.port);
  const host = process.env.DRAWLATCH_HOST ?? config.host;
  // Self-managed tunnel: config flag OR env override (item C).
  const useTunnel = config.tunnel === true || process.env.DRAWLATCH_TUNNEL === '1';
  const app = createApp();
  const ingestorManager = app.locals.ingestorManager as IngestorManager;

  // Holds the tunnel stop function if a tunnel is active (set inside the
  // listen callback, read by the shutdown handler — both share this scope).
  let stopTunnel: (() => Promise<void>) | undefined;

  const server = app.listen(
    port,
    host,
    () =>
      void (async () => {
        console.log(`[remote] Secure remote server listening on ${host}:${port}`);
        console.log(`[remote] PID: ${process.pid}, Node: ${process.version}`);

        // If a tunnel was requested, start it before ingestors so that
        // process.env.DRAWLATCH_TUNNEL_URL is available during secret resolution.
        if (useTunnel) {
          try {
            const { startTunnel, waitForTunnelReady } = await import('./tunnel.js');
            const tunnel = await startTunnel({ port, host });
            stopTunnel = tunnel.stop;

            process.env.DRAWLATCH_TUNNEL_URL = tunnel.url;
            setTunnelUrl(tunnel.url);

            // Auto-populate callback URL env vars for webhook ingestors whose
            // connection templates reference an env var that is not yet set.
            for (const [callerAlias, _callerConfig] of Object.entries(config.callers)) {
              const rawRoutes = resolveCallerRoutes(config, callerAlias);
              for (const route of rawRoutes) {
                const callbackTpl = route.ingestor?.webhook?.callbackUrl;
                const webhookPath = route.ingestor?.webhook?.path;
                if (!callbackTpl || !webhookPath) continue;

                // Extract env var name from "${VAR}" pattern
                const match = /^\$\{(\w+)\}$/.exec(callbackTpl);
                if (match) {
                  const envVar = match[1];
                  const fullUrl = `${tunnel.url}/webhooks/${webhookPath}`;
                  // Set bare env var
                  if (!process.env[envVar]) {
                    process.env[envVar] = fullUrl;
                    console.log(`[remote] Auto-set ${envVar}=${fullUrl}`);
                  }
                  // Also set prefixed env var so caller-scoped secret resolution
                  // (which checks PREFIX_VAR, not bare VAR) can find it.
                  const prefix = callerAlias.toUpperCase().replace(/-/g, '_');
                  const prefixedEnvVar = `${prefix}_${envVar}`;
                  if (!process.env[prefixedEnvVar]) {
                    process.env[prefixedEnvVar] = fullUrl;
                    console.log(`[remote] Auto-set ${prefixedEnvVar}=${fullUrl}`);
                  }
                }
              }
            }

            console.log(`[remote] Tunnel active: ${tunnel.url}`);
            console.log(`[remote] Webhook URL:   ${tunnel.url}/webhooks/<path>`);

            // Wait for the tunnel to be fully connected before starting ingestors.
            // cloudflared reports the URL before the QUIC connection is established;
            // services like Trello validate the callback URL during registration.
            await waitForTunnelReady(tunnel.url, 10_000);
          } catch (err) {
            console.error('[remote] Failed to start tunnel:', err);
            console.error(
              '[remote] Continuing without tunnel. Webhooks will only work on localhost.',
            );
          }
        }

        // Start ingestors after tunnel (if any) is ready
        ingestorManager.startAll().catch((err: unknown) => {
          console.error('[remote] Failed to start ingestors:', err);
        });
      })(),
  );

  // Graceful shutdown: release held waits, stop tunnel, then ingestors, then
  // close the server.
  const shutdown = () => {
    console.log('[remote] Shutting down gracefully...');

    void gracefulShutdown(server, ingestorManager, stopTunnel).then(() => {
      console.log('[remote] Server closed.');
      process.exit(0);
    });

    armForcedExit();
  };

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[remote] Error: Port ${port} is already in use.`);
    } else if (err.code === 'EACCES') {
      console.error(`[remote] Error: Permission denied for ${host}:${port}. Try a port >= 1024.`);
    } else {
      console.error(`[remote] Server error:`, err);
    }
    process.exit(1);
  });

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// Only run when executed directly (not when imported as a library).
// Check if the entry script is this file (covers both ts-node and compiled js).
const entryScript = process.argv[1] ?? '';
const isDirectRun =
  entryScript.endsWith('remote/server.ts') || entryScript.endsWith('remote/server.js');

if (isDirectRun) {
  try {
    main();
  } catch (err: unknown) {
    console.error('[remote] Fatal error:', err);
    process.exit(1);
  }
}
