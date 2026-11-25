/**
 * Slack Socket Mode ingestor.
 *
 * Connects to Slack via Socket Mode WebSocket and streams real-time events
 * (messages, slash commands, interactions, etc.) into the ring buffer.
 *
 * Implements the Socket Mode lifecycle:
 *   1. POST apps.connections.open (app-level token) → get WebSocket URL
 *   2. Connect to WebSocket → receive `hello`
 *   3. Receive envelopes → acknowledge → buffer events
 *   4. Handle `disconnect` messages → reconnect
 *
 * Uses the native WebSocket API (Node 22+) and native fetch.
 *
 * @see https://docs.slack.dev/apis/events-api/using-socket-mode
 */

import { BaseIngestor } from '../base-ingestor.js';
import type { WebSocketIngestorConfig } from '../types.js';
import { registerIngestorFactory } from '../registry.js';
import {
  extractSlackEventType,
  extractSlackChannelId,
  extractSlackUserId,
  type SlackEnvelope,
  type SlackHello,
  type SlackDisconnect,
  type SlackConnectionsOpenResponse,
} from './types.js';
import { createLogger } from '../../../shared/logger.js';
import { safeFetch, sameOriginAs } from '../../safe-fetch.js';

const log = createLogger('slack-sm');

// ── Slack Socket Mode ingestor ──────────────────────────────────────────

export class SlackSocketModeIngestor extends BaseIngestor {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** The URL for the apps.connections.open endpoint. */
  private readonly connectUrl: string;
  private readonly eventFilter: string[];
  private readonly channelIds: Set<string>;
  private readonly userIds: Set<string>;

  constructor(
    connectionAlias: string,
    secrets: Record<string, string>,
    wsConfig: WebSocketIngestorConfig,
    bufferSize?: number,
    instanceId?: string,
  ) {
    super(connectionAlias, 'websocket', secrets, bufferSize, instanceId);
    this.connectUrl = wsConfig.gatewayUrl;
    this.eventFilter = wsConfig.eventFilter ?? [];
    this.channelIds = new Set(wsConfig.channelIds ?? []);
    this.userIds = new Set(wsConfig.userIds ?? []);
  }

  async start(): Promise<void> {
    this.state = 'starting';
    await this.openConnection();
  }

