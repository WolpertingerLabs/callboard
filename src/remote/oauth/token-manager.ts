/**
 * Generic in-memory OAuth2 token manager (the daemon's token boundary).
 *
 * Owns access-token acquisition, caching, single-flight refresh, and
 * refresh-token rotation for any route carrying an {@link OAuth2Config}
 * declaration. Nothing here is provider-specific: behaviour is driven by the
 * declarative config.
 *
 * Ported from PR #26 (Card 2). Hardened for drawlatch's withheld-secret model:
 *
 *   - **Cache identity.** A token is cached under the full identity it was
 *     minted for (caller, connection, grant, token URL, client auth, a
 *     fingerprint of the credentials, the requested scopes), never just
 *     (connection, caller). Rotating a refresh token or changing scopes changes
 *     the key, so a stale token is never served.
 *   - **Rotation** is stored per credential fingerprint, so a rotated refresh
 *     token never outlives the configured one it replaced.
 *   - **Scopes** are sent on every grant. The granted `scope` must be a subset
 *     of what was requested, and must be present when `verifyGrantedScopes`
 *     (default: on whenever scopes are set). Anything else is refused and not
 *     cached: fail closed.
 *   - **Transport.** The token endpoint is called through safeFetch with no
 *     redirects, a fixed timeout (OAUTH2_TOKEN_TIMEOUT_MS) and a response-body
 *     cap (OAUTH2_TOKEN_RESPONSE_MAX_BYTES).
 *   - **Errors** carry only the connection alias, HTTP status, a recognised
 *     OAuth2 error code, and a fixed hint. Terminal failures are remembered
 *     for OAUTH2_TERMINAL_BACKOFF_MS per identity.
 *
 * Secret-boundary invariants (HARD, non-negotiable):
 *   - Access tokens, client secrets, and refresh tokens are NEVER logged.
 *   - They NEVER appear in thrown error messages.
 *   - They are NEVER serialized into any return value beyond the access token
 *     the caller explicitly asks for.
 *   - State is memory-only; nothing is persisted to disk. A rotated refresh
 *     token lives only for the lifetime of this process.
 */

import crypto from 'node:crypto';

import {
  DEFAULT_OAUTH2_REFRESH_SKEW_MS,
  OAUTH2_TERMINAL_BACKOFF_MS,
  OAUTH2_TOKEN_RESPONSE_MAX_BYTES,
  OAUTH2_TOKEN_TIMEOUT_MS,
  type OAuth2Config,
} from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { safeFetch } from '../safe-fetch.js';

const log = createLogger('oauth');

/** Alias of DEFAULT_OAUTH2_REFRESH_SKEW_MS (PR #26's name). */
export const DEFAULT_REFRESH_SKEW_MS = DEFAULT_OAUTH2_REFRESH_SKEW_MS;

// ── Injected collaborators ──────────────────────────────────────────────────

/**
 * Resolve a secret *name* to its value, or `undefined` if unset. The request
 * path passes `(name) => route.secrets[name]`; the TokenManager never touches
 * process.env or the config loader itself.
 */
export type SecretResolver = (secretName: string) => string | undefined;

/** Injected `fetch` (defaults to the global). Lets tests stub deterministically. */
export type FetchFn = typeof fetch;

/** Injected clock returning epoch milliseconds (defaults to `Date.now`). */
export type ClockFn = () => number;

export interface TokenManagerOptions {
  /** HTTP client. Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchFn;
  /** Epoch-ms clock. Defaults to `Date.now`. */
  now?: ClockFn;
}

/** Who a token is for. Both fields are required: there is no shared slot. */
export interface TokenKey {
  /** Connection alias (e.g. "spotify"). */
  connection: string;
  /** Caller alias the token is scoped to. */
  caller: string;
}

