/**
 * Polling ingestor — interval-based HTTP poller.
 *
 * Periodically hits an HTTP endpoint using the connection's resolved
 * secrets and headers, extracts individual items from the response,
 * deduplicates by a configurable field, and pushes new items into
 * the ring buffer.
 *
 * Unlike WebSocket ingestors (which maintain persistent connections)
 * or webhook ingestors (which are passive receivers), poll ingestors
 * are active requesters on a timer.
 *
 * Designed as a single concrete class — all service-specific behavior
 * (response shape, event type, deduplication field) is parameterized
 * via `PollIngestorConfig` rather than requiring subclasses.
 *
 * @see https://developers.notion.com/reference (Notion — first implementor)
 * @see https://developers.linear.app/docs/graphql/working-with-the-graphql-api (Linear — first implementor)
 */

import { BaseIngestor } from '../base-ingestor.js';
import type { PollIngestorConfig } from '../types.js';
import { registerIngestorFactory } from '../registry.js';
import { OAUTH2_TOKEN_TIMEOUT_MS, scrubSecrets } from '../../../shared/config.js';
import { createLogger } from '../../../shared/logger.js';
import { safeFetch, sameOriginAs } from '../../safe-fetch.js';
import { oauth2Authorize, type OAuth2Route } from '../../oauth/authenticate.js';
import type { TokenManager } from '../../oauth/token-manager.js';

const log = createLogger('poll');

// ── Constants ─────────────────────────────────────────────────────────

/** Maximum number of seen IDs to track for deduplication.
 *  When exceeded, oldest entries are pruned. */
const MAX_SEEN_IDS = 10_000;

/** Minimum allowed poll interval (to prevent accidental API flooding). */
const MIN_INTERVAL_MS = 5_000; // 5 seconds

/** Maximum consecutive errors before transitioning to 'error' state. */
const MAX_CONSECUTIVE_ERRORS = 10;

// ── Poll Ingestor ─────────────────────────────────────────────────────

export class PollIngestor extends BaseIngestor {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly seenIds = new Set<string>();
  private consecutiveErrors = 0;

  private readonly url: string;
  private readonly intervalMs: number;
  private readonly method: string;
  private readonly body: unknown;
  private readonly deduplicateBy: string | undefined;
  private readonly responsePath: string | undefined;
  private readonly eventType: string;
  private readonly pollHeaders: Record<string, string>;
  private readonly useEtag: boolean;
  private lastEtag: string | null = null;

  /** Resolved headers from the parent connection route (injected by manager). */
  private readonly routeHeaders: Record<string, string>;

  /** OAuth2 wiring, when the connection mints its own tokens (injected by manager). */
  private readonly oauth2?: OAuth2PollOptions;
  /** The token on the most recent poll. */
  private currentToken?: string;
  /** The last few tokens this poller has sent, for scrubbing error text. */
  private readonly recentTokens: string[] = [];

  constructor(
    connectionAlias: string,
    secrets: Record<string, string>,
    pollConfig: PollIngestorConfig,
    /** Pre-resolved headers from the connection's route. */
    routeHeaders: Record<string, string>,
    bufferSize?: number,
    instanceId?: string,
    /** Omitted for non-oauth2 routes, whose behaviour is unchanged. */
    oauth2?: OAuth2PollOptions,
  ) {
    super(connectionAlias, 'poll', secrets, bufferSize, instanceId);
    this.oauth2 = oauth2;

    // Resolve ${VAR} placeholders in URL
    this.url = PollIngestor.resolvePlaceholders(pollConfig.url, secrets);
    this.intervalMs = Math.max(pollConfig.intervalMs, MIN_INTERVAL_MS);
    this.method = (pollConfig.method ?? 'GET').toUpperCase();
    this.body = pollConfig.body;
    this.deduplicateBy = pollConfig.deduplicateBy;
    this.responsePath = pollConfig.responsePath;
    this.eventType = pollConfig.eventType ?? 'poll';
    this.useEtag = pollConfig.etag ?? false;
    this.routeHeaders = routeHeaders;

    // Resolve ${VAR} placeholders in poll-specific headers
    this.pollHeaders = {};
    if (pollConfig.headers) {
      for (const [k, v] of Object.entries(pollConfig.headers)) {
        this.pollHeaders[k] = PollIngestor.resolvePlaceholders(v, secrets);
      }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.state = 'starting';
    log.info(
      `Starting poll ingestor for ${this.connectionAlias} ` +
        `(${this.method} ${this.url}, every ${this.intervalMs}ms)`,
    );

    // Do an initial poll immediately
    await this.poll();

    // Then set up the recurring interval
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.intervalMs);

    // If the initial poll succeeded, state is already 'connected'.
    // If it failed, state is 'reconnecting' — the timer will retry.
  }

