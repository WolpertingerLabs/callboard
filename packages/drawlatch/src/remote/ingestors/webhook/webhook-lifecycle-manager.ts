/**
 * Webhook Lifecycle Manager.
 *
 * Stateless utility that executes declarative lifecycle HTTP requests to
 * list, register, and unregister webhooks with external services.
 *
 * Used by webhook ingestors with a `lifecycle` config block to auto-register
 * webhooks on start, clean up stale registrations (e.g., after tunnel URL changes),
 * and unregister on permanent shutdown or instance deletion.
 *
 * HTTP requests bypass proxy routes, since secrets are already resolved, but
 * each resolved URL must pass the same URL policy as a proxied request
 * (normalizeOutboundUrl: no control characters or dot segments, normalized
 * href in the connection's `allowedEndpoints`), because it carries agent-set
 * listener params (GitHub's `repoFilter`) and upstream-supplied webhook IDs.
 * A refused URL raises LifecycleUrlError and nothing is sent. Requests go
 * through `safeFetch()`, which follows a redirect only on the request URL's
 * own origin, so resolved credentials never reach another host.
 */

import type { WebhookLifecycleConfig, WebhookRegistrationState } from './lifecycle-types.js';
import { resolvePlaceholders, scrubSecrets } from '../../../shared/config.js';
import { createLogger } from '../../../shared/logger.js';
import { safeFetch, sameOriginAs } from '../../safe-fetch.js';
import { normalizeOutboundUrl } from '../../url-policy.js';

const log = createLogger('webhook-lifecycle');

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Recursively resolve `${VAR}` placeholders in an object tree.
 * Walks objects and arrays, resolving placeholders in all string values.
 */
function resolveDeep(value: unknown, secrets: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return resolvePlaceholders(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveDeep(item, secrets));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = resolveDeep(v, secrets);
    }
    return result;
  }
  return value;
}

/**
 * Extract a value from a nested object using a dot-separated path.
 * E.g., `getByPath(obj, 'data.webhooks')` → `obj.data.webhooks`.
 */
function getByPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ── Lifecycle Manager ────────────────────────────────────────────────────

/** A lifecycle URL failed the URL policy; the request was not sent. */
export class LifecycleUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleUrlError';
  }
}

export class WebhookLifecycleManager {
  private readonly config: WebhookLifecycleConfig;
  private readonly secrets: Record<string, string>;
  private readonly allowedEndpoints: string[];

  constructor(
    config: WebhookLifecycleConfig,
    secrets: Record<string, string>,
    /** The connection's allowlist. Empty allows any URL that passes the
     *  other checks (the manager always passes the route's list). */
    allowedEndpoints: string[] = [],
  ) {
    this.config = config;
    this.secrets = secrets;
    this.allowedEndpoints = allowedEndpoints;
  }

  /** The URL to send, or LifecycleUrlError. `template` (unresolved) is what
   *  error messages show, since the resolved URL can carry secrets. */
  private checkedUrl(url: string, template: string): string {
    try {
      return normalizeOutboundUrl(url, this.allowedEndpoints, template);
    } catch (err) {
      throw new LifecycleUrlError(
        `Webhook lifecycle request refused: ${(err as Error).message} (after listener ` +
          'params and webhook IDs were substituted). Nothing was sent.',
      );
    }
  }

