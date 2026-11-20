/**
 * Abstract base class for all ingestor types.
 *
 * Provides common functionality: ring buffer management, event counting,
 * status reporting, and a standard interface for start/stop lifecycle.
 *
 * Subclasses implement `start()` and `stop()` for their specific protocol
 * (WebSocket, webhook listener, HTTP poller, etc.) and call `pushEvent()`
 * whenever they receive data from the external service.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import type { IngestedEvent, IngestorState, IngestorStatus } from './types.js';
import { RingBuffer } from './ring-buffer.js';
import { DEFAULT_BUFFER_SIZE } from './types.js';
import { createLogger } from '../../shared/logger.js';
import {
  compileSecretScrubber,
  scrubSecrets,
  scrubSecretsDeep,
  type SecretScrubber,
} from '../../shared/config.js';

const log = createLogger('ingestor');

/** Maximum number of idempotency keys to track for deduplication.
 *  When exceeded, the oldest half is pruned. */
const MAX_SEEN_KEYS = 2000;

/**
 * Epoch-based event IDs that are monotonically increasing across restarts.
 * Format: `bootEpochSeconds * 1_000_000 + counter`.
 *
 * Uses seconds (not milliseconds) so the product stays within Number.MAX_SAFE_INTEGER.
 * This prevents clients with a stale `after_id` cursor from missing events
 * after a reboot — new IDs will always be higher than pre-reboot IDs
 * (assuming <1M events per instance and >1s between restarts).
 *
 * Uses a monotonically increasing module-level epoch so that in-process restarts
 * (e.g., LocalProxy.reinitialize()) also produce strictly increasing IDs.
 * Each new BaseIngestor instance claims the next available epoch.
 */
let nextEpoch = Math.floor(Date.now() / 1000);
const ID_MULTIPLIER = 1_000_000;

export abstract class BaseIngestor extends EventEmitter {
  protected state: IngestorState = 'stopped';
  protected buffer: RingBuffer<IngestedEvent>;
  protected counter = 0;
  protected lastEventAt: string | null = null;
  protected errorMessage?: string;

  /** Caller alias that owns this ingestor. Set by IngestorManager after creation. */
  callerAlias = 'unknown';

  /** Per-instance epoch for event ID generation.
   *  Each instance claims a unique epoch so IDs never collide across restarts. */
  private readonly bootEpoch: number;

  /** Values of the connection's withheld secrets (name → value), scrubbed
   *  from every buffered event. Set by IngestorManager; see
   *  setWithheldSecrets(). */
  private withheldValues: Record<string, string> = {};
  /** withheldValues compiled once, reused for every event. Undefined when
   *  nothing is withheld. */
  private scrubWithheld?: SecretScrubber;

  /** Recently seen idempotency keys for deduplication. */
  private readonly seenKeys = new Set<string>();

  constructor(
    /** The connection alias (e.g., 'discord-bot'). */
    protected readonly connectionAlias: string,
    /** The ingestor type (for status reporting). */
    protected readonly ingestorType: 'websocket' | 'webhook' | 'poll',
    /** Resolved secrets for the parent connection. */
    protected readonly secrets: Record<string, string>,
    /** Buffer capacity (defaults to DEFAULT_BUFFER_SIZE). */
    bufferSize: number = DEFAULT_BUFFER_SIZE,
    /** Optional instance identifier for multi-instance support.
     *  When set, this ingestor is one of N instances for the same connection
     *  (e.g., watching different Trello boards or Reddit subreddits). */
    protected readonly instanceId?: string,
  ) {
    super();
    this.buffer = new RingBuffer<IngestedEvent>(bufferSize);
    // Claim a unique epoch for this instance — ensures event IDs are strictly
    // increasing even when ingestors are restarted in-process.
    this.bootEpoch = nextEpoch++;
  }

  /** Start the ingestor (connect WebSocket, begin polling, etc.). */
  abstract start(): Promise<void>;