  stop(_permanent?: boolean): Promise<void> {
    this.state = 'stopped';
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    return Promise.resolve();
  }

  // ── Core poll logic ──────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      // Build headers: route headers (from connection template) merged with poll-specific headers
      const headers: Record<string, string> = {
        ...this.routeHeaders,
        ...this.pollHeaders,
      };

      // Add ETag conditional request header if enabled and we have a cached ETag
      if (this.useEtag && this.lastEtag) {
        headers['If-None-Match'] = this.lastEtag;
      }

      // Build request options
      const fetchOptions: { method: string; headers: Record<string, string>; body?: string } = {
        method: this.method,
        headers,
      };

      // Add body for POST/PUT/PATCH
      if (this.body !== undefined && this.method !== 'GET' && this.method !== 'HEAD') {
        if (typeof this.body === 'string') {
          fetchOptions.body = PollIngestor.resolvePlaceholders(this.body, this.secrets);
        } else {
          const serialized = JSON.stringify(this.body);
          fetchOptions.body = PollIngestor.resolvePlaceholders(serialized, this.secrets);
          // Ensure Content-Type is set for JSON bodies
          if (!headers['Content-Type'] && !headers['content-type']) {
            headers['Content-Type'] = 'application/json';
          }
        }
      }

      // OAuth2 routes: put a managed token on the request. The route itself
      // can't set Authorization (validation), but a template's poll headers
      // could; the minted token wins.
      if (this.oauth2) await this.applyToken(headers, false);

      // Route headers carry the connection's credentials, so a redirect is
      // only followed on the poll URL's own origin; any other 3xx is an error.
      const send = () =>
        safeFetch(this.url, { ...fetchOptions, isAllowed: sameOriginAs(this.url) });
      let { response } = await send();

      // A 401 on an oauth2 route: mint a fresh token and poll again, once. A
      // second 401 falls through to the normal error handling below.
      // Skipped when the token manager declines to re-mint (token too new).
      if (this.oauth2 && response.status === 401 && (await this.applyToken(headers, true))) {
        await response.body?.cancel().catch(() => undefined);
        ({ response } = await send());
      }

      // Handle ETag 304 Not Modified — no new data, not an error
      if (this.useEtag && response.status === 304) {
        this.consecutiveErrors = 0;
        if (this.state !== 'connected') this.state = 'connected';
        log.debug(`${this.connectionAlias}: 304 Not Modified (ETag cache hit)`);
        return;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          throw new Error(
            `HTTP ${response.status} redirect not followed` +
              (location ? ` (Location: ${scrubSecrets(location, this.secrets)})` : '') +
              ": polls only follow redirects on the poll URL's own origin",
          );
        }
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      // Store ETag for subsequent conditional requests
      if (this.useEtag) {
        const etag = response.headers.get('etag');
        if (etag) this.lastEtag = etag;
      }

      const responseBody: unknown = await response.json();

      // Extract items array from response using responsePath
      const items = this.extractItems(responseBody);

      if (!Array.isArray(items)) {
        throw new Error(
          `Expected array at responsePath "${this.responsePath ?? '(root)'}", got ${typeof items}`,
        );
      }

