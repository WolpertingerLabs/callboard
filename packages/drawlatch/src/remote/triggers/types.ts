/**
 * Trigger rule types for the event-to-agent bridge.
 *
 * Trigger rules define how ingestor events are dispatched to Claude Code
 * remote triggers. Each rule matches events by source, event type, and
 * optional filter predicates, then invokes a remote trigger with the
 * event payload.
 */

// ── Trigger rule ───────────────────────────────────────────────────────

/** A single trigger rule that maps ingestor events to a remote trigger invocation. */
export interface TriggerRule {
  /** Human-readable name for logging and diagnostics. */
  name: string;

  /** Connection alias to match events from (e.g., "github", "discord-bot"). */
  source: string;

  /** Optional instance ID filter (for multi-instance listeners). */
  instanceId?: string;

  /** Event types to match. Empty or omitted = match all event types. */
  eventTypes?: string[];

  /**
   * Dot-path filter predicates applied to the event data.
   *
   * Keys are dot-separated paths into `event.data` (e.g., "payload.action").
   * Values are arrays of acceptable values — the event matches if the resolved
   * value equals any entry in the array.
   *
   * All predicates must match for the rule to fire (AND logic).
   */
  filter?: Record<string, unknown[]>;

  /** Target to invoke when the rule matches. */
  target: TriggerTarget;

  /** Rate limiting and deduplication. */
  throttle?: TriggerThrottle;

  /** Whether this rule is active. Default: true. */
  enabled?: boolean;
}

// ── Trigger target ─────────────────────────────────────────────────────

/** Target for a trigger rule — currently only remote triggers are supported. */
export interface TriggerTarget {
  /** Target type. */
  type: 'remote_trigger';

  /** Claude Code RemoteTrigger ID (e.g., "trg_abc123"). */
  triggerId: string;
}

// ── Throttle ───────────────────────────────────────────────────────────

/** Rate limiting and deduplication for trigger dispatch. */
export interface TriggerThrottle {
  /** Maximum dispatches per minute for this rule. Default: 10. */
  maxPerMinute?: number;

  /**
   * Dot-path into event data to use as a deduplication key.
   * E.g., "payload.pull_request.number" — prevents the same PR from
   * triggering multiple times within the throttle window.
   */
  deduplicateBy?: string;
}

// ── Dispatch result ────────────────────────────────────────────────────

/** Result of a single trigger dispatch attempt. */
export interface TriggerDispatchResult {
  /** Rule name that fired. */
  rule: string;
  /** Whether the dispatch succeeded. */
  success: boolean;
  /** Trigger ID that was invoked. */
  triggerId: string;
  /** HTTP status code from the remote trigger API. */
  statusCode?: number;
  /** Error message if dispatch failed. */
  error?: string;
  /** ISO-8601 timestamp of the dispatch. */
  dispatchedAt: string;
}
