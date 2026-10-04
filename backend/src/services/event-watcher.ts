/**
 * Per-alias event watchers.
 *
 * Each drawlatch key alias gets its own independent watch loop.
 * On startup, all agents are scanned for unique mcpKeyAlias values and a
 * watcher is started for each. Events are stored in the shared event log
 * and dispatched to the trigger system as before.
 *
 * Two modes:
 *   - "wait": long-polls drawlatch's `wait_for_events`, which holds until one
 *     of this caller's ingestors emits and answers for every stream at once.
 *     One request per wake (or per ~25s when idle), re-issued immediately.
 *   - "legacy": hubs without `wait_for_events` answer "Unknown tool", so we
 *     fall back to the `ingestor_status` + per-connection `poll_events` loop
 *     every EVENT_WATCHER_POLL_INTERVAL and re-probe every 10 minutes.
 *
 * Why: the legacy loop costs (1 + ingestors) requests per 3s cycle, ~100/min
 * at 4 ingestors, against a hub session limit of 60/min that the chat proxy
 * tools share. That loop alone kept the session saturated.
 *
 * Configuration via environment variables:
 *   EVENT_WATCHER_POLL_INTERVAL — legacy poll interval in ms (default: 3000)
 */
import { appendEvent } from "./event-log.js";
import { dispatchEvent } from "./trigger-dispatcher.js";
import { getProxy, type ProxyLike, resetClient } from "./proxy-singleton.js";
import { listAgents } from "./agent-file-service.js";
import { resolveAgentKeyAlias } from "./agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("event-watcher");

// ── Configuration ───────────────────────────────────────────────────

const BASE_POLL_INTERVAL = parseInt(process.env.EVENT_WATCHER_POLL_INTERVAL || "3000", 10);
const MAX_BACKOFF = 60_000; // 60 seconds
/** How long the hub may hold one wait_for_events (it clamps to [0, 55000]). */
const WAIT_TIMEOUT_MS = 25_000;
/** How often a legacy-mode watcher re-checks whether the hub gained wait_for_events. */
const WAIT_REPROBE_INTERVAL = 10 * 60_000;
/** drawlatch's single-instance sentinel; part of the stream key `${connection}:${instanceId}`. */
const DEFAULT_INSTANCE_ID = "_default";

// ── Event shape from drawlatch's poll_events ─────────────────

interface IngestedEvent {
  id: number; // Monotonically increasing per ingestor
  idempotencyKey?: string; // Service-specific unique key for deduplication
  receivedAt: string; // ISO-8601 timestamp
  receivedAtMs?: number; // Unix timestamp (ms) when received by ingestor
  source: string; // Connection alias (e.g., "discord-bot", "github")
  instanceId?: string; // Instance ID for multi-instance listeners
  eventType: string; // Source-specific type (e.g., "MESSAGE_CREATE", "push")
  data: unknown; // Raw payload from external service
}

// ── Ingestor status entry (from ingestor_status tool) ───────────────

interface IngestorStatusEntry {
  connection: string;
  type: string;
  state: string;
  bufferedEvents: number;
  totalEventsReceived: number;
  lastEventAt: string | null;
  error?: string;
}

// ── wait_for_events reply ───────────────────────────────────────────

interface WaitStream {
  connection: string;
  instanceId: string;
  events: IngestedEvent[];
  /** Max event id seen, or the input cursor if none. */
  cursor: number;
}

interface WaitForEventsResult {
  /** Every active stream for this caller, keyed `${connection}:${instanceId}`, including empty ones. */
  streams: Record<string, WaitStream>;
  unknownStreams?: string[];
  timedOut?: boolean;
}

// ── Per-alias watcher state ─────────────────────────────────────────

interface StreamCursor {
  connection: string;
  cursor: number;
}