export interface GetAccessTokenOptions {
  /**
   * Force a refresh even if a cached token is still valid. Used by the request
   * path after a surprise 401. Single-flight-safe: a forced refresh that finds
   * one already in flight joins it.
   */
  forceRefresh?: boolean;
  /**
   * How long this caller is willing to wait (ms). Capped at
   * OAUTH2_TOKEN_TIMEOUT_MS. Only this caller stops waiting when it runs out:
   * the shared token-endpoint request keeps running for anyone else joined
   * to it, under its own OAUTH2_TOKEN_TIMEOUT_MS ceiling.
   */
  timeoutMs?: number;
}

/** A minted token plus what the provider says it covers. */
export interface OAuth2Token {
  accessToken: string;
  /** Absolute epoch-ms at which the token hard-expires. */
  expiresAt: number;
  /** Scopes the token endpoint reported granting, sorted. Absent when it
   *  reported none (and verification was off). */
  grantedScopes?: string[];
  /** Requested scopes the provider did not grant (fewer is allowed). */
  missingScopes?: string[];
}

// ── Errors ────────────────────────────────────────────────────────────────

/**
 * OAuth2 error codes recognised in a token-endpoint error body. Only these are
 * ever reported: an unrecognised `error` value is provider-controlled text and
 * is not echoed. Each maps to a fixed hint. All are terminal: retrying the
 * same request with the same credentials will fail the same way.
 */
const TERMINAL_ERROR_HINTS: Record<string, string> = {
  invalid_grant: 'the refresh token or grant is expired, revoked, or invalid; re-authorize',
  invalid_scope: 'the requested scopes exceed what this credential was granted',
  invalid_client: 'the client ID or client secret is wrong, or client authentication failed',
  unauthorized_client: 'this client is not authorized to use this grant type',
  access_denied: 'the authorization server denied the request',
  admin_policy_enforced: 'an administrator policy blocks this client or scope',
  invalid_rapt: 'the account requires re-authentication (reauth proof token); re-authorize',
};

/** Base class for every token failure. Carries no secret material. */
export class OAuth2Error extends Error {
  /** Whether retrying with the same credentials can succeed. */
  readonly terminal: boolean;
  /** HTTP status from the token endpoint, when there was one. */
  readonly status?: number;
  /** A recognised OAuth2 error code (see TERMINAL_ERROR_HINTS), when present. */
  readonly oauth2Error?: string;
  constructor(
    message: string,
    opts: { terminal: boolean; status?: number; oauth2Error?: string } = { terminal: false },
  ) {
    super(message);
    this.name = 'OAuth2Error';
    this.terminal = opts.terminal;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.oauth2Error !== undefined) this.oauth2Error = opts.oauth2Error;
  }
}

/**
 * Terminal failure: the token endpoint rejected the grant with a recognised
 * error code (`invalid_grant`, `invalid_client`, …), or granted scopes this
 * connection may not hold. Do not retry; an admin has to act. Remembered for
 * OAUTH2_TERMINAL_BACKOFF_MS so callers don't hammer the endpoint.
 */
export class OAuth2TerminalError extends OAuth2Error {
  constructor(message: string, opts: { status?: number; oauth2Error?: string } = {}) {
    super(message, { ...opts, terminal: true });
    this.name = 'OAuth2TerminalError';
  }
}

/** Terminal `invalid_grant`. Kept as its own class for PR #26's callers. */
export class OAuth2InvalidGrantError extends OAuth2TerminalError {
  constructor(connection: string, status = 400) {
    super(
      `OAuth2 token request failed for connection "${connection}": invalid_grant ` +
        `(${TERMINAL_ERROR_HINTS.invalid_grant})`,
      { status, oauth2Error: 'invalid_grant' },
    );
    this.name = 'OAuth2InvalidGrantError';
  }
}

/** The token endpoint granted scopes outside the requested set, or none at all. */
export class OAuth2ScopeError extends OAuth2TerminalError {
  constructor(message: string) {
    super(message);
    this.name = 'OAuth2ScopeError';
  }
}

/**
 * Transient failure: a non-2xx without a recognised error code, a network
 * error, a timeout, a malformed response, or a missing secret. No internal
 * retry loop.
 */
