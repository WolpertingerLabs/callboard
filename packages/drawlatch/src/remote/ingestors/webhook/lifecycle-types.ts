/**
 * Type definitions for webhook lifecycle management.
 *
 * Webhook lifecycle configs are declared in connection JSON templates and
 * describe how to list, register, and unregister webhooks with external
 * services (Trello, GitHub, Stripe, etc.).
 *
 * All URL and body values support `${VAR}` placeholder resolution against
 * resolved secrets and instance params.
 */

// ── Lifecycle Configuration ──────────────────────────────────────────────

/** Lifecycle configuration for a webhook ingestor. */
export interface WebhookLifecycleConfig {
  /**
   * List existing webhooks from the external service.
   * Used to find existing registrations and detect stale ones.
   */
  list?: {
    method: string;
    url: string; // supports ${VAR} placeholders
    headers?: Record<string, string>;
    /** Dot-path to the array in the response (omit if top-level array). */
    responsePath?: string;
    /** Field name in each webhook object containing the callback URL. */
    callbackUrlField: string;
    /** Field name in each webhook object containing the webhook ID. */
    idField: string;
    /** Field name in each webhook object containing the model/resource ID. */
    modelIdField?: string;
  };

  /**
   * Register a new webhook with the external service.
   */
  register?: {
    method: string;
    url: string; // supports ${VAR} placeholders
    headers?: Record<string, string>;
    /** Request body (supports ${VAR} and ${instanceParam} placeholders). */
    body?: Record<string, unknown>;
    /** Field name in the response containing the new webhook ID. */
    idField: string;
  };

  /**
   * Unregister (delete) a webhook from the external service.
   * The URL supports ${_webhookId} which is replaced at call time.
   */
  unregister?: {
    method: string;
    url: string; // ${_webhookId} replaced at call time
    headers?: Record<string, string>;
  };
}

// ── Runtime State ────────────────────────────────────────────────────────

/** Runtime state of a webhook registration. */
export interface WebhookRegistrationState {
  /** Whether the webhook is currently registered with the external service. */
  registered: boolean;
  /** The ID of the registered webhook (from the external service). */
  webhookId?: string;
  /** Error message if registration failed. */
  error?: string;
  /** ISO-8601 timestamp of the last registration attempt. */
  lastAttempt?: string;
}
