/**
 * Slack-specific types and constants for the Socket Mode ingestor.
 *
 * @see https://docs.slack.dev/apis/events-api/using-socket-mode
 */

// ── Socket Mode message types ───────────────────────────────────────────

/** Top-level message types received over the Socket Mode WebSocket. */
export type SlackMessageType =
  | 'hello'
  | 'events_api'
  | 'slash_commands'
  | 'interactive'
  | 'disconnect';

/** Reasons a Socket Mode disconnect message may be sent. */
export type SlackDisconnectReason = 'link_disabled' | 'warning' | 'refresh_requested';

// ── Envelope format ─────────────────────────────────────────────────────

/**
 * Envelope wrapper for all Socket Mode messages.
 * Every non-hello/disconnect message has an `envelope_id` that must be acknowledged.
 */
export interface SlackEnvelope {
  /** Message type — determines how to process the payload. */
  type: SlackMessageType;
  /** Unique ID for this envelope. Send it back to acknowledge receipt. */
  envelope_id?: string;
  /** The actual event/command/interaction payload. */
  payload?: unknown;
  /** Whether Slack accepts a response payload in the acknowledgment. */
  accepts_response_payload?: boolean;
}

// ── Specific message shapes ─────────────────────────────────────────────

/** Hello message received immediately after WebSocket connection. */
export interface SlackHello {
  type: 'hello';
  connection_info: {
    app_id: string;
  };
  num_connections: number;
  debug_info: {
    host: string;
    started: string;
    build_number: number;
    /** Approximate seconds until this connection will be refreshed. */
    approximate_connection_time: number;
  };
}

/** Disconnect message sent by Slack before closing the connection. */
export interface SlackDisconnect {
  type: 'disconnect';
  reason: SlackDisconnectReason;
  debug_info: {
    host: string;
  };
}

/** Shape of the `apps.connections.open` API response. */
export interface SlackConnectionsOpenResponse {
  ok: boolean;
  url?: string;
  error?: string;
}

// ── Payload helpers ─────────────────────────────────────────────────────

/**
 * Extract the Slack event type from an envelope payload.
 * For `events_api` envelopes, the event type is at `payload.event.type`.
 * For `slash_commands`, we use the command name.
 * For `interactive`, we use the interaction type.
 */
export function extractSlackEventType(envelope: SlackEnvelope): string {
  const payload = envelope.payload as Record<string, unknown> | undefined;
  if (!payload) return envelope.type;

  switch (envelope.type) {
    case 'events_api': {
      const event = payload.event as Record<string, unknown> | undefined;
      return typeof event?.type === 'string' ? event.type : 'events_api';
    }
    case 'slash_commands':
      return typeof payload.command === 'string' ? payload.command : 'slash_command';
    case 'interactive':
      return typeof payload.type === 'string' ? payload.type : 'interactive';
    default:
      return envelope.type;
  }
}

/**
 * Extract a channel ID from a Slack envelope payload.
 * Checks `payload.event.channel`, `payload.channel_id`, and `payload.channel.id`.
 */
export function extractSlackChannelId(envelope: SlackEnvelope): string | undefined {
  const payload = envelope.payload as Record<string, unknown> | undefined;
  if (!payload) return undefined;

  // events_api: event.channel
  const event = payload.event as Record<string, unknown> | undefined;
  if (typeof event?.channel === 'string') return event.channel;

  // slash_commands / interactive: channel_id
  if (typeof payload.channel_id === 'string') return payload.channel_id;

  // interactive: channel.id
  const channel = payload.channel as Record<string, unknown> | undefined;
  if (typeof channel?.id === 'string') return channel.id;

  return undefined;
}

/**
 * Extract a user ID from a Slack envelope payload.
 * Checks `payload.event.user`, `payload.user_id`, and `payload.user.id`.
 */
export function extractSlackUserId(envelope: SlackEnvelope): string | undefined {
  const payload = envelope.payload as Record<string, unknown> | undefined;
  if (!payload) return undefined;

  // events_api: event.user
  const event = payload.event as Record<string, unknown> | undefined;
  if (typeof event?.user === 'string') return event.user;

  // slash_commands / interactive: user_id
  if (typeof payload.user_id === 'string') return payload.user_id;

  // interactive: user.id
  const user = payload.user as Record<string, unknown> | undefined;
  if (typeof user?.id === 'string') return user.id;

  return undefined;
}
