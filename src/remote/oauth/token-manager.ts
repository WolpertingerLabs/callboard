/**
 * Generic in-memory OAuth2 token manager (the daemon's token boundary).
 *
 * Owns access-token acquisition, caching, single-flight refresh, and
 * refresh-token rotation for any route carrying an {@link OAuth2Config}
 * declaration. Spotify is the first consumer, but nothing here is
 * Spotify-specific — the behaviour is driven entirely by the declarative
 * config + Card 0 findings (see plans/spotify-oauth2-refresh.md).
 *
 * Secret-boundary invariants (HARD, non-negotiable):
 *   - Access tokens, client secrets, and refresh tokens are NEVER logged.
 *   - They NEVER appear in thrown error messages.
 *   - They are NEVER serialized into any return value beyond the bare
 *     access-token string the caller explicitly asks for.
 *   - State is memory-only; nothing is persisted to disk. A rotated refresh
 *     token lives only for the lifetime of this process and is re-derived
 *     from the configured refresh-token secret on restart.
 *
 * Card 3 (request-path wiring) consumes this module; this card is a
 * self-contained, fully unit-tested unit and deliberately does NOT reach
 * into env/process, the config loader, or the request path.
 */

import type { OAuth2Config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';

const log = createLogger('oauth');

// ── Constants ─────────────────────────────────────────────────────────────

/**
 * Default skew (ms) before a token's hard expiry at which it is treated as
 * stale and refreshed proactively, when {@link OAuth2Config.refreshSkewMs} is
 * absent. Spotify (and most providers) issue 3600s tokens; a 5-minute skew
 * refreshes well ahead of expiry without churning, per Card 0 (~3300s / skew
 * ≥ 300s). The plan's "~60_000" is a floor, not a target — we pick the
 * larger, safer default and document it here.
 */
export const DEFAULT_REFRESH_SKEW_MS = 300_000;

// ── Injected collaborators ──────────────────────────────────────────────────

/**
 * Resolve a secret *name* to its value, or `undefined` if unset.
 *
 * Mirrors how the request path already resolves caller-scoped secrets: a
 * {@link ResolvedRoute} carries a `secrets: Record<string, string>` map keyed
 * by secret name, so Card 3 can pass `(name) => route.secrets[name]`. The
 * TokenManager never touches process.env or the config loader itself — the
 * caller owns secret resolution and the caller scoping that comes with it.
 */
export type SecretResolver = (secretName: string) => string | undefined;

/** Injected `fetch` (defaults to the global). Lets tests stub deterministically. */
export type FetchFn = typeof fetch;

/** Injected clock returning epoch milliseconds (defaults to `Date.now`). */
export type ClockFn = () => number;

export interface TokenManagerOptions {
  /** HTTP client. Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchFn;
  /** Monotonic-ish epoch-ms clock. Defaults to `Date.now`. */
  now?: ClockFn;
}

/** Identifies a distinct token cache slot: (connection alias, caller). */
export interface TokenKey {
  /** Connection alias (e.g., "spotify", "spotify-catalog"). */
  connection: string;
  /** Caller alias the token is scoped to. */
  caller: string;
}

export interface GetAccessTokenOptions {
  /**
   * Force a refresh even if a cached token is still valid. Used by the request
   * path after a surprise 401. Single-flight-safe: concurrent forced refreshes
   * for the same key still coalesce into one token-endpoint call.
   */
  forceRefresh?: boolean;
}

// ── Errors ────────────────────────────────────────────────────────────────

/**
 * Terminal refresh failure: the refresh/credentials grant is dead (revoked,
 * expired, or invalid — `400 {error:"invalid_grant"}`). The caller must NOT
 * retry; the connection needs human re-auth. Carries no secret material.
 */
export class OAuth2InvalidGrantError extends Error {
  /** Discriminator for callers that prefer a flag over `instanceof`. */
  readonly terminal = true as const;
  readonly oauth2Error = 'invalid_grant' as const;
  constructor(connection: string) {
    super(`OAuth2 refresh failed for connection "${connection}": invalid_grant (needs re-auth)`);
    this.name = 'OAuth2InvalidGrantError';
  }
}

/**
 * Transient refresh failure (non-2xx that isn't `invalid_grant`, or a network
 * error). The caller may decide to retry; there is no internal retry loop in
 * Card 2. Carries only the HTTP status (when known), never the response body —
 * token-endpoint error bodies can echo back submitted credentials.
 */
export class OAuth2RefreshError extends Error {
  readonly terminal = false as const;
  /** HTTP status code, or `undefined` for a network-level failure. */
  readonly status?: number;
  constructor(connection: string, status?: number) {
    super(
      `OAuth2 refresh failed for connection "${connection}"` +
        (status !== undefined ? ` (HTTP ${status})` : ' (network error)'),
    );
    this.name = 'OAuth2RefreshError';
    this.status = status;
  }
}

// ── Internal cache entry ────────────────────────────────────────────────────

interface CacheEntry {
  /** The current access token (memory-only). */
  accessToken: string;
  /** Absolute epoch-ms at which the access token hard-expires. */
  expiresAt: number;
  /**
   * The rotated refresh token, if the provider has ever returned one for this
   * key. `undefined` means "fall back to the configured refresh-token secret".
   * Memory-only — never persisted.
   */
  rotatedRefreshToken?: string;
}

// ── TokenManager ────────────────────────────────────────────────────────────

export class TokenManager {
  private readonly fetchImpl: FetchFn;
  private readonly now: ClockFn;

  /** Cached tokens keyed by serialized (connection, caller). */
  private readonly cache = new Map<string, CacheEntry>();
  /** In-flight refresh promises keyed identically — the single-flight latch. */
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(options: TokenManagerOptions = {}) {
    // Bind so a stubbed global.fetch resolved at construction time is honoured,
    // but default lazily to whatever `fetch` is at call time when not injected.
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Return a valid access token for (connection, caller), refreshing if needed.
   *
   * Valid means `now + refreshSkewMs < expiresAt`. On a miss (cold, expired, or
   * `forceRefresh`) a single token-endpoint refresh is performed; concurrent
   * callers for the same key share that one in-flight request.
   *
   * @throws OAuth2InvalidGrantError on a terminal `invalid_grant` (do not retry).
   * @throws OAuth2RefreshError on transient HTTP/network failures.
   */
  async getAccessToken(
    key: TokenKey,
    oauth2: OAuth2Config,
    resolveSecret: SecretResolver,
    options: GetAccessTokenOptions = {},
  ): Promise<string> {
    const cacheKey = TokenManager.cacheKey(key);

    if (!options.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && this.isValid(cached, oauth2)) {
        return cached.accessToken;
      }
    }

    // Single-flight: if a refresh is already running for this key, await it.
    // A forceRefresh that arrives while a refresh is in flight intentionally
    // joins that one rather than stampeding a second request.
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const flight = this.refreshAndCache(key, cacheKey, oauth2, resolveSecret).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, flight);
    return flight;
  }

  /**
   * Drop the cached token for a key so the next {@link getAccessToken} refreshes.
   * Does not touch any in-flight refresh. Provided as an alternative force-path;
   * `getAccessToken(..., { forceRefresh: true })` is the primary 401-recovery API.
   */
  invalidate(key: TokenKey): void {
    this.cache.delete(TokenManager.cacheKey(key));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private isValid(entry: CacheEntry, oauth2: OAuth2Config): boolean {
    const skew = oauth2.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    return this.now() + skew < entry.expiresAt;
  }

  private async refreshAndCache(
    key: TokenKey,
    cacheKey: string,
    oauth2: OAuth2Config,
    resolveSecret: SecretResolver,
  ): Promise<string> {
    const clientId = this.requireSecret(resolveSecret, oauth2.secretRefs.clientId, key.connection);
    const clientSecret = this.requireSecret(
      resolveSecret,
      oauth2.secretRefs.clientSecret,
      key.connection,
    );

    const body = new URLSearchParams();
    body.set('grant_type', oauth2.grant);

    if (oauth2.grant === 'refresh_token') {
      // Prefer the in-memory rotated token; fall back to the configured secret.
      const prior = this.cache.get(cacheKey)?.rotatedRefreshToken;
      const refreshToken =
        prior ?? this.requireRefreshTokenSecret(oauth2, resolveSecret, key.connection);
      body.set('refresh_token', refreshToken);
    } else {
      // client_credentials — optionally request scopes (space-joined).
      if (oauth2.scopes && oauth2.scopes.length > 0) {
        body.set('scope', oauth2.scopes.join(' '));
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    if (oauth2.clientAuth === 'basic') {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    } else {
      body.set('client_id', clientId);
      body.set('client_secret', clientSecret);
    }

    log.debug(`Refreshing access token for ${key.connection} (caller ${key.caller})`);

    let resp: Response;
    try {
      resp = await this.fetchImpl(oauth2.tokenUrl, {
        method: 'POST',
        headers,
        body: body.toString(),
      });
    } catch {
      // Network-level failure — never surface the underlying error (it may
      // carry the request, which contains credentials). Status unknown.
      throw new OAuth2RefreshError(key.connection);
    }

    if (!resp.ok) {
      await this.handleErrorResponse(resp, key.connection);
    }

    let parsed: unknown;
    try {
      parsed = await resp.json();
    } catch {
      throw new OAuth2RefreshError(key.connection, resp.status);
    }

    const entry = this.buildEntry(parsed, oauth2, cacheKey, key.connection);
    this.cache.set(cacheKey, entry);
    return entry.accessToken;
  }

  /**
   * Inspect a non-2xx token-endpoint response and throw the right error type.
   * Reads the body only to detect `invalid_grant`; never includes the body in
   * the thrown message (it can echo back submitted credentials).
   */
  private async handleErrorResponse(resp: Response, connection: string): Promise<never> {
    if (resp.status === 400) {
      let errorCode: unknown;
      try {
        const data = (await resp.json()) as { error?: unknown };
        errorCode = data.error;
      } catch {
        errorCode = undefined;
      }
      if (errorCode === 'invalid_grant') {
        throw new OAuth2InvalidGrantError(connection);
      }
    }
    throw new OAuth2RefreshError(connection, resp.status);
  }

  /** Parse a successful token response into a cache entry, applying mappings + rotation. */
  private buildEntry(
    parsed: unknown,
    oauth2: OAuth2Config,
    cacheKey: string,
    connection: string,
  ): CacheEntry {
    if (parsed === null || typeof parsed !== 'object') {
      throw new OAuth2RefreshError(connection);
    }
    const data = parsed as Record<string, unknown>;

    const accessField = oauth2.responseMapping?.accessTokenField ?? 'access_token';
    const expiresField = oauth2.responseMapping?.expiresInField ?? 'expires_in';
    const refreshField = oauth2.responseMapping?.refreshTokenField ?? 'refresh_token';

    const accessToken = data[accessField];
    const expiresIn = data[expiresField];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new OAuth2RefreshError(connection);
    }
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
      throw new OAuth2RefreshError(connection);
    }

    const expiresAt = this.now() + expiresIn * 1000;

    // Refresh-token rotation: persist a returned refresh token; if absent,
    // keep whatever we had (rotated value or the configured secret fallback).
    const prior = this.cache.get(cacheKey)?.rotatedRefreshToken;
    const returnedRefresh = data[refreshField];
    const rotatedRefreshToken =
      typeof returnedRefresh === 'string' && returnedRefresh.length > 0 ? returnedRefresh : prior;

    return {
      accessToken,
      expiresAt,
      ...(rotatedRefreshToken !== undefined && { rotatedRefreshToken }),
    };
  }

  /** Resolve a required secret by name; throw a transient error if it's missing. */
  private requireSecret(resolveSecret: SecretResolver, name: string, connection: string): string {
    const value = resolveSecret(name);
    if (value === undefined || value === '') {
      // Surface as transient (misconfiguration), not as a dead-grant terminal.
      // The secret *name* is config, not a secret value — safe to omit anyway.
      throw new OAuth2RefreshError(connection);
    }
    return value;
  }

  private requireRefreshTokenSecret(
    oauth2: OAuth2Config,
    resolveSecret: SecretResolver,
    connection: string,
  ): string {
    const name = oauth2.secretRefs.refreshToken;
    if (!name) {
      throw new OAuth2RefreshError(connection);
    }
    const value = resolveSecret(name);
    if (value === undefined || value === '') {
      throw new OAuth2RefreshError(connection);
    }
    return value;
  }

  private static cacheKey(key: TokenKey): string {
    // JSON.stringify of the two fixed string fields — unambiguous and
    // collision-free for our (connection, caller) tuple.
    return JSON.stringify([key.connection, key.caller]);
  }
}
