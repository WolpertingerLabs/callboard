/**
 * Discord Gateway (WebSocket) ingestor.
 *
 * Connects to the Discord Gateway v10 and streams real-time events
 * (messages, reactions, presence updates, etc.) into the ring buffer.
 *
 * Implements the full Gateway lifecycle:
 *   Hello → Identify → Ready → Dispatch loop
 *   Heartbeat with jitter, ACK tracking, zombie detection
 *   Resume support (session_id + sequence)
 *   Exponential backoff reconnection
 *
 * Uses the native WebSocket API (Node 22+).
 *
 * @see https://discord.com/developers/docs/events/gateway
 */

import { BaseIngestor } from '../base-ingestor.js';
import type { WebSocketIngestorConfig } from '../types.js';
import { registerIngestorFactory } from '../registry.js';
import {
  GatewayOp,
  DEFAULT_INTENTS,
  NON_RECOVERABLE_CLOSE_CODES,
  INVALIDATE_SESSION_CLOSE_CODES,
  extractUserId,
  type GatewayPayload,
} from './types.js';
import { createLogger } from '../../../shared/logger.js';

const log = createLogger('discord-gw');

// ── Discord Gateway ingestor ────────────────────────────────────────────

export class DiscordGatewayIngestor extends BaseIngestor {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatJitterTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatAcked = true;