  /**
   * Ensure a webhook is registered with the external service (idempotent).
   *
   * Flow:
   * 1. If `list` config exists → fetch existing webhooks, find one matching
   *    callbackUrl (+ modelId if provided) → reuse if found
   * 2. Find stale webhooks (matching modelId but wrong callbackUrl) → unregister each
   * 3. If no match → call `register` to create a new webhook
   *
   * Graceful degradation: if `list` fails, attempts direct `register`.
   * All errors are caught and returned in the state object.
   */
  async ensureRegistered(callbackUrl: string, modelId?: string): Promise<WebhookRegistrationState> {
    const now = new Date().toISOString();

    try {
      // Try to discover existing webhooks
      let existingWebhooks: Record<string, unknown>[] | null = null;

      if (this.config.list) {
        try {
          existingWebhooks = await this.listWebhooks();
        } catch (err) {
          if (err instanceof LifecycleUrlError) throw err;
          log.warn(
            'Failed to list existing webhooks, attempting direct registration:',
            this.scrub(err instanceof Error ? err.message : String(err)),
          );
          // Fall through to register
        }
      }

      if (existingWebhooks !== null && this.config.list) {
        const listConfig = this.config.list;

        // Find a webhook matching our callback URL (and model ID if applicable)
        const matching = existingWebhooks.find((wh) => {
          const rawUrl = getByPath(wh, listConfig.callbackUrlField);
          const whCallbackUrl = typeof rawUrl === 'string' ? rawUrl : '';
          const urlMatch = whCallbackUrl === callbackUrl;

          if (!urlMatch) return false;
          if (modelId && listConfig.modelIdField) {
            const rawModelId = getByPath(wh, listConfig.modelIdField);
            return (typeof rawModelId === 'string' ? rawModelId : '') === modelId;
          }
          return true;
        });

        if (matching) {
          const webhookId = String(getByPath(matching, listConfig.idField));
          log.info(`Found existing webhook (ID: ${webhookId}), reusing`);
          return { registered: true, webhookId, lastAttempt: now };
        }

        // Clean up stale webhooks (matching model but wrong callback URL)
        if (modelId && listConfig.modelIdField && this.config.unregister) {
          const stale = existingWebhooks.filter((wh) => {
            const rawModelId = getByPath(wh, listConfig.modelIdField!);
            const whModelId = typeof rawModelId === 'string' ? rawModelId : '';
            const rawUrl = getByPath(wh, listConfig.callbackUrlField);
            const whCallbackUrl = typeof rawUrl === 'string' ? rawUrl : '';
            return whModelId === modelId && whCallbackUrl !== callbackUrl;
          });

          for (const staleWh of stale) {
            const staleId = String(getByPath(staleWh, listConfig.idField));
            log.info(`Cleaning up stale webhook (ID: ${staleId})`);
            try {
              await this.unregister(staleId, { throwOnRefusedUrl: true });
            } catch (err) {
              if (err instanceof LifecycleUrlError) throw err;
              log.warn(`Failed to clean up stale webhook ${staleId}:`, err);
            }
          }
        }
      }

      // No existing match — register a new webhook
      if (this.config.register) {
        return await this.register(callbackUrl, modelId);
      }

      // No register config — can't auto-register
      return { registered: false, error: 'No register config defined', lastAttempt: now };
    } catch (err) {
      if (err instanceof LifecycleUrlError) throw err;
      // Upstream error bodies (and fetch errors) can echo resolved secrets, and
      // this message reaches the agent through ingestor_status.
      const error = this.scrub(err instanceof Error ? err.message : String(err));
      log.error('Webhook lifecycle error:', error);
      return { registered: false, error, lastAttempt: now };
    }
  }