interface WatcherState {
  alias: string;
  pollTimer: ReturnType<typeof setTimeout> | null;
  /** Set by stopWatcherForAlias so an in-flight call can't reschedule. */
  stopped: boolean;
  mode: "wait" | "legacy";
  /** Legacy mode: when to try wait_for_events again. */
  nextProbeAt: number;
  /**
   * Legacy mode: per-connection cursors. Event IDs are per-ingestor (not
   * global), so each connection needs its own cursor to avoid one
   * high-volume source advancing the cursor past another source's events.
   */
  cursors: Map<string, number>;
  /**
   * Wait mode: per-stream cursors keyed `${connection}:${instanceId}`. IDs are
   * per ingestor *instance*, so even one connection's instances can't share.
   */
  streamCursors: Map<string, StreamCursor>;
  currentBackoff: number;
  consecutiveFailures: number;
}

const watchers = new Map<string, WatcherState>();

// ── Public API ──────────────────────────────────────────────────────

/**
 * Initialize event watchers for all agents that have an mcpKeyAlias.
 * Collects unique aliases and starts one watcher per alias.
 */
export function initEventWatchers(): void {
  const agents = listAgents();
  const aliases = new Set<string>();

  for (const agent of agents) {
    const resolved = resolveAgentKeyAlias(agent);
    if (resolved.mcpKeyAlias) {
      aliases.add(resolved.mcpKeyAlias);
    }
  }

  if (aliases.size === 0) {
    log.info("No agents with mcpKeyAlias found — no event watchers started");
    return;
  }

  log.info(`Starting event watchers for ${aliases.size} alias(es): ${[...aliases].join(", ")}`);

  for (const alias of aliases) {
    startWatcherForAlias(alias);
  }
}

/**
 * Graceful shutdown: stop all watchers.
 */
export function shutdownEventWatchers(): void {
  for (const alias of [...watchers.keys()]) {
    stopWatcherForAlias(alias);
  }
  log.info("All event watchers shut down");
}

/**
 * Start (or restart) a watcher for a specific alias.
 */
export function startWatcherForAlias(alias: string): void {
  // Stop existing watcher if running
  stopWatcherForAlias(alias);

  const client = getProxy(alias);
  if (!client) {
    log.info(`Event watcher not started for alias "${alias}" — proxy unavailable`);
    return;
  }

  const state: WatcherState = {
    alias,
    pollTimer: null,
    stopped: false,
    mode: "wait",
    nextProbeAt: 0,
    cursors: new Map(),
    streamCursors: new Map(),
    currentBackoff: BASE_POLL_INTERVAL,
    consecutiveFailures: 0,
  };

  watchers.set(alias, state);
  schedulePoll(state);
  log.info(`Event watcher started for alias "${alias}" — interval=${BASE_POLL_INTERVAL}ms`);
}

/**
 * Stop a watcher for a specific alias.
 */
export function stopWatcherForAlias(alias: string): void {
  const state = watchers.get(alias);
  if (!state) return;

  // A wait_for_events call may be in flight; it can't be cancelled, but this
  // makes it drop its reply and not schedule another cycle.
  state.stopped = true;
  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  watchers.delete(alias);
  log.info(`Event watcher stopped for alias "${alias}"`);
}

// ── Internal ────────────────────────────────────────────────────────

/**
 * Schedule the next cycle for a watcher. Defaults to the current backoff;
 * wait mode passes 0 to re-issue straight after a reply.
 */
function schedulePoll(state: WatcherState, delay: number = state.currentBackoff): void {
  if (state.stopped) return;
  state.pollTimer = setTimeout(() => pollLoop(state), delay);
}

/** drawlatch's /request handler throws exactly this for a tool it doesn't have. */
function isWaitUnsupported(err: unknown): boolean {
  return err instanceof Error && err.message === "Unknown tool: wait_for_events";
}

/**
 * Store each event in its per-connection log and dispatch to triggers.
 * appendEvent() returns null for duplicates (same idempotency key),
 * so we only dispatch events that were actually stored.
 */