  stop(_permanent?: boolean): Promise<void> {
    this.state = 'stopped';
    this.clearReconnectTimer();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      // Wait for the WebSocket to fully close before resolving.
      // This prevents a race where the old connection is still alive when a new
      // ingestor starts, causing Slack to distribute events to the dying
      // connection (where nobody processes them).
      return new Promise<void>((resolve) => {
        const onClose = () => {
          ws.removeEventListener('close', onClose);
          resolve();
        };
        if (ws.readyState === WebSocket.CLOSED) {
          resolve();
        } else {
          ws.addEventListener('close', onClose);
          ws.close(1000, 'Shutting down');
          // Safety timeout — don't block forever if close event never fires
          setTimeout(() => {
            ws.removeEventListener('close', onClose);
            resolve();
          }, 5000);
        }
      });
    }
    return Promise.resolve();
  }

  // ── Connection establishment ────────────────────────────────────────

  /**
   * Call apps.connections.open to get a dynamic WebSocket URL, then connect.
   */
  private async openConnection(): Promise<void> {
    const appToken = this.secrets.SLACK_APP_TOKEN;
    if (!appToken) {
      this.state = 'error';
      this.errorMessage = 'SLACK_APP_TOKEN not found in resolved secrets';
      log.error(`${this.errorMessage} (${this.connectionAlias})`);
      return;
    }

    let wsUrl: string;
    try {
      const { response } = await safeFetch(this.connectUrl, {
        isAllowed: sameOriginAs(this.connectUrl),
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        this.state = 'error';
        this.errorMessage =
          response.status >= 300 && response.status < 400
            ? `apps.connections.open returned HTTP ${response.status}: redirect not followed (only same-origin redirects are)`
            : `apps.connections.open failed: HTTP ${response.status} ${response.statusText}`;
        log.error(`${this.errorMessage} (${this.connectionAlias})`);
        return;
      }

      const body = (await response.json()) as SlackConnectionsOpenResponse;

      if (!body.ok || !body.url) {
        this.state = 'error';
        this.errorMessage = `apps.connections.open failed: ${body.error ?? 'no URL returned'}`;
        log.error(`${this.errorMessage} (${this.connectionAlias})`);
        return;
      }

      wsUrl = body.url;
    } catch (err) {
      this.state = 'error';
      this.errorMessage = `Failed to call apps.connections.open: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`${this.errorMessage} (${this.connectionAlias})`);
      return;
    }

    this.connectWebSocket(wsUrl);
  }

  // ── WebSocket connection ────────────────────────────────────────────

  private connectWebSocket(url: string): void {
    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.state = 'error';
      this.errorMessage = `Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`${this.errorMessage} (${this.connectionAlias})`);
      return;
    }

    this.ws.addEventListener('open', () => {
      log.info(`WebSocket connected for ${this.connectionAlias}`);
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        const envelope = JSON.parse(data) as SlackEnvelope;
        this.handleEnvelope(envelope);
      } catch (err) {
        log.error(`Failed to parse Socket Mode message:`, err);
      }
    });

    this.ws.addEventListener('close', (event: CloseEvent) => {
      log.info(`Connection closed for ${this.connectionAlias}: ${event.code} ${event.reason}`);
      if (this.state !== 'stopped') {
        this.scheduleReconnect();
      }
    });

    this.ws.addEventListener('error', () => {
      // The 'close' event always follows 'error', so we handle reconnection there.
      log.error(`WebSocket error for ${this.connectionAlias}`);
    });
  }

  // ── Envelope dispatch ──────────────────────────────────────────────

  private handleEnvelope(envelope: SlackEnvelope): void {
    switch (envelope.type) {
      case 'hello':
        this.handleHello(envelope as SlackHello);
        break;

      case 'disconnect':
        this.handleDisconnect(envelope as SlackDisconnect);
        break;

      case 'events_api':
      case 'slash_commands':
      case 'interactive':
        this.handleEvent(envelope);
        break;

      default:
        log.warn(`Unknown message type "${String(envelope.type)}" for ${this.connectionAlias}`);
        // Still acknowledge if there's an envelope_id
        if (envelope.envelope_id) {
          this.acknowledge(envelope.envelope_id);
        }
        break;
    }
  }

  // ── Hello ─────────────────────────────────────────────────────────

  private handleHello(hello: SlackHello): void {
    this.state = 'connected';
    this.reconnectAttempts = 0;
    log.info(
      `Connected for ${this.connectionAlias} ` +
        `(app: ${hello.connection_info.app_id}, connections: ${hello.num_connections}, ` +
        `refresh in ~${hello.debug_info.approximate_connection_time}s)`,
    );
  }

  // ── Disconnect ────────────────────────────────────────────────────

  private handleDisconnect(disconnect: SlackDisconnect): void {
    log.info(
      `Disconnect for ${this.connectionAlias}: ${disconnect.reason} ` +
        `(host: ${disconnect.debug_info.host})`,
    );

    switch (disconnect.reason) {
      case 'refresh_requested':
      case 'warning':
        // Normal refresh — reconnect immediately
        this.initiateReconnect();
        break;

      case 'link_disabled':
        // Socket Mode was disabled for the app — stop permanently
        this.state = 'error';
        this.errorMessage = 'Socket Mode was disabled for this app (link_disabled)';
        log.error(`${this.errorMessage} (${this.connectionAlias})`);
        if (this.ws) {
          this.ws.close(1000, 'Link disabled');
          this.ws = null;
        }
        break;
    }
  }

  // ── Event handling ────────────────────────────────────────────────

  private handleEvent(envelope: SlackEnvelope): void {
    // Always acknowledge first — Slack expects prompt acks
    if (envelope.envelope_id) {
      this.acknowledge(envelope.envelope_id);
    }

    // Determine the specific event type for filtering and buffering
    const eventType = extractSlackEventType(envelope);

    // Apply event type filter (empty filter = capture all)
    if (this.eventFilter.length > 0 && !this.eventFilter.includes(eventType)) {
      log.debug(`${this.connectionAlias} event filtered out by eventFilter: ${eventType}`);
      return;
    }

    // Apply payload-level filters.
    // Events without the filtered field pass through (same convention as Discord).
    if (this.channelIds.size > 0) {
      const channelId = extractSlackChannelId(envelope);
      if (channelId && !this.channelIds.has(channelId)) return;
    }

    if (this.userIds.size > 0) {
      const userId = extractSlackUserId(envelope);
      if (userId && !this.userIds.has(userId)) return;
    }

    // Buffer the event (use envelope_id as idempotency key for retry dedup)
    const idempotencyKey = envelope.envelope_id ? `slack:${envelope.envelope_id}` : undefined;
    log.debug(
      `${this.connectionAlias} dispatching event: ${eventType} (envelope: ${envelope.type})`,
    );
    this.pushEvent(eventType, envelope.payload, idempotencyKey);
  }

  // ── Acknowledgment ────────────────────────────────────────────────

  private acknowledge(envelopeId: string): void {
    this.send({ envelope_id: envelopeId });
  }

  // ── Reconnection ──────────────────────────────────────────────────

  private initiateReconnect(): void {
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close(1000, 'Reconnecting');
      this.ws = null;
    }
    // Reset attempts for intentional refreshes (Slack-initiated)
    this.reconnectAttempts = 0;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.state === 'stopped') return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.state = 'error';
      this.errorMessage = `Max reconnect attempts (${this.maxReconnectAttempts}) exceeded`;
      log.error(`${this.errorMessage} (${this.connectionAlias})`);
      return;
    }

    this.state = 'reconnecting';
    this.reconnectAttempts++;
    const backoff = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    log.info(
      `Reconnecting ${this.connectionAlias} in ${backoff}ms ` +
        `(attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Must re-fetch a new WebSocket URL each time — Slack URLs are single-use
      void this.openConnection();
    }, backoff);
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// ── Self-registration ────────────────────────────────────────────────────

registerIngestorFactory(
  'websocket:slack',
  (connectionAlias, config, secrets, bufferSize, instanceId) => {
    if (!config.websocket) {
      log.error(`Missing websocket config for ${connectionAlias}`);
      return null;
    }
    return new SlackSocketModeIngestor(
      connectionAlias,
      secrets,
      config.websocket,
      bufferSize,
      instanceId,
    );
  },
);