export class OAuth2RefreshError extends OAuth2Error {
  constructor(connection: string, status?: number, reason?: string) {
    super(
      `OAuth2 token request failed for connection "${connection}"` +
        (status !== undefined ? ` (HTTP ${status})` : '') +
        (reason ? `: ${reason}` : status === undefined ? ' (network error)' : ''),
      { terminal: false, ...(status !== undefined && { status }) },
    );
    this.name = 'OAuth2RefreshError';
  }
}

// ── Internal state ──────────────────────────────────────────────────────────

interface CacheEntry {
  token: OAuth2Token;
}

interface TerminalEntry {
  until: number;
  error: OAuth2TerminalError;
}

/** Everything a token request needs, with secrets already looked up. */
interface PreparedRequest {
  cacheKey: string;
  /** Fingerprint of the configured credentials; keys rotation state. */
  credential: string;
  clientId: string;
  clientSecret: string;
  /** The refresh token as configured (before any rotation). */
  configuredRefreshToken?: string;
  requestedScopes: string[];
  verifyScopes: boolean;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Sorted, de-duplicated scope list. */
export function normalizeScopes(scopes: readonly string[] | undefined): string[] {
  return [...new Set(scopes ?? [])].sort();
}

// ── TokenManager ────────────────────────────────────────────────────────────

export class TokenManager {
  private readonly fetchImpl: FetchFn;
  private readonly now: ClockFn;

  /** Cached tokens keyed by full identity (see prepare()). */
  private readonly cache = new Map<string, CacheEntry>();
  /** In-flight refresh promises keyed identically — the single-flight latch. */
  private readonly inFlight = new Map<string, Promise<OAuth2Token>>();
  /** Rotated refresh tokens keyed by credential fingerprint. */
  private readonly rotated = new Map<string, string>();
  /** Recent terminal failures keyed by full identity. */
  private readonly terminal = new Map<string, TerminalEntry>();

  constructor(options: TokenManagerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.now = options.now ?? (() => Date.now());
  }

  /** {@link getToken}, returning only the access token string. */
  async getAccessToken(
    key: TokenKey,
    oauth2: OAuth2Config,
    resolveSecret: SecretResolver,
    options: GetAccessTokenOptions = {},
  ): Promise<string> {
    return (await this.getToken(key, oauth2, resolveSecret, options)).accessToken;
  }

  /**
   * Return a valid token for this identity, minting one if needed.
   *
   * Valid means `now + refreshSkewMs < expiresAt`. On a miss (cold, expired,
   * or `forceRefresh`) one token-endpoint request is made; concurrent callers
   * for the same identity share it.
   *
   * @throws OAuth2TerminalError (incl. OAuth2InvalidGrantError,
   *   OAuth2ScopeError) — do not retry.
   * @throws OAuth2RefreshError on transient failures.
   */
  async getToken(
    key: TokenKey,
    oauth2: OAuth2Config,
    resolveSecret: SecretResolver,
    options: GetAccessTokenOptions = {},
  ): Promise<OAuth2Token> {
    if (!key.connection || !key.caller) {
      // Two unidentified callers must never share a slot.
      throw new OAuth2RefreshError(key.connection || '(unnamed)', undefined, 'no caller identity');
    }
    const prepared = this.prepare(key, oauth2, resolveSecret);
    const { cacheKey } = prepared;
    this.sweep();

    const blocked = this.terminal.get(cacheKey);
    if (blocked) throw blocked.error;

    if (!options.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached && this.isValid(cached, oauth2)) return cached.token;
    }

    let flight = this.inFlight.get(cacheKey);
    if (!flight) {
      flight = this.refreshAndCache(key, oauth2, prepared)
        .catch((err: unknown) => {
          // Anything that isn't one of ours is unexpected; its message could
          // carry the request, so it is replaced, never passed through.
          if (err instanceof OAuth2Error) throw err;
          throw new OAuth2RefreshError(key.connection, undefined, 'unexpected error');
        })
        .finally(() => {
          this.inFlight.delete(cacheKey);
        });
      // Every waiter may give up on its own deadline; keep an abandoned
      // flight's rejection from surfacing as unhandled.
      flight.catch(() => undefined);
      this.inFlight.set(cacheKey, flight);
    }

