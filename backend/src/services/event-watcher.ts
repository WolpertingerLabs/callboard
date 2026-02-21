/**
 * Event watcher.
 *
 * Polls mcp-secure-proxy's remote server for new events via the encrypted
 * HTTP wire protocol and wakes agents with matching event subscriptions.
 *
 * The agent itself decides how to respond — no hardcoded conditions or actions.
 *
 * Configuration via environment variables:
 *   EVENT_WATCHER_ENABLED       — "true" to enable (default: "false")
 *   EVENT_WATCHER_KEYS_DIR      — path to own keypair (default: ~/.mcp-secure-proxy/keys/local)
 *   EVENT_WATCHER_REMOTE_KEYS_DIR — path to remote server public keys
 *   EVENT_WATCHER_REMOTE_URL    — remote server URL (default: http://127.0.0.1:9999)
 *   EVENT_WATCHER_POLL_INTERVAL — poll interval in ms (default: 5000)
 */
import { listAgents } from "./agent-file-service.js";
import { executeAgent } from "./agent-executor.js";
import { appendActivity } from "./agent-activity.js";
import { getSharedProxyClient } from "./proxy-singleton.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("event-watcher");

// ── Configuration ───────────────────────────────────────────────────

const ENABLED = process.env.EVENT_WATCHER_ENABLED === "true";
const BASE_POLL_INTERVAL = parseInt(process.env.EVENT_WATCHER_POLL_INTERVAL || "5000", 10);
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
 * Only starts if EVENT_WATCHER_ENABLED=true.
 */
export function initEventWatcher(): void {
  if (!ENABLED) {
    log.info("Event watcher disabled (set EVENT_WATCHER_ENABLED=true to enable)");
    return;
  }

  log.info(`Initializing event watcher — interval=${BASE_POLL_INTERVAL}ms`);

  const client = getSharedProxyClient();
  if (!client) {
    log.error("Event watcher cannot start — proxy client unavailable (keys missing?)");
    return;
  }

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

      // Load all agents once per poll cycle (cheap for small agent counts)
      const agents = listAgents();

      // For each event, find agents with matching subscriptions
      for (const event of events) {
        const matchingAgents = agents.filter((agent) => agent.eventSubscriptions?.some((sub) => sub.connectionAlias === event.source && sub.enabled));

        // Fire-and-forget: don't block the poll loop waiting for agent execution
        for (const agent of matchingAgents) {
          log.info(`Waking agent ${agent.alias} for ${event.source}:${event.eventType} (event ${event.id})`);

          // Log event arrival to activity (independent of session outcome)
          appendActivity(agent.alias, {
            type: "event",
            message: `${event.source}:${event.eventType} — event ${event.id}`,
            metadata: {
              eventId: event.id,
              eventSource: event.source,
              eventType: event.eventType,
              receivedAt: event.receivedAt,
              eventData: typeof event.data === "string" ? event.data.slice(0, 500) : JSON.stringify(event.data).slice(0, 500),
            },
          });

          const eventPrompt = buildEventPrompt(event);

          executeAgent({
            agentAlias: agent.alias,
            prompt: eventPrompt,
            triggeredBy: "event",
            metadata: {
              eventId: event.id,
              eventSource: event.source,
              eventType: event.eventType,
              receivedAt: event.receivedAt,
            },
          }).catch((err) => {
            log.error(`Failed to execute agent ${agent.alias} for event ${event.id}: ${err.message}`);
          });
        }
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

/**
 * Build a prompt string from an ingested event.
 */
function buildEventPrompt(event: IngestedEvent): string {
  const dataStr = typeof event.data === "string" ? event.data : JSON.stringify(event.data, null, 2);

  return [
    `An event arrived from the "${event.source}" connection.`,
    `Event type: ${event.eventType}`,
    `Event ID: ${event.id}`,
    `Received at: ${event.receivedAt}`,
    "",
    "Event data:",
    "```json",
    dataStr,
    "```",
    "",
    "Review this event and respond appropriately based on your guidelines.",
    "If this event doesn't require action, reply EVENT_NOTED.",
  ].join("\n");
}
