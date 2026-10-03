/**
 * Response shapes of the MCP-proxy (drawlatch) settings and event-log routes,
 * shared so the backend that writes them and the UI that reads them cannot drift.
 */

export interface StoredEvent {
  /** Monotonically increasing ID from the ingestor */
  id: number;
  /**
   * Idempotency key for deduplication.
   * Derived from service-specific unique identifiers when available
   * (e.g., GitHub delivery ID, Stripe event ID, Slack envelope ID).
   * Falls back to `${source}:${id}` for services without natural keys.
   */
  idempotencyKey?: string;
  /** ISO-8601 timestamp from the proxy */
  receivedAt: string;
  /** Unix timestamp (ms) when the event was received by the ingestor */
  receivedAtMs?: number;
  /** Caller alias that owns this event (e.g. "default", "alice") */
  callerAlias: string;
  /** Connection alias / route name (e.g. "discord-bot", "github") */
  source: string;
  /** Instance ID for multi-instance listeners (e.g. "project-board").
   *  Omitted for single-instance connections. */
  instanceId?: string;
  /** Source-specific event type (e.g. "MESSAGE_CREATE", "push") */
  eventType: string;
  /** Raw payload from external service */
  data: unknown;
  /** Local write timestamp (epoch ms) */
  storedAt: number;
}

export interface ConnectionTestResult {
  /** "unreachable" | "handshake_failed" | "connected" */
  status: "unreachable" | "handshake_failed" | "connected";
  /** Human-readable detail */
  message: string;
  /** Number of routes discovered (only when connected) */
  routeCount?: number;
}