    const wait = Math.min(options.timeoutMs ?? OAUTH2_TOKEN_TIMEOUT_MS, OAUTH2_TOKEN_TIMEOUT_MS);
    return this.raceDeadline(flight, wait, key.connection);
  }

  /** Drop every cached token for (connection, caller). In-flight requests are untouched. */
  invalidate(key: TokenKey): void {
    const prefix = TokenManager.ownerPrefix(key);
    for (const k of this.cache.keys()) if (k.startsWith(prefix)) this.cache.delete(k);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private isValid(entry: CacheEntry, oauth2: OAuth2Config): boolean {
    const skew = oauth2.refreshSkewMs ?? DEFAULT_OAUTH2_REFRESH_SKEW_MS;
    return this.now() + skew < entry.token.expiresAt;
  }

  /** Drop expired tokens and lapsed terminal backoffs. */
  private sweep(): void {
    const now = this.now();
    for (const [k, v] of this.cache) if (v.token.expiresAt <= now) this.cache.delete(k);
    for (const [k, v] of this.terminal) if (v.until <= now) this.terminal.delete(k);
  }

  /** Owner prefix of every cache key, so invalidate() can find them. */
  private static ownerPrefix(key: TokenKey): string {
    return `${sha256(JSON.stringify([key.caller, key.connection]))}:`;
  }

  /** Look up secrets and compute the cache identity. */
  private prepare(
    key: TokenKey,
    oauth2: OAuth2Config,
    resolveSecret: SecretResolver,
  ): PreparedRequest {
    const clientId = this.requireSecret(resolveSecret, oauth2.secretRefs.clientId, key.connection);
    const clientSecret = this.requireSecret(
      resolveSecret,
      oauth2.secretRefs.clientSecret,
      key.connection,
    );
    let configuredRefreshToken: string | undefined;
    if (oauth2.grant === 'refresh_token') {
      configuredRefreshToken = this.requireSecret(
        resolveSecret,
        oauth2.secretRefs.refreshToken,
        key.connection,
      );
    }
    const credential = sha256(
      oauth2.grant === 'refresh_token'
        ? `refresh_token\0${clientId}\0${configuredRefreshToken}\0${clientSecret}`
        : `client_credentials\0${clientId}\0${clientSecret}`,
    );
    const requestedScopes = normalizeScopes(oauth2.scopes);
    const identity = JSON.stringify([
      oauth2.grant,
      oauth2.tokenUrl,
      oauth2.clientAuth,
      credential,
      requestedScopes.join(' '),
    ]);
    return {
      cacheKey: TokenManager.ownerPrefix(key) + sha256(identity),
      credential,
      clientId,
      clientSecret,
      ...(configuredRefreshToken !== undefined && { configuredRefreshToken }),
      requestedScopes,
      verifyScopes: oauth2.verifyGrantedScopes ?? requestedScopes.length > 0,
    };
  }

  /** Resolve with `flight`, or reject once this caller's own wait runs out. */
  private raceDeadline<T>(flight: Promise<T>, waitMs: number, connection: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new OAuth2RefreshError(
            connection,
            undefined,
            `the token endpoint did not answer within ${waitMs}ms`,
          ),
        );
      }, waitMs);
      flight.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e: unknown) => {
          clearTimeout(timer);
          reject(e as Error);
        },
      );
    });
  }

  private async refreshAndCache(
    key: TokenKey,
    oauth2: OAuth2Config,
    p: PreparedRequest,
  ): Promise<OAuth2Token> {
    const body = new URLSearchParams();
    body.set('grant_type', oauth2.grant);
    if (oauth2.grant === 'refresh_token') {
      // Prefer the in-memory rotated token for these exact credentials.
      body.set('refresh_token', this.rotated.get(p.credential) ?? p.configuredRefreshToken!);
    }
    if (p.requestedScopes.length > 0) body.set('scope', p.requestedScopes.join(' '));

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };
    if (oauth2.clientAuth === 'basic') {
      // Raw `id:secret`, as most clients send it. (RFC 6749 §2.3.1 asks for
      // form-encoding each part first, which many providers don't decode.)
      const basic = Buffer.from(`${p.clientId}:${p.clientSecret}`).toString('base64');
      headers.Authorization = `Basic ${basic}`;
    } else {
      body.set('client_id', p.clientId);
      body.set('client_secret', p.clientSecret);
    }

    log.debug(`Requesting access token for ${key.connection} (caller ${key.caller})`);

    let resp: Response;
    try {
      ({ response: resp } = await safeFetch(oauth2.tokenUrl, {
        method: 'POST',
        headers,
        body: body.toString(),
        signal: AbortSignal.timeout(OAUTH2_TOKEN_TIMEOUT_MS),
        // A token endpoint that redirects is not followed: the request carries
        // client credentials, and the token URL is fixed admin config.
        isAllowed: () => false,
        maxRedirects: 0,
        fetchImpl: this.fetchImpl,
      }));
    } catch (err) {
      // Never surface the underlying error: it may carry the request.
      const timedOut =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new OAuth2RefreshError(
        key.connection,
        undefined,
        timedOut ? `the token endpoint did not answer within ${OAUTH2_TOKEN_TIMEOUT_MS}ms` : '',
      );
    }

    const text = await this.readCapped(resp, key.connection);

    if (!resp.ok) {
      const error = this.classifyErrorResponse(resp.status, text, key.connection);
      if (error.terminal) {
        this.terminal.set(p.cacheKey, {
          until: this.now() + OAUTH2_TERMINAL_BACKOFF_MS,
          error: error as OAuth2TerminalError,
        });
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new OAuth2RefreshError(key.connection, resp.status, 'response is not JSON');
    }

    let token: OAuth2Token;
    try {
      token = this.buildToken(parsed, p, key.connection, resp.status);
    } catch (err) {
      if (err instanceof OAuth2TerminalError) {
        this.terminal.set(p.cacheKey, {
          until: this.now() + OAUTH2_TERMINAL_BACKOFF_MS,
          error: err,
        });
      }
      throw err;
    }

    // Rotation: keep a returned refresh token for these credentials only.
    if (oauth2.grant === 'refresh_token') {
      const returned = (parsed as Record<string, unknown>).refresh_token;
      if (typeof returned === 'string' && returned.length > 0) {
        this.rotated.set(p.credential, returned);
      }
    }

    this.cache.set(p.cacheKey, { token });
    return token;
  }

  /** Read at most OAUTH2_TOKEN_RESPONSE_MAX_BYTES of the body as text. */
  private async readCapped(resp: Response, connection: string): Promise<string> {
    const max = OAUTH2_TOKEN_RESPONSE_MAX_BYTES;
    const declared = Number(resp.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) {
      await resp.body?.cancel().catch(() => undefined);
      throw new OAuth2RefreshError(connection, resp.status, `response exceeds ${max} bytes`);
    }
    if (!resp.body) return '';
    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => undefined);
          throw new OAuth2RefreshError(connection, resp.status, `response exceeds ${max} bytes`);
        }
        chunks.push(value);
      }
    } catch (err) {
      if (err instanceof OAuth2Error) throw err;
      throw new OAuth2RefreshError(connection, resp.status, 'response body could not be read');
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * Map a non-2xx token response to an error. Reads the body only for a
   * recognised `error` code (or Google's `error_subtype: invalid_rapt`); the
   * body itself is never included — it can echo submitted credentials.
   */
  private classifyErrorResponse(status: number, text: string, connection: string): OAuth2Error {
    let code: string | undefined;
    try {
      const data = JSON.parse(text) as { error?: unknown; error_subtype?: unknown };
      if (data.error_subtype === 'invalid_rapt') code = 'invalid_rapt';
      else if (typeof data.error === 'string' && data.error in TERMINAL_ERROR_HINTS) {
        code = data.error;
      }
    } catch {
      code = undefined;
    }
    if (code === 'invalid_grant') return new OAuth2InvalidGrantError(connection, status);
    if (code) {
      return new OAuth2TerminalError(
        `OAuth2 token request failed for connection "${connection}" (HTTP ${status}): ${code} ` +
          `(${TERMINAL_ERROR_HINTS[code]})`,
        { status, oauth2Error: code },
      );
    }
    return new OAuth2RefreshError(connection, status);
  }

  /** Validate a successful token response, including the granted scopes. */
  private buildToken(
    parsed: unknown,
    p: PreparedRequest,
    connection: string,
    status: number,
  ): OAuth2Token {
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new OAuth2RefreshError(connection, status, 'response is not a JSON object');
    }
    const data = parsed as Record<string, unknown>;

    const accessToken = data.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new OAuth2RefreshError(connection, status, 'response has no access_token');
    }
    // The token goes into a header; a CR/LF/NUL would be rejected by fetch()
    // with the value echoed in the error.
    if (/[\r\n\0]/.test(accessToken)) {
      throw new OAuth2RefreshError(connection, status, 'access_token is not a valid header value');
    }
    const tokenType = data.token_type;
    if (
      tokenType !== undefined &&
      (typeof tokenType !== 'string' || !/^bearer$/i.test(tokenType))
    ) {
      throw new OAuth2RefreshError(connection, status, 'token_type is not Bearer');
    }
    const expiresIn =
      typeof data.expires_in === 'string' ? Number(data.expires_in) : data.expires_in;
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new OAuth2RefreshError(connection, status, 'response has no usable expires_in');
    }

    // Scope check. RFC 6749 §5.1 lets a server omit `scope` when it equals
    // the request, but that is exactly the case we cannot tell apart from
    // "ignored the scope parameter and returned the full grant", so with
    // verification on, a missing scope is refused.
    let granted: string[] | undefined;
    if (typeof data.scope === 'string') {
      granted = normalizeScopes(data.scope.split(/\s+/).filter(Boolean));
    } else if (Array.isArray(data.scope) && data.scope.every((s) => typeof s === 'string')) {
      granted = normalizeScopes(data.scope);
    }

    let missingScopes: string[] | undefined;
    if (p.verifyScopes && !granted) {
      throw new OAuth2ScopeError(
        `OAuth2 token for connection "${connection}" refused: the token endpoint did not ` +
          'report which scopes it granted, so they cannot be verified',
      );
    }
    // A granted scope outside the request is refused whether or not
    // verification is on: verifyGrantedScopes only tolerates a missing field.
    if (granted && p.requestedScopes.length > 0) {
      const requested = new Set(p.requestedScopes);
      const extra = granted.filter((s) => !requested.has(s));
      if (extra.length > 0) {
        throw new OAuth2ScopeError(
          `OAuth2 token for connection "${connection}" refused: the token endpoint granted ` +
            `scopes broader than this connection allows (${extra.join(', ')}). Mint a ` +
            "dedicated refresh token with exactly the connection's scopes.",
        );
      }
      const grantedSet = new Set(granted);
      const missing = p.requestedScopes.filter((s) => !grantedSet.has(s));
      if (missing.length > 0) missingScopes = missing;
    }

    return {
      accessToken,
      expiresAt: this.now() + expiresIn * 1000,
      ...(granted && { grantedScopes: granted }),
      ...(missingScopes && { missingScopes }),
    };
  }

  /** Resolve a required secret by name; a transient (misconfiguration) error if missing. */
  private requireSecret(
    resolveSecret: SecretResolver,
    name: string | undefined,
    connection: string,
  ): string {
    const value = name ? resolveSecret(name) : undefined;
    if (value === undefined || value === '') {
      // The secret *name* is config, not a value, so it is safe to report.
      throw new OAuth2RefreshError(
        connection,
        undefined,
        `secret ${name ?? '(unnamed)'} is not set for this caller`,
      );
    }
    return value;
  }
}