      // Process each item
      let newItemCount = 0;
      for (const item of items) {
        if (this.shouldPush(item)) {
          const idempotencyKey = this.extractItemIdempotencyKey(item);
          this.pushEvent(this.eventType, item, idempotencyKey);
          newItemCount++;
        }
      }

      // Success — reset error state
      this.consecutiveErrors = 0;
      if (this.state !== 'connected') {
        this.state = 'connected';
      }

      if (newItemCount > 0) {
        log.info(`${this.connectionAlias}: ${newItemCount} new item(s) from ${items.length} total`);
      }
      log.debug(
        `${this.connectionAlias}: poll complete — ${items.length} items, ${newItemCount} new`,
      );
    } catch (err) {
      this.consecutiveErrors++;
      const raw = err instanceof Error ? err.message : String(err);
      const message = scrubSecrets(raw, { ...this.secrets, ...this.extraScrubValues() });
      this.errorMessage = message;
      // A terminal OAuth2 failure (invalid_grant, refused scopes…) will fail
      // the same way on every poll: stop now rather than spin.
      const terminal = (err as { terminal?: unknown } | null)?.terminal === true;

      if (terminal || this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        this.state = 'error';
        log.error(
          terminal
            ? `${this.connectionAlias}: OAuth2 token failure, giving up: ${message}`
            : `${this.connectionAlias}: ${MAX_CONSECUTIVE_ERRORS} consecutive errors, giving up: ${message}`,
        );
        // Stop the timer on permanent error
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
        }
      } else {
        this.state = 'reconnecting';
        log.warn(
          `${this.connectionAlias}: poll failed (attempt ${this.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${message}`,
        );
      }
    }
  }

  // ── Response parsing ──────────────────────────────────────────────

  /**
   * Extract items from the response using the configured responsePath.
   * E.g., "results" extracts response.results,
   * "data.issues.nodes" extracts response.data.issues.nodes.
   * If no responsePath, returns the response itself (expects a top-level array).
   */
  private extractItems(responseBody: unknown): unknown {
    if (!this.responsePath) return responseBody;

    const parts = this.responsePath.split('.');
    let current: unknown = responseBody;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  // ── Deduplication ──────────────────────────────────────────────────

  /**
   * Resolve a dot-separated path on an object.
   * E.g., "data.name" on { data: { name: "t3_abc" } } → "t3_abc".
   * Single-segment paths (e.g., "id") resolve as a simple property lookup.
   */
  private static resolveNestedPath(obj: unknown, dotPath: string): unknown {
    if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;

    const parts = dotPath.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  /**
   * Check if an item should be pushed into the buffer (dedup check).
   * Returns true if the item is new (not previously seen).
   * Supports dot-separated paths in `deduplicateBy` (e.g., "data.name").
   */
  private shouldPush(item: unknown): boolean {
    if (!this.deduplicateBy) return true;

    const idValue = PollIngestor.resolveNestedPath(item, this.deduplicateBy);
    if (idValue === undefined || idValue === null) return true;

    // Ensure safe stringification: only accept primitives for dedup IDs
    const id =
      typeof idValue === 'string' || typeof idValue === 'number' || typeof idValue === 'boolean'
        ? String(idValue)
        : JSON.stringify(idValue);

    if (this.seenIds.has(id)) return false;

    // Add to seen set, prune if over limit
    this.seenIds.add(id);
    if (this.seenIds.size > MAX_SEEN_IDS) {
      this.pruneSeenIds();
    }

    return true;
  }

  /**
   * Prune the seen IDs set to prevent unbounded memory growth.
   * Removes the oldest half of entries. Since Set preserves insertion order,
   * we can iterate and delete the first N entries.
   */
  private pruneSeenIds(): void {
    const pruneCount = Math.floor(this.seenIds.size / 2);
    let removed = 0;
    for (const id of this.seenIds) {
      if (removed >= pruneCount) break;
      this.seenIds.delete(id);
      removed++;
    }
    log.debug(
      `${this.connectionAlias}: pruned ${removed} seen IDs (${this.seenIds.size} remaining)`,
    );
  }

  // ── Idempotency ─────────────────────────────────────────────────

  /**
   * Extract an idempotency key from a poll item using the `deduplicateBy` field.
   * Supports dot-separated paths (e.g., "data.name").
   * Returns `undefined` if no dedup field is configured or the field is absent.
   */
  private extractItemIdempotencyKey(item: unknown): string | undefined {
    if (!this.deduplicateBy) return undefined;

    const idValue = PollIngestor.resolveNestedPath(item, this.deduplicateBy);
    if (idValue === undefined || idValue === null) return undefined;

    const id =
      typeof idValue === 'string' || typeof idValue === 'number' || typeof idValue === 'boolean'
        ? String(idValue)
        : JSON.stringify(idValue);

    return `poll:${this.connectionAlias}:${id}`;
  }

  // ── OAuth2 ─────────────────────────────────────────────────────────

  /** The minted tokens are withheld like any header secret: scrub them from
   *  events (an upstream may echo the request) and from error text. */
  protected override extraScrubValues(): Record<string, string> {
    return Object.fromEntries(this.recentTokens.map((t, i) => [`OAUTH2_ACCESS_TOKEN_${i}`, t]));
  }

  /** Mint (or reuse) the token and set `Authorization`, replacing any casing. */
  /** Mint (or reuse) the token and set it; returns whether it changed. */
  private async applyToken(
    headers: Record<string, string>,
    forceRefresh: boolean,
  ): Promise<boolean> {
    const opts = this.oauth2!;
    const previous = this.currentToken;
    const auth = await oauth2Authorize(opts.route, opts.caller, {
      timeoutMs: OAUTH2_TOKEN_TIMEOUT_MS,
      forceRefresh,
      ...(forceRefresh && previous !== undefined && { rejectedToken: previous }),
      ...(opts.tokenManager && { tokenManager: opts.tokenManager }),
    });
    this.currentToken = auth.accessToken;
    for (const token of Object.values(auth.scrub)) {
      if (this.recentTokens.includes(token)) continue;
      this.recentTokens.push(token);
      if (this.recentTokens.length > 4) this.recentTokens.shift();
    }
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'authorization') Reflect.deleteProperty(headers, k);
    }
    headers.Authorization = auth.authorization;
    return auth.accessToken !== previous;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Resolve ${VAR} placeholders in a string using a secrets map.
   */
  static resolvePlaceholders(str: string, secrets: Record<string, string>): string {
    return str.replace(/\$\{(\w+)\}/g, (match, name: string) => {
      if (name in secrets) return secrets[name];
      return match;
    });
  }
}