function ingestEvents(state: WatcherState, label: string, events: IngestedEvent[]): void {
  for (const event of events) {
    const stored = appendEvent({
      id: event.id,
      idempotencyKey: event.idempotencyKey,
      receivedAt: event.receivedAt,
      receivedAtMs: event.receivedAtMs,
      callerAlias: state.alias,
      source: event.source,
      instanceId: event.instanceId,
      eventType: event.eventType,
      data: event.data,
    });

    if (stored) {
      log.debug(`[${state.alias}/${label}] Stored ${event.source}:${event.eventType} (event ${event.id})`);
      // Dispatch to trigger system (matching is sync, execution is async)
      dispatchEvent(stored);
    }
  }
}

/**
 * Poll a single connection and process its events.
 * Each connection has its own cursor since event IDs are per-ingestor.
 */
async function pollConnection(state: WatcherState, proxyClient: ProxyLike, connection: string): Promise<void> {
  const cursor = state.cursors.get(connection) ?? -1;

  const result = (await proxyClient.callTool("poll_events", {
    after_id: cursor,
    connection,
  })) as IngestedEvent[] | { events?: IngestedEvent[] };

  if (state.stopped) return;

  // poll_events may return an array directly or wrapped in { events: [] }
  const events: IngestedEvent[] = Array.isArray(result) ? result : result?.events || [];

  if (events.length === 0) return;

  log.debug(`[${state.alias}/${connection}] Received ${events.length} events`);

  // Update per-connection cursor to the max event ID
  const maxId = Math.max(...events.map((e) => e.id));
  if (maxId > cursor) state.cursors.set(connection, maxId);

  ingestEvents(state, connection, events);
}

/**
 * One legacy cycle: discover active connections via ingestor_status, then
 * poll each connection independently in parallel. This ensures per-ingestor
 * event IDs don't interfere across connections — a high-volume source
 * (e.g. Discord) won't advance the cursor past a lower-volume source
 * (e.g. Slack).
 */
async function legacyCycle(state: WatcherState, proxyClient: ProxyLike): Promise<void> {
  const statusResult = await proxyClient.callTool("ingestor_status");
  if (state.stopped) return;
  const ingestors: IngestorStatusEntry[] = Array.isArray(statusResult) ? statusResult : [];

  // Poll each connection in parallel, each with its own cursor.
  // Individual connection failures are logged but don't fail the whole cycle.
  const results = await Promise.allSettled(ingestors.map((ingestor) => pollConnection(state, proxyClient, ingestor.connection)));

  for (const result of results) {
    if (result.status === "rejected") {
      log.warn(`[${state.alias}] Per-connection poll failed: ${result.reason?.message || result.reason}`);
    }
  }
}

/**
 * One wait cycle: a single wait_for_events covering every known stream. The
 * reply lists every active stream, so streams the watcher hasn't seen yet are
 * picked up here — at the cursor the hub returned, since the reply already
 * carries their events.
 */
async function waitCycle(state: WatcherState, proxyClient: ProxyLike): Promise<void> {
  const cursors: Record<string, number> = {};
  for (const [key, s] of state.streamCursors) cursors[key] = s.cursor;

  const result = (await proxyClient.callTool("wait_for_events", {
    cursors,
    timeout_ms: WAIT_TIMEOUT_MS,
  })) as WaitForEventsResult;

  // Stopped while the hub held the request: drop the reply. A restarted
  // watcher starts from fresh cursors and gets these events again.
  if (state.stopped) return;

  if (!result || typeof result.streams !== "object" || result.streams === null) {
    throw new Error("Malformed wait_for_events reply (no streams)");
  }

  for (const [key, stream] of Object.entries(result.streams)) {
    const events = Array.isArray(stream.events) ? stream.events : [];
    const prev = state.streamCursors.get(key)?.cursor ?? -1;
    const returned = Number.isFinite(stream.cursor) ? stream.cursor : Math.max(-1, ...events.map((e) => e.id));
    state.streamCursors.set(key, { connection: stream.connection, cursor: Math.max(prev, returned) });

    if (events.length > 0) {
      log.debug(`[${state.alias}/${key}] Received ${events.length} events`);
      ingestEvents(state, key, events);
    }
  }

  if (result.unknownStreams?.length) {
    log.debug(`[${state.alias}] Hub reports inactive streams: ${result.unknownStreams.join(", ")}`);
  }
}