  /** Stop the ingestor cleanly (close connections, clear timers).
   *  @param permanent  When true, indicates a permanent shutdown (server exit
   *                    or instance deletion). Webhook ingestors use this to
   *                    unregister webhooks from the external service. */
  abstract stop(permanent?: boolean): Promise<void>;

  /**
   * Scrub these secret values (name → value) from every event this ingestor
   * buffers, replacing them with `${NAME}`. The manager passes the
   * connection's withheld secrets: an event payload that echoes a header
   * token would otherwise hand it to the agent through poll_events,
   * wait_for_events, or a trigger.
   */
  setWithheldSecrets(values: Record<string, string>): void {
    this.withheldValues = values;
    this.scrubWithheld = Object.keys(values).length > 0 ? compileSecretScrubber(values) : undefined;
  }

  /**
   * Push a new event into the ring buffer.
   * Called by subclasses when they receive data from an external service.
   *
   * @param eventType  The event type/name (e.g., 'push', 'MESSAGE_CREATE').
   * @param data       The raw event payload from the external service.
   * @param idempotencyKey  Optional service-specific unique key for deduplication.
   *                        When provided, duplicate events with the same key are silently dropped.
   *                        When omitted, a fallback key is generated from `${source}:${uuid-v4}`.
   */
  protected pushEvent(eventType: string, data: unknown, idempotencyKey?: string): void {
    // When an explicit key is provided, reject duplicates
    if (idempotencyKey && this.seenKeys.has(idempotencyKey)) {
      log.debug(`${this.connectionAlias} duplicate event skipped (key: ${idempotencyKey})`);
      return;
    }

    const now = new Date();
    const id = this.bootEpoch * ID_MULTIPLIER + this.counter++;
    const key = idempotencyKey ?? `${this.connectionAlias}:${crypto.randomUUID()}`;

    const event: IngestedEvent = {
      id,
      idempotencyKey: key,
      receivedAt: now.toISOString(),
      receivedAtMs: now.getTime(),
      callerAlias: this.callerAlias,
      source: this.connectionAlias,
      ...(this.instanceId !== undefined && { instanceId: this.instanceId }),
      eventType,
      data: this.scrubWithheld ? scrubSecretsDeep(data, this.scrubWithheld) : data,
    };
    this.buffer.push(event);
    this.lastEventAt = event.receivedAt;

    // Track the key for future dedup checks
    this.seenKeys.add(key);
    if (this.seenKeys.size > MAX_SEEN_KEYS) {
      this.pruneSeenKeys();
    }

    log.info(`${this.connectionAlias} event #${event.id}: ${eventType}`);
    log.debug(
      `${this.connectionAlias} event #${event.id} payload size:`,
      JSON.stringify(data).length,
    );
    this.emit('event', event);
  }

  /**
   * Prune the seen-keys set to prevent unbounded memory growth.
   * Removes the oldest half of entries (Set preserves insertion order).
   */
  private pruneSeenKeys(): void {
    const pruneCount = Math.floor(this.seenKeys.size / 2);
    let removed = 0;
    for (const key of this.seenKeys) {
      if (removed >= pruneCount) break;
      this.seenKeys.delete(key);
      removed++;
    }
  }

  /**
   * Retrieve events since a cursor.
   * @param afterId  Return events with id > afterId. Pass -1 (or omit) for all buffered events.
   */
  getEvents(afterId = -1): IngestedEvent[] {
    if (afterId < 0) return this.buffer.toArray();
    return this.buffer.since(afterId);
  }

  /** Return the current status of this ingestor. */
  getStatus(): IngestorStatus {
    return {
      connection: this.connectionAlias,
      ...(this.instanceId !== undefined && { instanceId: this.instanceId }),
      type: this.ingestorType,
      state: this.state,
      bufferedEvents: this.buffer.size,
      totalEventsReceived: this.counter,
      lastEventAt: this.lastEventAt,
      // Error text can quote an upstream response or a resolved URL; it reaches
      // the agent through ingestor_status, so scrub every secret from it.
      ...(this.errorMessage && { error: scrubSecrets(this.errorMessage, this.secrets) }),
    };
  }
}
