/**
 * Generic webhook ingestor base class.
 *
 * A passive ingestor that receives HTTP POST requests from webhook providers
 * and buffers them in the ring buffer for retrieval via `poll_events`.
 *
 * Unlike WebSocket ingestors (which maintain outbound connections), webhook
 * ingestors are receivers — the Express server dispatches incoming webhook
 * requests to matching ingestor instances via `handleWebhook()`.
 *
 * Subclasses implement service-specific signature verification and event
 * extraction by overriding `verifySignature()`, `extractEventType()`, and
 * `extractEventData()`.
 *
 * When a `lifecycle` config is present on the webhook config, this class
 * automatically manages webhook registration with the external service:
 * - On `start()`: lists existing webhooks, cleans up stale ones, registers new
 * - On `stop(permanent=true)`: unregisters the webhook (deletion/shutdown only)
 *
 * @see GitHubWebhookIngestor
 * @see StripeWebhookIngestor
 */

import { BaseIngestor } from '../base-ingestor.js';
import type { WebhookIngestorConfig, IngestorStatus } from '../types.js';
import type { WebhookRegistrationState } from './lifecycle-types.js';
import { WebhookLifecycleManager } from './webhook-lifecycle-manager.js';
import { resolvePlaceholders, scrubSecrets } from '../../../shared/config.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('webhook');

// ── Abstract Webhook Ingestor ──────────────────────────────────────────

export abstract class WebhookIngestor extends BaseIngestor {
  /** The path segment this ingestor listens on (e.g., 'github' → /webhooks/github). */
  readonly webhookPath: string;

  /** The name of the secret key in the resolved secrets used for signature verification. */
  protected readonly signatureSecretName: string | undefined;

  /** The header name containing the webhook signature. */
  protected readonly signatureHeader: string | undefined;

  /** Event type filter (empty = capture all). */
  protected readonly eventFilter: string[];

  /** Resolved callback URL (with ${VAR} placeholders replaced). */
  protected readonly resolvedCallbackUrl: string | undefined;

  /** Lifecycle manager for auto-registration (null if no lifecycle config). */
  private readonly lifecycleManager: WebhookLifecycleManager | null;

  /** Runtime state of the webhook registration. */
  protected registrationState: WebhookRegistrationState | null = null;

  constructor(
    connectionAlias: string,
    secrets: Record<string, string>,
    webhookConfig: WebhookIngestorConfig,
    bufferSize?: number,
    instanceId?: string,
  ) {
    super(connectionAlias, 'webhook', secrets, bufferSize, instanceId);
    this.webhookPath = webhookConfig.path;
    this.signatureHeader = webhookConfig.signatureHeader;
    this.signatureSecretName = webhookConfig.signatureSecret;
    this.eventFilter = [];

    // Resolve callbackUrl from secrets if it contains ${VAR} placeholders
    if (webhookConfig.callbackUrl) {
      this.resolvedCallbackUrl = resolvePlaceholders(webhookConfig.callbackUrl, secrets);
    }

    // Initialize lifecycle manager if lifecycle config is present
    if (webhookConfig.lifecycle) {
      this.lifecycleManager = new WebhookLifecycleManager(webhookConfig.lifecycle, secrets);
    } else {
      this.lifecycleManager = null;
    }
  }

  /**
   * Start the webhook ingestor.
   *
   * If a lifecycle config is present, attempts to auto-register the webhook
   * with the external service before setting state to 'connected'.
   * Registration failures are logged but never prevent the ingestor from starting
   * (graceful degradation).
   */
  async start(): Promise<void> {
    // Attempt lifecycle registration if configured
    if (this.lifecycleManager && this.resolvedCallbackUrl) {
      try {
        this.registrationState = await this.lifecycleManager.ensureRegistered(
          this.resolvedCallbackUrl,
          this.getModelId(),
        );
        if (this.registrationState.registered) {
          log.info(
            `Webhook auto-registered for ${this.connectionAlias} ` +
              `(ID: ${this.registrationState.webhookId})`,
          );
        } else if (this.registrationState.error) {
          log.warn(
            `Webhook auto-registration failed for ${this.connectionAlias}: ` +
              this.registrationState.error,
          );
        }
      } catch (err) {
        log.warn(`Webhook lifecycle error for ${this.connectionAlias}:`, err);
        this.registrationState = {
          registered: false,
          error: err instanceof Error ? err.message : String(err),
          lastAttempt: new Date().toISOString(),
        };
      }
    }

    // Always proceed to connected state (graceful degradation)
    this.state = 'connected';
    log.info(
      `Webhook ingestor ready for ${this.connectionAlias} ` +
        `(path: /webhooks/${this.webhookPath})`,
    );
  }

  /**
   * Stop the webhook ingestor.
   *
   * When `permanent` is true (server shutdown or instance deletion), unregisters
   * the webhook from the external service if one was registered.
   * Regular stops (pause/restart) leave the webhook intact.
   */
  async stop(permanent?: boolean): Promise<void> {
    // Unregister webhook on permanent stop if we have a registered webhook
    if (
      permanent &&
      this.lifecycleManager &&
      this.registrationState?.registered &&
      this.registrationState.webhookId
    ) {
      try {
        await this.lifecycleManager.unregister(this.registrationState.webhookId);
        log.info(`Webhook unregistered for ${this.connectionAlias}`);
      } catch (err) {
        log.warn(`Webhook unregistration failed for ${this.connectionAlias}:`, err);
      }
    }

    this.state = 'stopped';
  }

  // ── Lifecycle hooks for subclasses ───────────────────────────────────