/** What a poller on an oauth2 route needs to mint tokens. */
export interface OAuth2PollOptions {
  /** The resolved route (full secrets: the oauth2 credentials are signer-only
   *  and absent from the listener's own secret map). */
  route: OAuth2Route;
  /** Caller the token is minted for. */
  caller: string;
  /** Defaults to the shared manager. */
  tokenManager?: TokenManager;
}

// ── Self-registration ──────────────────────────────────────────────────

registerIngestorFactory('poll', (connectionAlias, config, secrets, bufferSize, instanceId) => {
  if (!config.poll) {
    log.error(`Missing poll config for ${connectionAlias}`);
    return null;
  }

  // OAuth2 wiring the manager attached (see IngestorManager.attachOAuth2).
  const { _oauth2Route: oauth2Route, _caller: caller } = config as {
    _oauth2Route?: OAuth2Route;
    _caller?: string;
  };
  if (oauth2Route?.oauth2 && !caller) {
    // Never mint without an identity, and never poll an oauth2 route unauthenticated.
    log.error(`Poll ingestor for ${connectionAlias}: oauth2 route without a caller; not started`);
    return null;
  }

  return new PollIngestor(
    connectionAlias,
    secrets,
    config.poll,
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unnecessary-condition -- route headers injected by manager via private property; may be absent
    ((config as any)._resolvedRouteHeaders as Record<string, string>) ?? {},
    bufferSize,
    instanceId,
    oauth2Route?.oauth2 && caller ? { route: oauth2Route, caller } : undefined,
  );
});
