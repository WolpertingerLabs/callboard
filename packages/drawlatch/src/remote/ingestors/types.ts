/**
 * Shared types for the ingestor subsystem.
 *
 * Ingestors are long-lived data collectors that run on the remote server,
 * pulling real-time events from external services (Discord Gateway, webhooks,
 * polling) and buffering them for the MCP proxy to retrieve via `poll_events`.
 */

import type { WebhookLifecycleConfig } from './webhook/lifecycle-types.js';

// ── Ingestor configuration (stored in connection templates) ─────────────

/** Top-level ingestor configuration attached to a connection template. */
export interface IngestorConfig {
  /** Type of ingestor — determines which runtime class is used. */
  type: 'websocket' | 'webhook' | 'poll';

  /** WebSocket-specific configuration. Required when type is 'websocket'. */
  websocket?: WebSocketIngestorConfig;

  /** Webhook-specific configuration. Required when type is 'webhook'. */
  webhook?: WebhookIngestorConfig;

  /** Polling-specific configuration. Required when type is 'poll'. */
  poll?: PollIngestorConfig;
}

/** Configuration for WebSocket-based ingestors (e.g., Discord Gateway). */
export interface WebSocketIngestorConfig {
  /** WebSocket URL to connect to.
   *  May contain ${VAR} placeholders resolved against the route's secrets. */
  gatewayUrl: string;

  /** Protocol identifier for service-specific handshake logic.
   *  E.g., 'discord' for Discord Gateway (identify/heartbeat/resume). */
  protocol?: string;

  /** Event types to capture. Empty or omitted = capture all dispatch events. */
  eventFilter?: string[];

  /** Discord Gateway intents bitmask.
   *  Only used when protocol is 'discord'.
   *  @see https://discord.com/developers/docs/topics/gateway#gateway-intents */
  intents?: number;

  /** Only buffer events from these guild IDs. Omitted = all guilds.
   *  Events without a guild_id field (e.g., READY, RESUMED) always pass through. */
  guildIds?: string[];

  /** Only buffer events from these channel IDs. Omitted = all channels.
   *  Events without a channel_id field always pass through. */
  channelIds?: string[];

  /** Only buffer events from these user IDs. Omitted = all users.
   *  Checks author.id, user.id, and user_id fields depending on the event type.
   *  Events without a user identifier always pass through. */
  userIds?: string[];
}

/** Configuration for webhook-based ingestors (e.g., GitHub, Stripe, Trello). */
export interface WebhookIngestorConfig {
  /** Path segment for the webhook endpoint (e.g., 'github' -> /webhooks/github). */
  path: string;

  /** Protocol identifier for service-specific signature verification and event extraction.
   *  E.g., 'stripe' for Stripe webhooks, 'trello' for Trello. Omitted = generic (GitHub-compatible). */
  protocol?: string;

  /** HTTP header containing the webhook signature for verification. */
  signatureHeader?: string;

  /** Secret name (from route secrets) used to verify webhook signatures. */
  signatureSecret?: string;

  /** Callback URL used during webhook registration.
   *  Required for services like Trello that include the callback URL in their
   *  signature computation. May contain ${VAR} placeholders resolved from secrets. */
  callbackUrl?: string;

  /** Declarative webhook lifecycle configuration for auto-registration and cleanup.
   *  When present, the ingestor will automatically list, register, and unregister
   *  webhooks with the external service at the appropriate lifecycle moments. */
  lifecycle?: WebhookLifecycleConfig;
}

/** Configuration for polling-based ingestors (e.g., Notion search). */
export interface PollIngestorConfig {
  /** URL to poll. May contain ${VAR} placeholders. */
  url: string;

  /** Poll interval in milliseconds. */
  intervalMs: number;

  /** HTTP method to use (default: 'GET'). */
  method?: string;

  /** Optional request body for POST polls. May contain ${VAR} placeholders. */
  body?: unknown;

