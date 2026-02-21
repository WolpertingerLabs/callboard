/**
 * Per-connection event log.
 *
 * Events from mcp-secure-proxy ingestors are stored in append-only JSONL files
 * keyed by connection alias (the proxy route name). Each connection alias maps
 * to an API key / IAM-like profile in the proxy config.
 *
 * Storage layout:
 *   data/events/{connectionAlias}/events.jsonl
 *
 * Each line is a JSON object with the raw event data plus a local write timestamp.
 */
import { appendFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("event-log");
const EVENTS_DIR = join(DATA_DIR, "events");

// ── Idempotency dedup ───────────────────────────────────────────────────
//
// Bounded in-memory set of recently-seen idempotency keys.
// Seeded lazily from existing JSONL files on first appendEvent() call,
// then maintained as events are ingested. Prevents storing duplicates
// caused by webhook retries, reconnection replays, or proxy restarts.

/** Max keys to hold in memory. When exceeded the oldest half is pruned. */
const MAX_SEEN_KEYS = 5000;

/** Number of tail lines to read per JSONL file when seeding the set. */
const SEED_TAIL_LINES = 500;

const seenKeys = new Set<string>();
let seeded = false;

/**
 * Seed the seenKeys set from the tail of every existing JSONL file.
 * Called once, lazily, on the first appendEvent() invocation.
 */
function seedSeenKeys(): void {
  if (seeded) return;
  seeded = true;

  if (!existsSync(EVENTS_DIR)) return;

  const sources = readdirSync(EVENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let total = 0;
  for (const source of sources) {
    const path = eventsPath(source);
    if (!existsSync(path)) continue;

    const raw = readFileSync(path, "utf8").trim();
    if (!raw) continue;

    const lines = raw.split("\n");
    // Only read the most recent N lines to stay bounded
    const tail = lines.slice(-SEED_TAIL_LINES);
    for (const line of tail) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as StoredEvent;
        if (entry.idempotencyKey) {
          seenKeys.add(entry.idempotencyKey);
          total++;
        }
      } catch {
        // skip malformed
      }
    }
  }

  if (total > 0) {
    log.info(`Seeded dedup set with ${total} idempotency keys from existing event logs`);
  }
}

/**
 * Prune the seen-keys set when it exceeds MAX_SEEN_KEYS.
 * Removes the oldest half (Set preserves insertion order).
 */
function pruneSeenKeys(): void {
  const pruneCount = Math.floor(seenKeys.size / 2);
  let removed = 0;
  for (const key of seenKeys) {
    if (removed >= pruneCount) break;
    seenKeys.delete(key);
    removed++;
  }
}

export interface StoredEvent {
  /** Monotonically increasing ID from the ingestor */
  id: number;
  /**
   * Idempotency key for deduplication.
   * Derived from service-specific unique identifiers when available
   * (e.g., GitHub delivery ID, Stripe event ID, Slack envelope ID).
   * Falls back to `${source}:${id}` for services without natural keys.
   */
  idempotencyKey: string;
  /** ISO-8601 timestamp from the proxy */
  receivedAt: string;
  /** Unix timestamp (ms) when the event was received by the ingestor */
  receivedAtMs: number;
  /** Connection alias / route name (e.g. "discord-bot", "github") */
  source: string;
  /** Source-specific event type (e.g. "MESSAGE_CREATE", "push") */
  eventType: string;
  /** Raw payload from external service */
  data: unknown;
  /** Local write timestamp (epoch ms) */
  storedAt: number;
}

function connectionDir(source: string): string {
  return join(EVENTS_DIR, source);
}

function eventsPath(source: string): string {
  return join(connectionDir(source), "events.jsonl");
}

function ensureConnectionDir(source: string): void {
  const dir = connectionDir(source);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Append an event to the connection's log file.
 *
 * Returns the stored event on success, or `null` if the event was a
 * duplicate (same idempotency key already seen).
 */
export function appendEvent(event: {
  id: number;
  idempotencyKey: string;
  receivedAt: string;
  receivedAtMs: number;
  source: string;
  eventType: string;
  data: unknown;
}): StoredEvent | null {
  // Lazy-seed the dedup set from existing logs on first call
  seedSeenKeys();

  // Deduplicate by idempotency key
  if (seenKeys.has(event.idempotencyKey)) {
    log.debug(
      `Duplicate event skipped: ${event.source}:${event.eventType} (key: ${event.idempotencyKey})`,
    );
    return null;
  }

  ensureConnectionDir(event.source);
  const stored: StoredEvent = {
    ...event,
    storedAt: Date.now(),
  };
  appendFileSync(eventsPath(event.source), JSON.stringify(stored) + "\n");

  // Track for future dedup
  seenKeys.add(event.idempotencyKey);
  if (seenKeys.size > MAX_SEEN_KEYS) {
    pruneSeenKeys();
  }

  return stored;
}

export interface GetEventsOptions {
  limit?: number;
  offset?: number;
}

/**
 * Read events for a specific connection, newest first.
 */
export function getEvents(source: string, opts: GetEventsOptions = {}): StoredEvent[] {
  const path = eventsPath(source);
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];

  const lines = raw.split("\n");
  const entries: StoredEvent[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as StoredEvent);
    } catch {
      // Skip malformed lines
    }
  }

  // Sort newest first
  entries.sort((a, b) => b.storedAt - a.storedAt);

  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  return entries.slice(offset, offset + limit);
}

/**
 * Get events across all connections, newest first.
 */
export function getAllEvents(opts: GetEventsOptions = {}): StoredEvent[] {
  if (!existsSync(EVENTS_DIR)) return [];

  const sources = readdirSync(EVENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const all: StoredEvent[] = [];
  for (const source of sources) {
    // Read all from each source (we'll sort + paginate after merging)
    all.push(...getEvents(source, { limit: 10000 }));
  }

  // Sort newest first across all sources
  all.sort((a, b) => b.storedAt - a.storedAt);

  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  return all.slice(offset, offset + limit);
}

/**
 * List all connection aliases that have stored events.
 */
export function listEventSources(): string[] {
  if (!existsSync(EVENTS_DIR)) return [];

  return readdirSync(EVENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}