  /** Discord sequence number — tracks the last dispatch event received. */
  private sequenceNumber: number | null = null;
  /** Discord session ID — needed for RESUME. */
  private discordSessionId: string | null = null;
  /** Resume Gateway URL — provided in READY, used for reconnection. */
  private resumeGatewayUrl: string | null = null;

  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly gatewayUrl: string;
  private readonly intents: number;
  private readonly eventFilter: string[];
  private readonly guildIds: Set<string>;
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
    this.gatewayUrl = wsConfig.gatewayUrl;
    this.intents = wsConfig.intents ?? DEFAULT_INTENTS;
    this.eventFilter = wsConfig.eventFilter ?? [];
    this.guildIds = new Set(wsConfig.guildIds ?? []);
    this.channelIds = new Set(wsConfig.channelIds ?? []);
    this.userIds = new Set(wsConfig.userIds ?? []);
  }

  start(): Promise<void> {
    this.state = 'starting';
    this.connect(this.gatewayUrl);
    return Promise.resolve();
  }

  stop(_permanent?: boolean): Promise<void> {
    this.state = 'stopped';
    this.clearAllTimers();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      // Wait for the WebSocket to fully close before resolving.
      // This prevents a race where the old connection is still alive when a new
      // ingestor starts. For Discord, this avoids the old gateway session
      // lingering while a new IDENTIFY is sent (which Discord may reject
      // if it sees two sessions for the same bot token).
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

  // ── WebSocket connection ────────────────────────────────────────────

  private connect(url: string): void {
    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this.state = 'error';
      this.errorMessage = `Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`;
      log.error(`${this.errorMessage} (${this.connectionAlias})`);
      return;
    }

    this.ws.addEventListener('open', () => {
      log.info(`Connected to Gateway for ${this.connectionAlias}`);
    });

    this.ws.addEventListener('message', (event: MessageEvent) => {
      try {
        const data = typeof event.data === 'string' ? event.data : String(event.data);
        const payload = JSON.parse(data) as GatewayPayload;
        this.handlePayload(payload);
      } catch (err) {
        log.error(`Failed to parse Gateway message:`, err);
      }
    });

    this.ws.addEventListener('close', (event: CloseEvent) => {
      log.info(`Connection closed for ${this.connectionAlias}: ${event.code} ${event.reason}`);
      this.clearAllTimers();
      if (this.state !== 'stopped') {
        this.handleClose(event.code);
      }
    });

    this.ws.addEventListener('error', () => {
      // The 'close' event always follows 'error', so we handle reconnection there.
      log.error(`WebSocket error for ${this.connectionAlias}`);
    });
  }

  // ── Gateway payload dispatch ────────────────────────────────────────

  private handlePayload(payload: GatewayPayload): void {
    switch (payload.op) {
      case GatewayOp.HELLO:
        this.handleHello(payload.d as { heartbeat_interval: number });
        break;
      case GatewayOp.HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        break;
      case GatewayOp.HEARTBEAT:
        // Server requested an immediate heartbeat
        this.sendHeartbeat();
        break;
      case GatewayOp.DISPATCH:
        this.handleDispatch(payload);
        break;
      case GatewayOp.RECONNECT:
        log.info(`Server requested reconnect for ${this.connectionAlias}`);
        this.initiateReconnect();
        break;
      case GatewayOp.INVALID_SESSION:
        this.handleInvalidSession(payload.d as boolean);
        break;
    }
  }

  // ── Hello → Identify / Resume ───────────────────────────────────────

  private handleHello(data: { heartbeat_interval: number }): void {
    this.startHeartbeat(data.heartbeat_interval);

    if (this.discordSessionId && this.sequenceNumber !== null) {
      this.sendResume();
    } else {
      this.sendIdentify();
    }
  }

  private sendIdentify(): void {
    const token = this.secrets.DISCORD_BOT_TOKEN;
    if (!token) {
      this.state = 'error';
      this.errorMessage = 'DISCORD_BOT_TOKEN not found in resolved secrets';
      log.error(`${this.errorMessage} (${this.connectionAlias})`);
      return;
    }

    this.send({
      op: GatewayOp.IDENTIFY,
      d: {
        token,
        intents: this.intents,
        properties: {
          os: 'linux',
          browser: 'drawlatch',
          device: 'drawlatch',
        },
      },
    });
  }

  private sendResume(): void {
    const token = this.secrets.DISCORD_BOT_TOKEN;
    this.send({
      op: GatewayOp.RESUME,
      d: {
        token,
        session_id: this.discordSessionId,
        seq: this.sequenceNumber,
      },
    });
  }

  // ── Dispatch (op 0) events ──────────────────────────────────────────

  private handleDispatch(payload: GatewayPayload): void {
    // Track sequence number
    if (payload.s !== null) {
      this.sequenceNumber = payload.s;
    }

    const eventName = payload.t;
    if (!eventName) return;

    // Handle READY — capture session info for resume
    if (eventName === 'READY') {
      const readyData = payload.d as { session_id: string; resume_gateway_url: string };
      this.discordSessionId = readyData.session_id;
      this.resumeGatewayUrl = readyData.resume_gateway_url;
      this.state = 'connected';
      this.reconnectAttempts = 0;
      log.info(`Ready for ${this.connectionAlias} (session: ${this.discordSessionId})`);
    }

    // Handle RESUMED
    if (eventName === 'RESUMED') {
      this.state = 'connected';
      this.reconnectAttempts = 0;
      log.info(`Resumed for ${this.connectionAlias}`);
    }

    // Apply event type filter (empty filter = capture all)
    if (this.eventFilter.length > 0 && !this.eventFilter.includes(eventName)) {
      log.debug(`${this.connectionAlias} event filtered out by eventFilter: ${eventName}`);
      return;
    }

    // Apply payload-level filters (guild, channel, user).
    // Events without the filtered field pass through — this preserves lifecycle
    // events like READY, RESUMED, and GUILD_CREATE that are essential.
    if (this.guildIds.size > 0 || this.channelIds.size > 0 || this.userIds.size > 0) {
      const data = payload.d as Record<string, unknown> | null;
      if (data) {
        if (this.guildIds.size > 0 && typeof data.guild_id === 'string') {
          if (!this.guildIds.has(data.guild_id)) return;
        }
        if (this.channelIds.size > 0 && typeof data.channel_id === 'string') {
          if (!this.channelIds.has(data.channel_id)) return;
        }
        if (this.userIds.size > 0) {
          const userId = extractUserId(data);
          if (userId && !this.userIds.has(userId)) return;
        }
      }
    }

    // Buffer the event (use session ID + sequence number as idempotency key).
    // The session ID ensures keys from different Gateway sessions never collide —
    // sequence numbers reset to 1 on each new session (reconnect/reboot), so
    // without a session component, consumers seeding their dedup set from historical
    // events will falsely match new events with recycled sequence numbers.
    const idempotencyKey =
      payload.s !== null
        ? `discord:${this.connectionAlias}:${this.discordSessionId ?? 'nosess'}:seq:${payload.s}`
        : undefined;
    log.debug(`${this.connectionAlias} dispatching event: ${eventName} (seq: ${payload.s})`);
    this.pushEvent(eventName, payload.d, idempotencyKey);
  }

  // ── Invalid Session ─────────────────────────────────────────────────

  private handleInvalidSession(resumable: boolean): void {
    if (resumable) {
      // Can resume — wait a random 1-5 seconds then resume
      const delay = 1000 + Math.random() * 4000;
      setTimeout(() => this.sendResume(), delay);
    } else {
      // Cannot resume — clear session state and re-identify
      this.discordSessionId = null;
      this.sequenceNumber = null;
      const delay = 1000 + Math.random() * 4000;
      setTimeout(() => this.sendIdentify(), delay);
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────

  private startHeartbeat(intervalMs: number): void {
    this.clearAllTimers();

    // First heartbeat after random jitter (0..intervalMs)
    const jitter = Math.random() * intervalMs;
    this.heartbeatJitterTimer = setTimeout(() => {
      this.heartbeatJitterTimer = null;
      this.sendHeartbeat();

      this.heartbeatTimer = setInterval(() => {
        if (!this.heartbeatAcked) {
          // Zombie connection — server stopped responding
          log.info(`Heartbeat not ACKed, reconnecting ${this.connectionAlias}`);
          this.initiateReconnect();
          return;
        }
        this.heartbeatAcked = false;
        this.sendHeartbeat();
      }, intervalMs);
    }, jitter);
  }

  private sendHeartbeat(): void {
    this.send({ op: GatewayOp.HEARTBEAT, d: this.sequenceNumber });
  }

  // ── Reconnection ───────────────────────────────────────────────────

  private handleClose(code: number): void {
    // Non-recoverable codes: stop permanently
    if (NON_RECOVERABLE_CLOSE_CODES.has(code)) {
      this.state = 'error';
      this.errorMessage = `Non-recoverable Gateway close code: ${code}`;
      log.error(`${this.errorMessage} (${this.connectionAlias})`);
      return;
    }

    // Codes that invalidate the session: clear state so we re-IDENTIFY
    if (INVALIDATE_SESSION_CLOSE_CODES.has(code)) {
      this.discordSessionId = null;
      this.sequenceNumber = null;
    }

    this.scheduleReconnect();
  }

  private initiateReconnect(): void {
    this.clearAllTimers();
    if (this.ws) {
      // Close with code 4000 to signal intentional reconnect to Discord
      this.ws.close(4000, 'Reconnecting');
      this.ws = null;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
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
      `Reconnecting ${this.connectionAlias} in ${backoff}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const url = this.resumeGatewayUrl ?? this.gatewayUrl;
      this.connect(url);
    }, backoff);
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private send(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private clearAllTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.heartbeatJitterTimer) {
      clearTimeout(this.heartbeatJitterTimer);
      this.heartbeatJitterTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// ── Self-registration ────────────────────────────────────────────────────

registerIngestorFactory(
  'websocket:discord',
  (connectionAlias, config, secrets, bufferSize, instanceId) => {
    if (!config.websocket) {
      log.error(`Missing websocket config for ${connectionAlias}`);
      return null;
    }
    return new DiscordGatewayIngestor(
      connectionAlias,
      secrets,
      config.websocket,
      bufferSize,
      instanceId,
    );
  },
);
