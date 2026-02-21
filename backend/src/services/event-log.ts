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

const EVENTS_DIR = join(DATA_DIR, "events");

export interface StoredEvent {
  /** Monotonically increasing ID from the ingestor */
  id: number;
  /** ISO-8601 timestamp from the proxy */
  receivedAt: string;
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
 */
export function appendEvent(event: {
  id: number;
  receivedAt: string;
  source: string;
  eventType: string;
  data: unknown;
}): StoredEvent {
  ensureConnectionDir(event.source);
  const stored: StoredEvent = {
    ...event,
    storedAt: Date.now(),
  };
  appendFileSync(eventsPath(event.source), JSON.stringify(stored) + "\n");
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