  /** Field to use for deduplication (e.g., 'id'). */
  deduplicateBy?: string;

  /** Dot-separated path to extract the items array from the response.
   *  E.g., 'results' for Notion, 'data.issues.nodes' for Linear.
   *  Omit for responses that are already a top-level array. */
  responsePath?: string;

  /** Static event type string to assign to all items from this poll.
   *  E.g., 'page_updated' for Notion, 'issue_updated' for Linear.
   *  Default: 'poll' */
  eventType?: string;

  /** Additional headers to send with the poll request.
   *  Values may contain ${VAR} placeholders.
   *  These are merged UNDER the connection's route headers (route headers take precedence). */
  headers?: Record<string, string>;

  /** Enable ETag-based conditional requests.
   *  When true, the poller stores the ETag from each successful response and sends
   *  `If-None-Match` on subsequent requests. HTTP 304 responses are treated as a
   *  successful no-op (no items, no error). Useful for APIs like GitHub Events
   *  where 304s do not count against rate limits. */
  etag?: boolean;
}

// ── Buffered event ──────────────────────────────────────────────────────

/** A single event received by an ingestor, stored in the ring buffer. */
export interface IngestedEvent {
  /**
   * Monotonically increasing event ID (unique per-ingestor).
   * Epoch-based: `bootEpochSeconds * 1_000_000 + counter`, so IDs are always
   * greater than those from previous server boots.
   */
  id: number;

  /**
   * Idempotency key for deduplication.
   *
   * Derived from service-specific unique identifiers when available
   * (e.g., GitHub delivery ID, Stripe event ID, Slack envelope ID).
   * Falls back to `${source}:${uuid-v4}` for services without natural keys.
   *
   * Consumers can use this key to detect and skip duplicate events
   * caused by webhook retries or reconnection replays.
   */
  idempotencyKey: string;

  /** ISO-8601 timestamp when the event was received by the ingestor. */
  receivedAt: string;

  /** Unix timestamp (milliseconds) when the event was received by the ingestor. */
  receivedAtMs: number;

  /** Caller alias that owns this event (e.g., 'default', 'alice'). */
  callerAlias: string;

  /** Source connection alias (e.g., 'discord-bot', 'github'). */
  source: string;

  /** Instance identifier for multi-instance listeners (e.g., "project-board").
   *  Omitted for single-instance connections (the default). */
  instanceId?: string;

  /** Event type/name (e.g., 'MESSAGE_CREATE', 'push'). */
  eventType: string;

  /** The raw event payload from the external service. */
  data: unknown;
}

// ── Ingestor status ─────────────────────────────────────────────────────

/** Lifecycle state of an ingestor. */
export type IngestorState = 'starting' | 'connected' | 'reconnecting' | 'stopped' | 'error';

/** Runtime status of a single ingestor instance. */
export interface IngestorStatus {
  /** Connection alias this ingestor belongs to. */
  connection: string;

  /** Instance identifier for multi-instance listeners.
   *  Omitted for single-instance connections (the default). */
  instanceId?: string;

  /** Ingestor type. */
  type: 'websocket' | 'webhook' | 'poll';

  /** Current lifecycle state. */
  state: IngestorState;

  /** Number of events currently in the ring buffer. */
  bufferedEvents: number;

  /** Total events received since the ingestor started. */
  totalEventsReceived: number;

  /** ISO-8601 timestamp of the most recent event, or null if none. */
  lastEventAt: string | null;

  /** Error message when state is 'error'. */
  error?: string;

  /** Webhook registration status (only present for webhook ingestors with lifecycle config). */
  webhookRegistration?: {
    registered: boolean;
    webhookId?: string;
    error?: string;
  };
}

// ── Constants ───────────────────────────────────────────────────────────

/** Default ring buffer capacity per ingestor. */
export const DEFAULT_BUFFER_SIZE = 200;

/** Maximum allowed ring buffer capacity. */
export const MAX_BUFFER_SIZE = 1000;
