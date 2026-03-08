/**
 * Per-caller, per-connection event log.
 *
 * Events from drawlatch ingestors are stored in append-only JSONL files
 * keyed by caller alias and connection alias.
 *
 * Storage layout:
 *   data/events/{callerAlias}/{connectionAlias}/events.jsonl
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

  // Walk two-level directory: {callerAlias}/{source}/events.jsonl
  const callerDirs = readdirSync(EVENTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let total = 0;
  for (const caller of callerDirs) {
    const callerPath = join(EVENTS_DIR, caller);
    const sourceDirs = readdirSync(callerPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    for (const source of sourceDirs) {
      const path = eventsPath(caller, source);
      if (!existsSync(path)) continue;

      const raw = readFileSync(path, "utf8").trim();
      if (!raw) continue;

      const lines = raw.split("\n");
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
  idempotencyKey?: string;
  /** ISO-8601 timestamp from the proxy */
  receivedAt: string;
  /** Unix timestamp (ms) when the event was received by the ingestor */
  receivedAtMs?: number;
  /** Caller alias that owns this event (e.g. "default", "alice") */
  callerAlias: string;
  /** Connection alias / route name (e.g. "discord-bot", "github") */
  source: string;
  /** Instance ID for multi-instance listeners (e.g. "project-board").
   *  Omitted for single-instance connections. */
  instanceId?: string;
  /** Source-specific event type (e.g. "MESSAGE_CREATE", "push") */
  eventType: string;
  /** Raw payload from external service */
  data: unknown;
  /** Local write timestamp (epoch ms) */
  storedAt: number;
}

function connectionDir(callerAlias: string, source: string): string {
  return join(EVENTS_DIR, callerAlias, source);
}

function eventsPath(callerAlias: string, source: string): string {
  return join(connectionDir(callerAlias, source), "events.jsonl");
}

function ensureConnectionDir(callerAlias: string, source: string): void {
  const dir = connectionDir(callerAlias, source);
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
  idempotencyKey?: string;
  receivedAt: string;
  receivedAtMs?: number;
  callerAlias: string;
  source: string;
  instanceId?: string;
  eventType: string;
  data: unknown;
}): StoredEvent | null {
  // Lazy-seed the dedup set from existing logs on first call
  seedSeenKeys();

  // Deduplicate by idempotency key (only when present and non-empty).
  // Events without a meaningful key (undefined, empty, or falsy) are
  // always stored — we can't deduplicate without a stable identifier.
  const key = event.idempotencyKey;
  if (key && seenKeys.has(key)) {
    log.debug(`Duplicate event skipped: ${event.source}:${event.eventType} (key: ${key})`);
    return null;
  }

  ensureConnectionDir(event.callerAlias, event.source);
  const stored: StoredEvent = {
    ...event,
    storedAt: Date.now(),
  };
  appendFileSync(eventsPath(event.callerAlias, event.source), JSON.stringify(stored) + "\n");

  // Track for future dedup (only meaningful keys)
  if (key) {
    seenKeys.add(key);
    if (seenKeys.size > MAX_SEEN_KEYS) {
      pruneSeenKeys();
    }
  }

  return stored;
}

export interface GetEventsOptions {
  limit?: number;
  offset?: number;
  /** Filter by instance ID (multi-instance listeners only) */
  instanceId?: string;
}

/**
 * Read events for a specific caller + connection, newest first.
 */
export function getEvents(callerAlias: string, source: string, opts: GetEventsOptions = {}): StoredEvent[] {
  const path = eventsPath(callerAlias, source);
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

  // Filter by instanceId if specified
  const filtered = opts.instanceId ? entries.filter((e) => e.instanceId === opts.instanceId) : entries;

  // Sort newest first
  filtered.sort((a, b) => b.storedAt - a.storedAt);

  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  return filtered.slice(offset, offset + limit);
}

/**
 * Get events across all connections for a specific caller, newest first.
 */
export function getAllEvents(callerAlias: string, opts: GetEventsOptions = {}): StoredEvent[] {
  const callerDir = join(EVENTS_DIR, callerAlias);
  if (!existsSync(callerDir)) return [];

  const sources = readdirSync(callerDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const all: StoredEvent[] = [];
  for (const source of sources) {
    // Read all from each source (we'll sort + paginate after merging)
    all.push(...getEvents(callerAlias, source, { limit: 10000 }));
  }

  // Sort newest first across all sources
  all.sort((a, b) => b.storedAt - a.storedAt);

  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? 100;
  return all.slice(offset, offset + limit);
}

/**
 * List all connection aliases that have stored events for a specific caller.
 */
export function listEventSources(callerAlias: string): string[] {
  const callerDir = join(EVENTS_DIR, callerAlias);
  if (!existsSync(callerDir)) return [];

  return readdirSync(callerDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}