  /**
   * Return the model/resource ID for multi-instance webhook registration.
   *
   * Override in subclasses that support multi-instance webhooks (e.g., Trello
   * board ID, GitHub repo name). Used by the lifecycle manager to match
   * existing webhooks and clean up stale registrations.
   *
   * Default: undefined (single-instance).
   */
  protected getModelId(): string | undefined {
    return undefined;
  }

  // ── Status ─────────────────────────────────────────────────────────────

  /** Return status including webhook registration state. */
  override getStatus(): IngestorStatus {
    const status = super.getStatus();

    if (this.registrationState) {
      status.webhookRegistration = {
        registered: this.registrationState.registered,
        ...(this.registrationState.webhookId && { webhookId: this.registrationState.webhookId }),
        // Scrubbed here as well as in the lifecycle manager: this is the one
        // place every registration error passes on its way to ingestor_status.
        ...(this.registrationState.error && {
          error: scrubSecrets(this.registrationState.error, this.secrets),
        }),
      };
    }

    return status;
  }

  // ── Abstract methods for subclasses ───────────────────────────────────

  /**
   * Verify the webhook signature.
   *
   * Called before any body parsing. Subclasses implement service-specific
   * signature verification logic (e.g., HMAC-SHA256 for GitHub, timestamp
   * + HMAC for Stripe).
   *
   * @param headers - The raw HTTP request headers.
   * @param rawBody - The raw request body as a Buffer.
   * @returns An object with `valid: true` if verification passed or was skipped,
   *          or `valid: false` with a `reason` string if verification failed.
   */
  protected abstract verifySignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): { valid: boolean; reason?: string };

  /**
   * Extract the event type from the webhook request.
   *
   * Some providers encode the event type in a header (GitHub: `X-GitHub-Event`),
   * others in the JSON body (Stripe: `body.type`).
   *
   * @param headers - The raw HTTP request headers.
   * @param body - The parsed JSON body.
   * @returns The event type string (e.g., 'push', 'payment_intent.succeeded').
   */
  protected abstract extractEventType(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): string;

  /**
   * Extract the event data to push into the ring buffer.
   *
   * Subclasses determine the shape of the data stored for each event.
   * For example, GitHub stores `{ deliveryId, event, payload }` while
   * Stripe stores `{ eventId, type, payload }`.
   *
   * @param headers - The raw HTTP request headers.
   * @param body - The parsed JSON body.
   * @returns The data object to store in the ring buffer.
   */
  protected abstract extractEventData(
    headers: Record<string, string | string[] | undefined>,
    body: unknown,
  ): unknown;

  /**
   * Instance-level content filter for multi-instance webhook discrimination.
   *
   * Called after signature verification and body parsing. Override in subclasses
   * to filter webhooks by resource (e.g., Trello board ID, GitHub repo name).
   * Return false to silently skip the webhook for this instance.
   *
   * Default: accept all webhooks.
   */
  protected shouldAcceptPayload(_body: unknown): boolean {
    return true;
  }

  /**
   * Extract a service-specific idempotency key from the webhook request.
   *
   * Subclasses override this to return a unique key for deduplication
   * (e.g., GitHub's `X-GitHub-Delivery` header, Stripe's `body.id`).
   *
   * When a key is returned, duplicate events with the same key are silently
   * dropped by the base ingestor's ring buffer.
   *
   * @param headers - The raw HTTP request headers.
   * @param body - The parsed JSON body.
   * @returns A unique idempotency key string, or `undefined` to use a fallback.
   */
  protected extractIdempotencyKey(
    _headers: Record<string, string | string[] | undefined>,
    _body: unknown,
  ): string | undefined {
    return undefined;
  }

  // ── Webhook handling ──────────────────────────────────────────────────

  /**
   * Handle an incoming webhook request.
   *
   * Called by the Express route handler when a POST arrives at
   * `/webhooks/:path` that matches this ingestor's `webhookPath`.
   *
   * Orchestrates the full pipeline: verify → parse → extract → filter → buffer.
   *
   * @param headers - The raw HTTP request headers.
   * @param rawBody - The raw request body as a Buffer (needed for signature verification).
   * @returns An object indicating whether the webhook was accepted or rejected.
   */
  handleWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: Buffer,
  ): { accepted: boolean; reason?: string } {
    log.debug(`${this.connectionAlias} received webhook (${rawBody.length} bytes)`);

    // 1. Signature verification (delegated to subclass)
    const verification = this.verifySignature(headers, rawBody);
    if (!verification.valid) {
      log.debug(`${this.connectionAlias} webhook rejected: ${verification.reason}`);
      return { accepted: false, reason: verification.reason };
    }

    // 2. Parse body
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf-8'));
    } catch {
      return { accepted: false, reason: 'Invalid JSON body' };
    }

    // 2.5. Instance-level content filter (for multi-instance discrimination)
    if (!this.shouldAcceptPayload(body)) {
      return { accepted: true, reason: 'Not for this instance' };
    }

    // 3. Determine event type (delegated to subclass)
    const eventType = this.extractEventType(headers, body);

    // 4. Apply event filter (if any — reserved for future caller overrides)
    if (this.eventFilter.length > 0 && !this.eventFilter.includes(eventType)) {
      return { accepted: true, reason: 'Filtered out' };
    }

    // 5. Extract event data (delegated to subclass)
    const data = this.extractEventData(headers, body);

    // 6. Extract idempotency key (delegated to subclass, fallback in pushEvent)
    const idempotencyKey = this.extractIdempotencyKey(headers, body);

    // 7. Push event into ring buffer (dedup handled by base class)
    log.debug(`${this.connectionAlias} dispatching webhook event: ${eventType}`);
    this.pushEvent(eventType, data, idempotencyKey);

    return { accepted: true };
  }
}
