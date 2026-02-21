/**
 * Event watcher.
 *
 * Polls mcp-secure-proxy for new events every few seconds and persists them
 * to per-connection JSONL logs. Events are stored by connection alias (the
 * proxy route name), which maps to API key / IAM-like profiles.
 *
 * This is a pure ingest loop — no agent matching or subscription filtering.
 * All events from all ingestors are captured unconditionally.
 *
 * Configuration via environment variables:
 *   EVENT_WATCHER_POLL_INTERVAL — poll interval in ms (default: 3000)
 */
import { appendEvent } from "./event-log.js";
import { dispatchEvent } from "./trigger-dispatcher.js";
import { getSharedProxyClient } from "./proxy-singleton.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("event-watcher");

// ── Configuration ───────────────────────────────────────────────────

const BASE_POLL_INTERVAL = parseInt(process.env.EVENT_WATCHER_POLL_INTERVAL || "3000", 10);
const MAX_BACKOFF = 60_000; // 60 seconds

// ── Event shape from mcp-secure-proxy's poll_events ─────────────────

interface IngestedEvent {
  id: number; // Monotonically increasing per ingestor
  receivedAt: string; // ISO-8601 timestamp
  source: string; // Connection alias (e.g., "discord-bot", "github")
  eventType: string; // Source-specific type (e.g., "MESSAGE_CREATE", "push")
  data: unknown; // Raw payload from external service
}

// ── State ───────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let afterId = -1; // Cursor: fetch events with id > afterId
let currentBackoff = BASE_POLL_INTERVAL;
let consecutiveFailures = 0;

// ── Public API ──────────────────────────────────────────────────────

/**
 * Initialize the event watcher.
 * Starts automatically if the proxy is configured (keys exist).
 */
export function initEventWatcher(): void {
  const client = getSharedProxyClient();
  if (!client) {
    log.info("Event watcher not started — proxy client unavailable (keys missing?)");
    return;
  }

  log.info(`Starting event watcher — interval=${BASE_POLL_INTERVAL}ms`);
  schedulePoll();
  log.info("Event watcher started");
}

/**
 * Graceful shutdown: stop polling.
 */
export function shutdownEventWatcher(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  log.info("Event watcher shut down");
}

// ── Internal ────────────────────────────────────────────────────────

/**
 * Schedule the next poll with the current backoff interval.
 */
function schedulePoll(): void {
  pollTimer = setTimeout(pollLoop, currentBackoff);
}

/**
 * The main polling loop.
 */
async function pollLoop(): Promise<void> {
  try {
    const proxyClient = getSharedProxyClient();
    if (!proxyClient) return;

    // Call poll_events via the encrypted channel
    const result = (await proxyClient.callTool("poll_events", {
      after_id: afterId,
    })) as IngestedEvent[] | { events?: IngestedEvent[] };

    // poll_events may return an array directly or wrapped in { events: [] }
    const events: IngestedEvent[] = Array.isArray(result) ? result : result?.events || [];

    if (events.length > 0) {
      log.debug(`Received ${events.length} events`);

      // Update cursor to the max event ID
      const maxId = Math.max(...events.map((e) => e.id));
      if (maxId > afterId) afterId = maxId;

      // Store each event in its per-connection log and dispatch to triggers
      for (const event of events) {
        const stored = appendEvent({
          id: event.id,
          receivedAt: event.receivedAt,
          source: event.source,
          eventType: event.eventType,
          data: event.data,
        });
        log.debug(`Stored ${event.source}:${event.eventType} (event ${event.id})`);

        // Dispatch to trigger system (matching is sync, execution is async)
        dispatchEvent(stored);
      }
    }

    // Reset backoff on success
    consecutiveFailures = 0;
    currentBackoff = BASE_POLL_INTERVAL;
  } catch (err: any) {
    consecutiveFailures++;
    currentBackoff = Math.min(BASE_POLL_INTERVAL * Math.pow(2, consecutiveFailures), MAX_BACKOFF);
    log.warn(`Event poll failed (attempt ${consecutiveFailures}, next in ${currentBackoff}ms): ${err.message}`);

    // Auto-reset session on auth failure
    if (err.message?.includes("401") || err.message?.includes("Session expired")) {
      log.info("Resetting proxy client for rehandshake...");
      getSharedProxyClient()?.reset();
    }
  }

  // Schedule next poll (always, even after failure)
  schedulePoll();
}
