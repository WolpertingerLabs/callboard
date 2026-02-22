/**
 * Per-alias event watchers.
 *
 * Each mcp-secure-proxy key alias gets its own independent polling loop.
 * On startup, all agents are scanned for unique mcpKeyAlias values and a
 * watcher is started for each. Events are stored in the shared event log
 * and dispatched to the trigger system as before.
 *
 * Configuration via environment variables:
 *   EVENT_WATCHER_POLL_INTERVAL — poll interval in ms (default: 3000)
 */
import { appendEvent } from "./event-log.js";
import { dispatchEvent } from "./trigger-dispatcher.js";
import { getProxyClient, resetClient } from "./proxy-singleton.js";
import { listAgents } from "./agent-file-service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("event-watcher");

// ── Configuration ───────────────────────────────────────────────────

const BASE_POLL_INTERVAL = parseInt(process.env.EVENT_WATCHER_POLL_INTERVAL || "3000", 10);
const MAX_BACKOFF = 60_000; // 60 seconds

// ── Event shape from mcp-secure-proxy's poll_events ─────────────────

interface IngestedEvent {
  id: number; // Monotonically increasing per ingestor
  idempotencyKey?: string; // Service-specific unique key for deduplication
  receivedAt: string; // ISO-8601 timestamp
  receivedAtMs?: number; // Unix timestamp (ms) when received by ingestor
  source: string; // Connection alias (e.g., "discord-bot", "github")
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

// ── Per-alias watcher state ─────────────────────────────────────────

interface WatcherState {
  alias: string;
  pollTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Per-connection cursors. Event IDs are per-ingestor (not global),
   * so each connection needs its own cursor to avoid one high-volume
   * source advancing the cursor past another source's events.
   */
  cursors: Map<string, number>;
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
    if (agent.mcpKeyAlias) {
      aliases.add(agent.mcpKeyAlias);
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
  for (const [alias, state] of watchers) {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    log.info(`Event watcher stopped for alias "${alias}"`);
  }
  watchers.clear();
  log.info("All event watchers shut down");
}

/**
 * Start (or restart) a watcher for a specific alias.
 */
export function startWatcherForAlias(alias: string): void {
  // Stop existing watcher if running
  stopWatcherForAlias(alias);

  const client = getProxyClient(alias);
  if (!client) {
    log.info(`Event watcher not started for alias "${alias}" — proxy client unavailable`);
    return;
  }

  const state: WatcherState = {
    alias,
    pollTimer: null,
    cursors: new Map(),
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

  if (state.pollTimer) {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }
  watchers.delete(alias);
  log.info(`Event watcher stopped for alias "${alias}"`);
}

// ── Internal ────────────────────────────────────────────────────────

/**
 * Schedule the next poll for a watcher.
 */
function schedulePoll(state: WatcherState): void {
  state.pollTimer = setTimeout(() => pollLoop(state), state.currentBackoff);
}

/**
 * Poll a single connection and process its events.
 * Each connection has its own cursor since event IDs are per-ingestor.
 */
async function pollConnection(state: WatcherState, proxyClient: ReturnType<typeof getProxyClient> & object, connection: string): Promise<void> {
  const cursor = state.cursors.get(connection) ?? -1;

  const result = (await proxyClient.callTool("poll_events", {
    after_id: cursor,
    connection,
  })) as IngestedEvent[] | { events?: IngestedEvent[] };

  // poll_events may return an array directly or wrapped in { events: [] }
  const events: IngestedEvent[] = Array.isArray(result) ? result : result?.events || [];

  if (events.length === 0) return;

  log.debug(`[${state.alias}/${connection}] Received ${events.length} events`);

  // Update per-connection cursor to the max event ID
  const maxId = Math.max(...events.map((e) => e.id));
  if (maxId > cursor) state.cursors.set(connection, maxId);

  // Store each event in its per-connection log and dispatch to triggers.
  // appendEvent() returns null for duplicates (same idempotency key),
  // so we only dispatch events that were actually stored.
  for (const event of events) {
    const stored = appendEvent({
      id: event.id,
      idempotencyKey: event.idempotencyKey,
      receivedAt: event.receivedAt,
      receivedAtMs: event.receivedAtMs,
      source: event.source,
      eventType: event.eventType,
      data: event.data,
    });

    if (stored) {
      log.debug(`[${state.alias}/${connection}] Stored ${event.source}:${event.eventType} (event ${event.id})`);
      // Dispatch to trigger system (matching is sync, execution is async)
      dispatchEvent(stored);
    }
  }
}

/**
 * The main polling loop for one alias.
 *
 * Discovers active connections via ingestor_status, then polls each
 * connection independently in parallel. This ensures per-ingestor
 * event IDs don't interfere across connections — a high-volume source
 * (e.g. Discord) won't advance the cursor past a lower-volume source
 * (e.g. Slack).
 */
async function pollLoop(state: WatcherState): Promise<void> {
  try {
    const proxyClient = getProxyClient(state.alias);
    if (!proxyClient) return;

    // Discover active connections via ingestor_status
    const statusResult = await proxyClient.callTool("ingestor_status");
    const ingestors: IngestorStatusEntry[] = Array.isArray(statusResult) ? statusResult : [];

    if (ingestors.length === 0) {
      state.consecutiveFailures = 0;
      state.currentBackoff = BASE_POLL_INTERVAL;
      schedulePoll(state);
      return;
    }

    // Poll each connection in parallel, each with its own cursor.
    // Individual connection failures are logged but don't fail the whole cycle.
    const results = await Promise.allSettled(ingestors.map((ingestor) => pollConnection(state, proxyClient, ingestor.connection)));

    for (const result of results) {
      if (result.status === "rejected") {
        log.warn(`[${state.alias}] Per-connection poll failed: ${result.reason?.message || result.reason}`);
      }
    }

    // Reset backoff on success
    state.consecutiveFailures = 0;
    state.currentBackoff = BASE_POLL_INTERVAL;
  } catch (err: any) {
    state.consecutiveFailures++;
    state.currentBackoff = Math.min(BASE_POLL_INTERVAL * Math.pow(2, state.consecutiveFailures), MAX_BACKOFF);
    log.warn(`[${state.alias}] Event poll failed (attempt ${state.consecutiveFailures}, next in ${state.currentBackoff}ms): ${err.message}`);

    // Auto-reset session on auth failure
    if (err.message?.includes("401") || err.message?.includes("Session expired")) {
      log.info(`[${state.alias}] Resetting proxy client for rehandshake...`);
      resetClient(state.alias);
    }
  }

  // Schedule next poll (always, even after failure)
  schedulePoll(state);
}