/**
 * Enter legacy mode. Carry stream cursors over as per-connection cursors (the
 * legacy loop polls every instance of a connection with one cursor, so it takes
 * the max), so the switch doesn't re-deliver what wait mode already handled.
 */
function enterLegacyMode(state: WatcherState): void {
  state.mode = "legacy";
  state.nextProbeAt = Date.now() + WAIT_REPROBE_INTERVAL;
  for (const { connection, cursor } of state.streamCursors.values()) {
    if (cursor > (state.cursors.get(connection) ?? -1)) state.cursors.set(connection, cursor);
  }
  log.info(`[${state.alias}] Hub has no wait_for_events — using legacy polling, re-probing in ${WAIT_REPROBE_INTERVAL / 60_000} min`);
}

/**
 * Leave legacy mode to probe wait_for_events. A single-instance connection's
 * legacy cursor is exactly its `_default` stream's cursor, so seed those;
 * instances of multi-instance connections start at whatever wait mode last
 * knew (or the hub's default), and appendEvent dedupes any overlap.
 */
function enterWaitMode(state: WatcherState): void {
  state.mode = "wait";
  for (const [connection, cursor] of state.cursors) {
    const key = `${connection}:${DEFAULT_INSTANCE_ID}`;
    if (cursor > (state.streamCursors.get(key)?.cursor ?? -1)) state.streamCursors.set(key, { connection, cursor });
  }
  log.info(`[${state.alias}] Re-probing for wait_for_events`);
}

/**
 * The main loop for one alias: one wait_for_events (re-issued immediately on
 * success) or one legacy poll cycle, with exponential backoff on failure.
 */
async function pollLoop(state: WatcherState): Promise<void> {
  state.pollTimer = null;
  if (state.stopped) return;

  let nextDelay: number;
  try {
    const proxyClient = getProxy(state.alias);
    if (!proxyClient) return;

    if (state.mode === "legacy" && Date.now() >= state.nextProbeAt) {
      enterWaitMode(state);
    }

    if (state.mode === "wait") {
      try {
        await waitCycle(state, proxyClient);
      } catch (err) {
        if (!isWaitUnsupported(err) || state.stopped) throw err;
        enterLegacyMode(state);
      }
    }

    if (state.mode === "legacy") {
      await legacyCycle(state, proxyClient);
    }

    // Reset backoff on success
    state.consecutiveFailures = 0;
    state.currentBackoff = BASE_POLL_INTERVAL;
    nextDelay = state.mode === "wait" ? 0 : BASE_POLL_INTERVAL;
  } catch (err: any) {
    if (state.stopped) return;
    state.consecutiveFailures++;
    state.currentBackoff = Math.min(BASE_POLL_INTERVAL * Math.pow(2, state.consecutiveFailures), MAX_BACKOFF);
    nextDelay = state.currentBackoff;
    log.warn(`[${state.alias}] Event poll failed (attempt ${state.consecutiveFailures}, next in ${state.currentBackoff}ms): ${err.message}`);

    // Auto-reset session on auth failure
    if (err.message?.includes("401") || err.message?.includes("Session expired")) {
      log.info(`[${state.alias}] Resetting proxy client for rehandshake...`);
      resetClient(state.alias);
    }
  }

  // Schedule next cycle (always, even after failure — unless stopped)
  schedulePoll(state, nextDelay);
}