  /**
   * Unregister a webhook by ID.
   * Replaces `${_webhookId}` in the unregister URL with the given ID.
   * Errors are logged but never thrown.
   */
  async unregister(webhookId: string, opts: { throwOnRefusedUrl?: boolean } = {}): Promise<void> {
    if (!this.config.unregister) {
      log.warn('No unregister config defined, skipping');
      return;
    }

    const mergedSecrets = { ...this.secrets, _webhookId: webhookId };
    let url: string;
    try {
      // The webhook ID comes from the upstream's list response.
      url = this.checkedUrl(
        resolvePlaceholders(this.config.unregister.url, mergedSecrets),
        this.config.unregister.url,
      );
    } catch (err) {
      if (opts.throwOnRefusedUrl) throw err;
      log.warn((err as Error).message);
      return;
    }
    const headers = this.resolveHeaders(this.config.unregister.headers, mergedSecrets);

    try {
      const { response: resp } = await safeFetch(url, {
        method: this.config.unregister.method,
        headers,
        isAllowed: sameOriginAs(url),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        log.warn(`Webhook unregister failed (${resp.status}): ${this.scrub(body)}`);
      } else {
        log.info(`Webhook unregistered (ID: ${webhookId})`);
      }
    } catch (err) {
      log.warn(
        `Webhook unregister request failed for ${webhookId}:`,
        this.scrub(err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /** Replace every secret this lifecycle resolves with its placeholder. All
   *  of them, not only withheld ones: this is error text, not data. */
  private scrub(text: string): string {
    return scrubSecrets(text, this.secrets);
  }

  /** Fetch the list of existing webhooks from the external service. */
  private async listWebhooks(): Promise<Record<string, unknown>[]> {
    const listConfig = this.config.list!;
    const url = this.checkedUrl(resolvePlaceholders(listConfig.url, this.secrets), listConfig.url);
    const headers = this.resolveHeaders(listConfig.headers);

    const { response: resp } = await safeFetch(url, {
      method: listConfig.method,
      headers,
      isAllowed: sameOriginAs(url),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`List webhooks failed (${resp.status}): ${body}`);
    }

    const json = await resp.json();

    // Extract array from response (may be nested under a dot-path)
    let webhooks: unknown;
    if (listConfig.responsePath) {
      webhooks = getByPath(json, listConfig.responsePath);
    } else {
      webhooks = json;
    }

    if (!Array.isArray(webhooks)) {
      throw new Error(
        `Expected array from list endpoint${listConfig.responsePath ? ` at path "${listConfig.responsePath}"` : ''}, got ${typeof webhooks}`,
      );
    }

    return webhooks as Record<string, unknown>[];
  }

  /** Register a new webhook with the external service. */
  private async register(callbackUrl: string, modelId?: string): Promise<WebhookRegistrationState> {
    const now = new Date().toISOString();
    const registerConfig = this.config.register!;

    // Merge callbackUrl and modelId into resolution context
    const mergedSecrets: Record<string, string> = { ...this.secrets };
    if (callbackUrl) mergedSecrets.CALLBACK_URL = callbackUrl;
    if (modelId) mergedSecrets.MODEL_ID = modelId;

    const url = this.checkedUrl(
      resolvePlaceholders(registerConfig.url, mergedSecrets),
      registerConfig.url,
    );
    const headers = this.resolveHeaders(registerConfig.headers, mergedSecrets);

    const fetchOptions: { method: string; headers: Record<string, string>; body?: string } = {
      method: registerConfig.method,
      headers,
    };

    if (registerConfig.body) {
      const resolvedBody = resolveDeep(registerConfig.body, mergedSecrets);
      fetchOptions.body = JSON.stringify(resolvedBody);
      // Ensure Content-Type is set if there's a body
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const { response: resp } = await safeFetch(url, {
      ...fetchOptions,
      isAllowed: sameOriginAs(url),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return {
        registered: false,
        error: this.scrub(`Register failed (${resp.status}): ${body}`),
        lastAttempt: now,
      };
    }

    const json = await resp.json();
    const rawWebhookId = (json as Record<string, unknown>)[registerConfig.idField];
    const webhookId =
      typeof rawWebhookId === 'string'
        ? rawWebhookId
        : typeof rawWebhookId === 'number'
          ? String(rawWebhookId)
          : '';

    if (!webhookId) {
      return {
        registered: false,
        error: `Register response missing "${registerConfig.idField}" field`,
        lastAttempt: now,
      };
    }

    log.info(`Webhook registered (ID: ${webhookId})`);
    return { registered: true, webhookId, lastAttempt: now };
  }

  /** Resolve headers with placeholder substitution. */
  private resolveHeaders(
    headers?: Record<string, string>,
    secretsOverride?: Record<string, string>,
  ): Record<string, string> {
    if (!headers) return {};
    const secrets = secretsOverride ?? this.secrets;
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      resolved[key] = resolvePlaceholders(value, secrets);
    }
    return resolved;
  }
}
