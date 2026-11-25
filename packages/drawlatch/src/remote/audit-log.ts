/**
 * `ingest_logs` — an append-only audit log that callers ship records into.
 *
 * The input mirrors OTLP's `ExportLogsServiceRequest` (JSON encoding) and the
 * response mirrors `ExportLogsServiceResponse`, but it rides the encrypted,
 * caller-authenticated drawlatch protocol rather than an OTLP endpoint.
 *
 * Each accepted record becomes one flattened JSON line in
 * `<config dir>/audit/<caller>/<YYYY-MM-DD>.jsonl` (UTC day of receipt).
 * Files are 0600 and directories 0700. drawlatch stamps every line with the
 * authenticated caller, the receive time, a per-file sequence number, and
 * `drawlatch.source` (`client` for caller records, `daemon` for lines the
 * daemon writes itself); the payload cannot set or override them.
 *
 * Validation follows OTLP/JSON's "ignore unknown fields" rule without losing
 * data: unknown fields are kept under `extra`, and known fields with invalid
 * values are kept under `invalid`, both bounded. Such records are stored and
 * reported as warnings in `partialSuccess` with nothing counted as rejected.
 * A record is rejected only when it is unusable (not an object, unreachable
 * under a malformed container) or over a size limit. Oversized values are
 * truncated and the line marked `truncated: true`.
 *
 * Each caller has a byte budget that refills over time. When it refuses
 * records, the daemon writes a `quota_exceeded` line from separate headroom,
 * at most one per caller per QUOTA_MARKER_INTERVAL_MS, so a flood leaves
 * evidence on the hub rather than a silent gap.
 *
 * The daemon appends its own events (vault reveals and item changes) with
 * appendDaemonEvent(), stamped `drawlatch.source: daemon`.
 *
 * There is deliberately no read, list, update, or delete path here. Callers
 * can append, nothing else; reading happens on the hub box.
 */

import fs from 'node:fs';
import path from 'node:path';

import { getConfigDir } from '../shared/config.js';
import { createLogger } from '../shared/logger.js';
import { CALLER_ALIAS_REGEX } from './caller-bootstrap.js';

const log = createLogger('audit-log');

// ── Limits ─────────────────────────────────────────────────────────────────

/** Records past this count in one call are rejected. */
export const MAX_RECORDS_PER_CALL = 1000;
/** Stored bytes per call. Records that would push past it are rejected. */
export const MAX_BYTES_PER_CALL = 4 * 1024 * 1024;
/** One stored line, after truncation. Larger records are rejected. */
export const MAX_RECORD_BYTES = 256 * 1024;
/** String values longer than this are cut and suffixed with TRUNCATION_MARKER. */
export const MAX_STRING_CHARS = 16 * 1024;
/** Attributes per list, and keys per kept object: extras are dropped. */
export const MAX_ATTRIBUTES = 128;
/** Entries per array: extras are dropped. */
export const MAX_ARRAY_ITEMS = 256;
/** Value nesting depth; anything deeper is replaced with TRUNCATION_MARKER. */
export const MAX_VALUE_DEPTH = 8;
export const MAX_KEY_CHARS = 256;
export const MAX_SHORT_STRING_CHARS = 256;
export const MAX_CALLER_ALIAS_CHARS = 128;
export const TRUNCATION_MARKER = '…[truncated]';
/** Entries per `extra` or `invalid` map on one line level; past it they are dropped. */
export const MAX_NOTE_ENTRIES = 256;
/** errorMessage keeps this many distinct reasons per kind, each cut to MAX_REASON_CHARS. */
export const MAX_ERROR_REASONS = 10;
export const MAX_REASON_CHARS = 200;

// ── Byte budget ────────────────────────────────────────────────────────────

/**
 * Per-caller token bucket over stored bytes. 192 KiB/min refills about
 * 270 MiB a day, the same ceiling as a 256 MiB daily cap, but an exhausted
 * bucket recovers within minutes once a flood stops instead of staying shut
 * until UTC midnight. The 16 MiB burst holds four maximum-size calls, or
 * hours of normal permission-review traffic (a pair of records is a few KiB,
 * ~35 KiB with a full 16 KiB tool input).
 */
export const BUDGET_CAPACITY_BYTES = 16 * 1024 * 1024;
export const BUDGET_REFILL_BYTES_PER_MINUTE = 192 * 1024;
/** At most one daemon `quota_exceeded` line per caller per interval. */
export const QUOTA_MARKER_INTERVAL_MS = 60_000;
/**
 * Daemon-only headroom per caller per UTC day for `quota_exceeded` lines,
 * outside the budget. One marker a minute is ~0.5 MiB a day, so this cap is
 * a backstop that the interval keeps out of reach.
 */
export const QUOTA_HEADROOM_BYTES_PER_DAY = 1024 * 1024;

/**
 * After a timer attempt leaves a marker unwritten (write error, or the day's
 * headroom is spent), retry with exponential backoff from the failure, not
 * from the last marker, so a persistent ENOSPC/EIO can't spin.
 */
export const MARKER_RETRY_MIN_MS = 1000;
export const MARKER_RETRY_MAX_MS = 5 * 60_000;
/** The same write error is logged at most once per window, with a count of the rest. */
export const ERROR_LOG_WINDOW_MS = 60_000;

export interface BudgetOptions {
  capacityBytes: number;
  refillBytesPerMinute: number;
  /** Override QUOTA_HEADROOM_BYTES_PER_DAY (tests). */
  markerHeadroomBytesPerDay?: number;
}

/** Log `message` at most once per ERROR_LOG_WINDOW_MS per key, counting the rest. */
const errorLogState = new Map<string, { loggedAt: number; suppressed: number }>();
function logLimited(key: string, message: string, err: unknown): void {
  const now = Date.now();
  const st = errorLogState.get(key);
  if (st && now - st.loggedAt < ERROR_LOG_WINDOW_MS) {
    st.suppressed++;
    return;
  }
  const more = st?.suppressed ? ` (${st.suppressed} more since last report)` : '';
  errorLogState.set(key, { loggedAt: now, suppressed: 0 });
  log.error(`${message}${more}:`, err);
}

// ── Wire types ─────────────────────────────────────────────────────────────

export interface IngestLogsResponse {
  partialSuccess?: { rejectedLogRecords: number; errorMessage: string };
}

/** The flattened shape of one stored client line. */
export interface AuditLine {
  'drawlatch.caller': string;
  'drawlatch.received_at': string;
  'drawlatch.sequence': number;
  'drawlatch.source': 'client';
  time_unix_nano?: string;
  observed_time_unix_nano?: string;
  severity_number?: number;
  severity_text?: string;
  event_name?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  flags?: number;
  body?: unknown;
  attributes: Record<string, unknown>;
  dropped_attributes_count?: number;
  resource: Record<string, unknown>;
  resource_dropped_attributes_count?: number;
  resource_schema_url?: string;
  scope: {
    name?: string;
    version?: string;
    attributes?: Record<string, unknown>;
    dropped_attributes_count?: number;
  };
  scope_schema_url?: string;
  /** Unknown fields, keyed by path (e.g. `logRecord.foo`, `resource.entityRefs`). */
  extra?: Record<string, unknown>;
  /** Known fields whose values failed validation, keyed by path. */
  invalid?: Record<string, { reason: string; raw: unknown }>;
  truncated?: true;
}

/** A line the daemon writes itself when the budget refuses records. */
export interface QuotaExceededLine {
  'drawlatch.caller': string;
  'drawlatch.received_at': string;
  'drawlatch.sequence': number;
  'drawlatch.source': 'daemon';
  'drawlatch.event': 'quota_exceeded';
  rejected_records: number;
  rejected_bytes: number;
  window_start: string;
  window_end: string;
  budget: { capacity_bytes: number; refill_bytes_per_minute: number };
}

// ── Validation ─────────────────────────────────────────────────────────────

class RecordError extends Error {}

type Plain = Record<string, unknown>;

const INVALID: unique symbol = Symbol('invalid');
type Maybe<T> = T | typeof INVALID;

/** Call-level reasons for partialSuccess.errorMessage, bounded. */
interface Reasons {
  rejected: string[];
  kept: string[];
}

/** Record a reason once, bounded so a hostile batch can't bloat the reply. */
function noteReason(list: string[], reason: string): void {
  const cut = reason.length > MAX_REASON_CHARS ? reason.slice(0, MAX_REASON_CHARS) + '…' : reason;
  if (list.length < MAX_ERROR_REASONS && !list.includes(cut)) list.push(cut);
}

/** What was cut, kept, or flagged while parsing one record or one container. */
class Notes {
  truncated = false;
  readonly extra = new Map<string, unknown>();
  readonly invalid = new Map<string, { reason: string; raw: unknown }>();
  constructor(private readonly reasons: Reasons) {}

  keepExtra(where: string, value: unknown): void {
    if (this.put(this.extra, where, () => boundJson(value, 0, this))) {
      noteReason(this.reasons.kept, `unknown field ${where} kept in extra`);
    }
  }

  markInvalid(where: string, reason: string, raw: unknown): typeof INVALID {
    if (this.put(this.invalid, where, () => ({ reason, raw: boundJson(raw, 0, this) }))) {
      noteReason(this.reasons.kept, `invalid ${where} kept in invalid: ${reason}`);
    }
    return INVALID;
  }

  /**
   * Store under `where`, bounded. Paths are built to be unique (see
   * keySegment); a `#n` suffix is a backstop so a collision can never
   * overwrite an earlier entry. Past MAX_NOTE_ENTRIES the entry is dropped
   * and the line marked truncated.
   */
  private put<T>(map: Map<string, T>, where: string, value: () => T): boolean {
    if (map.size >= MAX_NOTE_ENTRIES) {
      this.truncated = true;
      return false;
    }
    let key = where;
    for (let n = 2; map.has(key); n++) key = `${where}#${n}`;
    map.set(key, value());
    return true;
  }
}

/**
 * A client-chosen key as a path segment: `["key"]`, JSON-quoted so a key
 * containing `.`, `[` or `"` can't produce the same path as nested data.
 * Fixed field names use `.name` and array positions `[n]`, so the three
 * segment forms never overlap. Overlong keys are cut and marked.
 */
function keySegment(key: string, notes: Notes): string {
  if (key.length <= MAX_KEY_CHARS) return `[${JSON.stringify(key)}]`;
  notes.truncated = true;
  return `[${JSON.stringify(key.slice(0, MAX_KEY_CHARS) + TRUNCATION_MARKER)}]`;
}

function isObject(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Move keys outside `known` into `notes.extra` under `where.<key>`. */
function keepUnknown(obj: Plain, known: readonly string[], where: string, notes: Notes): void {
  let kept = 0;
  for (const key of Object.keys(obj)) {
    if (known.includes(key)) continue;
    // Bounded like any other object: past the cap, drop and mark the line.
    if (kept++ >= MAX_ATTRIBUTES) {
      notes.truncated = true;
      break;
    }
    notes.keepExtra(`${where}${keySegment(key, notes)}`, obj[key]);
  }
}

function truncateString(s: string, notes: Notes): string {
  if (s.length <= MAX_STRING_CHARS) return s;
  notes.truncated = true;
  let end = MAX_STRING_CHARS;
  // Don't split a surrogate pair.
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return s.slice(0, end) + TRUNCATION_MARKER;
}

/** A bounded copy of arbitrary JSON, for `extra` and `invalid.raw`. */
function boundJson(v: unknown, depth: number, notes: Notes): unknown {
  if (typeof v === 'string') return truncateString(v, notes);
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v !== 'object') return null;
  if (depth >= MAX_VALUE_DEPTH) {
    notes.truncated = true;
    return TRUNCATION_MARKER;
  }
  if (Array.isArray(v)) {
    if (v.length > MAX_ARRAY_ITEMS) notes.truncated = true;
    return v.slice(0, MAX_ARRAY_ITEMS).map((item) => boundJson(item, depth + 1, notes));
  }
  const keys = Object.keys(v);
  if (keys.length > MAX_ATTRIBUTES) notes.truncated = true;
  // Object.fromEntries so a `__proto__` key stays an own property.
  return Object.fromEntries(
    keys.slice(0, MAX_ATTRIBUTES).map((k) => {
      let key = k;
      if (key.length > MAX_KEY_CHARS) {
        notes.truncated = true;
        key = key.slice(0, MAX_KEY_CHARS) + TRUNCATION_MARKER;
      }
      return [key, boundJson((v as Plain)[k], depth + 1, notes)];
    }),
  );
}

function shortString(v: unknown, where: string, notes: Notes): Maybe<string> {
  if (typeof v !== 'string') return notes.markInvalid(where, 'not a string', v);
  if (v.length > MAX_SHORT_STRING_CHARS) {
    return notes.markInvalid(where, `longer than ${MAX_SHORT_STRING_CHARS} chars`, v);
  }
  return v;
}

/** uint64 in OTLP/JSON: a decimal string, or a non-negative safe integer. */
function uint64(v: unknown, where: string, notes: Notes): Maybe<string> {
  if (typeof v === 'string' && /^\d{1,20}$/.test(v) && BigInt(v) <= 0xffffffffffffffffn) {
    return BigInt(v).toString();
  }
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return String(v);
  return notes.markInvalid(where, 'not a uint64', v);
}

/** uint32 in proto3 JSON: a number or a decimal string. */
function uint32(v: unknown, where: string, notes: Notes): Maybe<number> {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : v;
  if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff) return n;
  return notes.markInvalid(where, 'not a uint32', v);
}

/** int64 in OTLP/JSON. A number when it fits exactly, else a decimal string. */
function int64(v: unknown, where: string, notes: Notes): Maybe<number | string> {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d{1,19}$/.test(v)) {
    const n = BigInt(v);
    if (n >= -(2n ** 63n) && n < 2n ** 63n) {
      return Number.isSafeInteger(Number(n)) ? Number(n) : n.toString();
    }
  }
  return notes.markInvalid(where, 'not an int64', v);
}

/** Proto3 JSON doubles: a finite number, a numeric string, or NaN/±Infinity as strings. */
function double(v: unknown, where: string, notes: Notes): Maybe<number | string> {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v === 'NaN' || v === 'Infinity' || v === '-Infinity') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return notes.markInvalid(where, 'not a double', v);
}

/** Hex id, or undefined for OTLP/JSON's empty "unset". */
function hexId(v: unknown, length: number, where: string, notes: Notes): Maybe<string | undefined> {
  if (v === '') return undefined;
  if (typeof v === 'string' && v.length === length && /^[0-9a-fA-F]+$/.test(v)) {
    return v.toLowerCase();
  }
  return notes.markInvalid(where, `not ${length} hex chars`, v);
}

const SEVERITY_NAMES: Record<string, number> = Object.fromEntries([
  ['SEVERITY_NUMBER_UNSPECIFIED', 0],
  ...['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].flatMap((name, i) =>
    [1, 2, 3, 4].map((k) => [`SEVERITY_NUMBER_${name}${k === 1 ? '' : k}`, i * 4 + k]),
  ),
]) as Record<string, number>;

/** An integer 0-24, or its proto3 JSON enum name. */
function severity(v: unknown, notes: Notes): Maybe<number> {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 24) return v;
  if (typeof v === 'string' && Object.hasOwn(SEVERITY_NAMES, v)) return SEVERITY_NAMES[v];
  return notes.markInvalid('logRecord.severityNumber', 'not a severity number 0-24', v);
}

const ANY_VALUE_KEYS = [
  'stringValue',
  'boolValue',
  'intValue',
  'doubleValue',
  'bytesValue',
  'arrayValue',
  'kvlistValue',
] as const;

/** Convert an OTLP AnyValue to a plain JSON value. */
function anyValue(v: unknown, depth: number, notes: Notes, where: string): Maybe<unknown> {
  if (!isObject(v)) return notes.markInvalid(where, 'not an AnyValue object', v);
  keepUnknown(v, ANY_VALUE_KEYS, where, notes);
  const kinds = ANY_VALUE_KEYS.filter((k) => Object.hasOwn(v, k));
  // OTLP allows an empty AnyValue; it means "no value".
  if (kinds.length === 0) return null;
  if (kinds.length > 1) {
    return notes.markInvalid(where, `more than one of ${kinds.join(', ')}`, v);
  }
  const kind = kinds[0];
  const inner = v[kind];
  switch (kind) {
    case 'stringValue':
      if (typeof inner !== 'string') {
        return notes.markInvalid(where, 'stringValue not a string', inner);
      }
      return truncateString(inner, notes);
    case 'boolValue':
      if (typeof inner !== 'boolean') {
        return notes.markInvalid(where, 'boolValue not a boolean', inner);
      }
      return inner;
    case 'intValue':
      return int64(inner, where, notes);
    case 'doubleValue':
      return double(inner, where, notes);
    case 'bytesValue':
      // Proto3 JSON accepts standard or URL-safe base64, padded or not.
      if (typeof inner !== 'string' || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(inner)) {
        return notes.markInvalid(where, 'bytesValue not base64', inner);
      }
      return truncateString(inner, notes);
    case 'arrayValue': {
      if (depth >= MAX_VALUE_DEPTH) {
        notes.truncated = true;
        return TRUNCATION_MARKER;
      }
      if (!isObject(inner)) return notes.markInvalid(where, 'arrayValue not an object', inner);
      keepUnknown(inner, ['values'], `${where}.arrayValue`, notes);
      const values = inner.values ?? [];
      if (!Array.isArray(values)) {
        return notes.markInvalid(where, 'arrayValue.values not an array', values);
      }
      if (values.length > MAX_ARRAY_ITEMS) notes.truncated = true;
      return values.slice(0, MAX_ARRAY_ITEMS).map((item, i) => {
        const r = anyValue(item, depth + 1, notes, `${where}[${i}]`);
        // Keep positions: an invalid element becomes null.
        return r === INVALID ? null : r;
      });
    }
    case 'kvlistValue': {
      if (depth >= MAX_VALUE_DEPTH) {
        notes.truncated = true;
        return TRUNCATION_MARKER;
      }
      if (!isObject(inner)) return notes.markInvalid(where, 'kvlistValue not an object', inner);
      keepUnknown(inner, ['values'], `${where}.kvlistValue`, notes);
      return keyValues(inner.values ?? [], depth + 1, notes, where);
    }
  }
}

/**
 * Convert an OTLP KeyValue list to a plain object. An entry that can't be
 * kept (bad key, duplicate key, invalid value) goes to `invalid` instead.
 * Built with Object.fromEntries so a `__proto__` key stays an own property.
 */
function keyValues(list: unknown, depth: number, notes: Notes, where: string): Plain {
  if (!Array.isArray(list)) {
    notes.markInvalid(where, 'not an array', list);
    return {};
  }
  if (list.length > MAX_ATTRIBUTES) notes.truncated = true;
  const seen = new Set<string>();
  const entries: [string, unknown][] = [];
  for (const [i, kv] of list.slice(0, MAX_ATTRIBUTES).entries()) {
    const at = `${where}[${i}]`;
    if (!isObject(kv)) {
      notes.markInvalid(at, 'not a {key, value} object', kv);
      continue;
    }
    keepUnknown(kv, ['key', 'value'], at, notes);
    const key = kv.key;
    if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_CHARS) {
      // Keep the value too: only the key is unusable.
      notes.markInvalid(at, `key not a 1-${MAX_KEY_CHARS} char string`, { key, value: kv.value });
      continue;
    }
    if (seen.has(key)) {
      notes.markInvalid(at, `duplicate key "${key}"`, kv.value);
      continue;
    }
    seen.add(key);
    // A missing value is an empty AnyValue.
    const value =
      kv.value === undefined
        ? null
        : anyValue(kv.value, depth, notes, `${where}${keySegment(key, notes)}`);
    if (value !== INVALID) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

/** A pre-serialized JSON fragment and its UTF-8 size. */
interface Piece {
  text: string;
  bytes: number;
}

function piece(text: string): Piece {
  return { text, bytes: Buffer.byteLength(text) };
}

/** `"k":v,"k2":v2` for a notes map, without braces, so maps from several levels can merge. */
function entriesPiece(map: Map<string, unknown>): Piece | undefined {
  if (map.size === 0) return undefined;
  return piece([...map].map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(','));
}

/**
 * One container's contribution to every line under it (the request, a
 * resourceLogs entry, a scopeLogs entry). Serialized once and spliced into
 * each line, so per-record cost never scales with shared payload size.
 * Paths in `extra`/`invalid` are prefixed per level, so they never collide.
 */
interface Level {
  /** `,"resource":…` and its siblings; empty for the request level. */
  fields: Piece;
  extra?: Piece;
  invalid?: Piece;
  truncated: boolean;
  bytes: number;
}

function level(notes: Notes, fields: string): Level {
  const l: Level = {
    fields: piece(fields),
    extra: entriesPiece(notes.extra),
    invalid: entriesPiece(notes.invalid),
    truncated: notes.truncated,
    bytes: 0,
  };
  l.bytes = l.fields.bytes + (l.extra?.bytes ?? 0) + (l.invalid?.bytes ?? 0);
  return l;
}

function parseResourceLevel(rl: Plain, reasons: Reasons): Level {
  const notes = new Notes(reasons);
  keepUnknown(rl, ['resource', 'scopeLogs', 'schemaUrl'], 'resourceLogs', notes);

  let resource: Plain = {};
  let dropped: Maybe<number> | undefined;
  if (rl.resource !== undefined) {
    if (!isObject(rl.resource)) {
      notes.markInvalid('resource', 'not an object', rl.resource);
    } else {
      keepUnknown(rl.resource, ['attributes', 'droppedAttributesCount'], 'resource', notes);
      if (rl.resource.attributes !== undefined) {
        resource = keyValues(rl.resource.attributes, 0, notes, 'resource.attributes');
      }
      if (rl.resource.droppedAttributesCount !== undefined) {
        dropped = uint32(
          rl.resource.droppedAttributesCount,
          'resource.droppedAttributesCount',
          notes,
        );
      }
    }
  }
  const schemaUrl =
    rl.schemaUrl === undefined
      ? undefined
      : shortString(rl.schemaUrl, 'resourceLogs.schemaUrl', notes);

  let fields = `,"resource":${JSON.stringify(resource)}`;
  if (dropped !== undefined && dropped !== INVALID) {
    fields += `,"resource_dropped_attributes_count":${dropped}`;
  }
  if (schemaUrl !== undefined && schemaUrl !== INVALID) {
    fields += `,"resource_schema_url":${JSON.stringify(schemaUrl)}`;
  }
  return level(notes, fields);
}

function parseScopeLevel(sl: Plain, reasons: Reasons): Level {
  const notes = new Notes(reasons);
  keepUnknown(sl, ['scope', 'logRecords', 'schemaUrl'], 'scopeLogs', notes);

  const scope: AuditLine['scope'] = {};
  if (sl.scope !== undefined) {
    if (!isObject(sl.scope)) {
      notes.markInvalid('scope', 'not an object', sl.scope);
    } else {
      const s = sl.scope;
      keepUnknown(s, ['name', 'version', 'attributes', 'droppedAttributesCount'], 'scope', notes);
      const name = s.name === undefined ? undefined : shortString(s.name, 'scope.name', notes);
      if (name !== undefined && name !== INVALID) scope.name = name;
      const version =
        s.version === undefined ? undefined : shortString(s.version, 'scope.version', notes);
      if (version !== undefined && version !== INVALID) scope.version = version;
      if (s.attributes !== undefined) {
        scope.attributes = keyValues(s.attributes, 0, notes, 'scope.attributes');
      }
      if (s.droppedAttributesCount !== undefined) {
        const d = uint32(s.droppedAttributesCount, 'scope.droppedAttributesCount', notes);
        if (d !== INVALID) scope.dropped_attributes_count = d;
      }
    }
  }
  const schemaUrl =
    sl.schemaUrl === undefined
      ? undefined
      : shortString(sl.schemaUrl, 'scopeLogs.schemaUrl', notes);

  let fields = `,"scope":${JSON.stringify(scope)}`;
  if (schemaUrl !== undefined && schemaUrl !== INVALID) {
    fields += `,"scope_schema_url":${JSON.stringify(schemaUrl)}`;
  }
  return level(notes, fields);
}

const LOG_RECORD_KEYS = [
  'timeUnixNano',
  'observedTimeUnixNano',
  'severityNumber',
  'severityText',
  'eventName',
  'body',
  'attributes',
  'droppedAttributesCount',
  'flags',
  'traceId',
  'spanId',
  // drawlatch extension: OTLP has no parent span on a log record.
  'parentSpanId',
] as const;

/** One validated record, before stamps are attached. */
export interface ParsedRecord {
  /** The record's own fields, in line order (fixed snake_case keys only). */
  fields: Plain;
  /** The record's own notes, as a Level with no fields. */
  own: Level;
  /** Shared containers, outermost first: request, resourceLogs, scopeLogs. */
  levels: Level[];
  truncated: boolean;
}

function parseRecord(rec: unknown, levels: Level[], reasons: Reasons): ParsedRecord {
  if (!isObject(rec)) throw new RecordError('logRecord not an object');
  const notes = new Notes(reasons);
  keepUnknown(rec, LOG_RECORD_KEYS, 'logRecord', notes);
  const f: Plain = {};
  const set = (key: string, value: unknown): void => {
    if (value !== undefined && value !== INVALID) f[key] = value;
  };

  if (rec.timeUnixNano !== undefined) {
    set('time_unix_nano', uint64(rec.timeUnixNano, 'logRecord.timeUnixNano', notes));
  }
  if (rec.observedTimeUnixNano !== undefined) {
    set(
      'observed_time_unix_nano',
      uint64(rec.observedTimeUnixNano, 'logRecord.observedTimeUnixNano', notes),
    );
  }
  if (rec.severityNumber !== undefined) set('severity_number', severity(rec.severityNumber, notes));
  if (rec.severityText !== undefined) {
    set('severity_text', shortString(rec.severityText, 'logRecord.severityText', notes));
  }
  if (rec.eventName !== undefined) {
    set('event_name', shortString(rec.eventName, 'logRecord.eventName', notes));
  }
  // An empty id means unset in OTLP/JSON: hexId returns undefined and set() skips it.
  if (rec.traceId !== undefined) {
    set('trace_id', hexId(rec.traceId, 32, 'logRecord.traceId', notes));
  }
  if (rec.spanId !== undefined) set('span_id', hexId(rec.spanId, 16, 'logRecord.spanId', notes));
  if (rec.parentSpanId !== undefined) {
    set('parent_span_id', hexId(rec.parentSpanId, 16, 'logRecord.parentSpanId', notes));
  }
  if (rec.flags !== undefined) set('flags', uint32(rec.flags, 'logRecord.flags', notes));
  if (rec.body !== undefined) set('body', anyValue(rec.body, 0, notes, 'logRecord.body'));
  f.attributes =
    rec.attributes === undefined ? {} : keyValues(rec.attributes, 0, notes, 'logRecord.attributes');
  if (rec.droppedAttributesCount !== undefined) {
    set(
      'dropped_attributes_count',
      uint32(rec.droppedAttributesCount, 'logRecord.droppedAttributesCount', notes),
    );
  }

  const own = level(notes, '');
  return {
    fields: f,
    own,
    levels,
    truncated: own.truncated || levels.some((l) => l.truncated),
  };
}

/** Outcome of validating a whole request, before anything is written. */
export interface ParsedBatch {
  records: ParsedRecord[];
  rejected: number;
  reasons: Reasons;
}

/** How many records a malformed container held: its array length, or 1 if not an array. */
function countUnder(logRecords: unknown): number {
  return Array.isArray(logRecords) ? logRecords.length : 1;
}

/**
 * Validate an ExportLogsServiceRequest. Throws only when the top level is not
 * an object or `resourceLogs` is not an array. Below that, a record is
 * rejected only when it can't be reached or kept (see the module comment).
 *
 * Shared container data is parsed and serialized once per container and
 * spliced into each line, so the cost is linear in the request size, never
 * records × shared payload.
 */
export function parseIngestRequest(input: unknown): ParsedBatch {
  if (!isObject(input)) throw new Error('ingest_logs: input must be an object');
  const resourceLogs = input.resourceLogs ?? [];
  if (!Array.isArray(resourceLogs)) throw new Error('ingest_logs: resourceLogs must be an array');

  const batch: ParsedBatch = { records: [], rejected: 0, reasons: { rejected: [], kept: [] } };
  const reject = (count: number, reason: string): void => {
    if (count === 0) return;
    batch.rejected += count;
    noteReason(batch.reasons.rejected, reason);
  };
  const requestNotes = new Notes(batch.reasons);
  keepUnknown(input, ['resourceLogs'], 'request', requestNotes);
  const request = level(requestNotes, '');

  for (const rl of resourceLogs) {
    if (!isObject(rl)) {
      reject(1, 'resourceLogs entry not an object');
      continue;
    }
    const scopeLogs = rl.scopeLogs ?? [];
    if (!Array.isArray(scopeLogs)) {
      reject(1, 'scopeLogs not an array');
      continue;
    }
    const resource = parseResourceLevel(rl, batch.reasons);
    const outerBytes = request.bytes + resource.bytes;

    for (const sl of scopeLogs) {
      if (!isObject(sl)) {
        reject(1, 'scopeLogs entry not an object');
        continue;
      }
      const logRecords = sl.logRecords ?? [];
      if (!Array.isArray(logRecords)) {
        reject(countUnder(logRecords), 'logRecords not an array');
        continue;
      }
      if (outerBytes > MAX_RECORD_BYTES) {
        reject(logRecords.length, `resource exceeds ${MAX_RECORD_BYTES} bytes`);
        continue;
      }
      const scope = parseScopeLevel(sl, batch.reasons);
      if (outerBytes + scope.bytes > MAX_RECORD_BYTES) {
        reject(logRecords.length, `resource and scope exceed ${MAX_RECORD_BYTES} bytes`);
        continue;
      }
      const levels = [request, resource, scope];
      for (const rec of logRecords as unknown[]) {
        if (batch.records.length >= MAX_RECORDS_PER_CALL) {
          reject(1, `more than ${MAX_RECORDS_PER_CALL} records in one call`);
          continue;
        }
        try {
          batch.records.push(parseRecord(rec, levels, batch.reasons));
        } catch (err) {
          if (!(err instanceof RecordError)) throw err;
          reject(1, err.message);
        }
      }
    }
  }
  return batch;
}

// ── Line rendering ─────────────────────────────────────────────────────────

export interface Stamps {
  'drawlatch.caller': string;
  'drawlatch.received_at': string;
  'drawlatch.sequence': number;
}

/**
 * Render one client line as fragments plus its total size, without joining
 * the shared container pieces until the line is accepted. Exported for tests.
 */
export function renderParts(rec: ParsedRecord, stamps: Stamps): { parts: string[]; bytes: number } {
  const own = { ...stamps, 'drawlatch.source': 'client' };
  // Stamps first, then the record's fields, then the stamps again:
  // re-assigning keeps them at the front and their values win any collision.
  const head: Plain = { ...own, ...rec.fields };
  Object.assign(head, own);
  const headText = JSON.stringify(head).slice(0, -1);

  const all = [...rec.levels, rec.own];
  const parts: string[] = [headText];
  let bytes = Buffer.byteLength(headText);
  for (const l of all) {
    parts.push(l.fields.text);
    bytes += l.fields.bytes;
  }
  for (const key of ['extra', 'invalid'] as const) {
    const present = all.map((l) => l[key]).filter((p): p is Piece => p !== undefined);
    if (present.length === 0) continue;
    const open = `,"${key}":{`;
    parts.push(open, present.map((p) => p.text).join(','), '}');
    bytes += open.length + present.reduce((n, p) => n + p.bytes, 0) + present.length - 1 + 1;
  }
  const tail = rec.truncated ? ',"truncated":true}\n' : '}\n';
  parts.push(tail);
  bytes += tail.length;
  return { parts, bytes };
}

// ── Storage ────────────────────────────────────────────────────────────────

/**
 * Validate a caller alias for use as a path segment. Aliases come from the
 * authenticated session, but remote.config.json is hand-editable, so check
 * anyway rather than trust that every alias went through CALLER_ALIAS_REGEX.
 */
export function auditCallerDir(auditRoot: string, callerAlias: string): string {
  if (callerAlias.length > MAX_CALLER_ALIAS_CHARS || !CALLER_ALIAS_REGEX.test(callerAlias)) {
    throw new Error('ingest_logs: caller alias is not a safe path segment');
  }
  const root = path.resolve(auditRoot);
  const dir = path.resolve(root, callerAlias);
  if (path.dirname(dir) !== root) {
    throw new Error('ingest_logs: caller alias is not a safe path segment');
  }
  return dir;
}

export function auditRootDir(): string {
  return path.join(getConfigDir(), 'audit');
}

/** UTC calendar day, `YYYY-MM-DD`. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** fsync a directory so a newly created entry in it survives a crash. */
async function syncDir(dir: string): Promise<void> {
  const fh = await fs.promises.open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Create `dir` if needed, force it to 0700 (mkdir's mode is umask-filtered),
 * and fsync its parent when we created it.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
  const created = await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(dir, 0o700);
  if (created !== undefined) await syncDir(path.dirname(dir));
}

/** Open for append and read, reporting whether this call created the file. */
async function openAppend(file: string): Promise<{ fh: fs.promises.FileHandle; created: boolean }> {
  const { O_APPEND, O_RDWR, O_CREAT, O_EXCL } = fs.constants;
  try {
    const fh = await fs.promises.open(file, O_APPEND | O_RDWR | O_CREAT | O_EXCL, 0o600);
    return { fh, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return { fh: await fs.promises.open(file, 'a+', 0o600), created: false };
  }
}

/** Highest `drawlatch.sequence` among the complete JSON lines in `text`. */
function maxSequence(text: string): number {
  let last = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const seq = (JSON.parse(line) as Plain)['drawlatch.sequence'];
      if (typeof seq === 'number' && seq > last) last = seq;
    } catch {
      // A torn line from a crash mid-write, or the cut first line of the tail.
    }
  }
  return last;
}

/**
 * Recover the last sequence number from an existing file. Sequences only grow
 * within a file, so the answer is in the last complete line: read a tail big
 * enough to hold a few maximum-size lines, and fall back to the whole file
 * only if the tail holds no parseable line (corruption, not the normal case).
 */
async function loadLastSequence(fh: fs.promises.FileHandle, size: number): Promise<number> {
  const tailBytes = Math.min(size, 4 * MAX_RECORD_BYTES);
  const tail = Buffer.alloc(tailBytes);
  await fh.read(tail, 0, tailBytes, size - tailBytes);
  const fromTail = maxSequence(tail.toString('utf8'));
  if (fromTail > 0 || tailBytes === size) return fromTail;
  return maxSequence((await fh.readFile()).toString('utf8'));
}

/**
 * Last sequence written per caller, for the newest day touched. Writing to a
 * new day replaces the entry, so the map holds one entry per caller. A write
 * to an older day (a batch queued across midnight) reloads from disk.
 */
const sequences = new Map<string, { day: string; lastSequence: number }>();
/** Tail of the per-file write chain: one append in flight per file. */
const fileQueues = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier write to `file` has settled. */
function serialize<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileQueues.get(file) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  fileQueues.set(file, tail);
  void tail.then(() => {
    if (fileQueues.get(file) === tail) fileQueues.delete(file);
  });
  return next;
}

/** What a writer wants appended, given the file's last sequence. */
interface AppendPlan {
  text: string;
  lastSequence: number;
  /** Undo in-memory accounting if the append fails. */
  rollback?: () => void;
}

/**
 * Append to `<callerDir>/<day>.jsonl` under the per-file lock: create dirs
 * and file privately (fsyncing parents of anything new), recover the
 * sequence, isolate a torn last line, then write `plan(lastSequence)` with
 * one append and fdatasync before returning.
 */
async function appendToDayFile(
  auditRoot: string,
  callerDir: string,
  day: string,
  plan: (lastSequence: number) => AppendPlan | undefined,
): Promise<void> {
  const file = path.join(callerDir, `${day}.jsonl`);
  await serialize(file, async () => {
    await ensurePrivateDir(auditRoot);
    await ensurePrivateDir(callerDir);
    const { fh, created } = await openAppend(file);
    try {
      if (created) await syncDir(callerDir);
      await fh.chmod(0o600);
      const { size } = await fh.stat();
      let state = sequences.get(callerDir);
      if (state?.day !== day) {
        state = { day, lastSequence: await loadLastSequence(fh, size) };
        sequences.set(callerDir, state);
      }

      const p = plan(state.lastSequence);
      if (!p) return;

      // A crash mid-append can leave a torn last line. Start on a fresh
      // line so it can't swallow the first record of this batch.
      let prefix = '';
      if (size > 0) {
        const last = Buffer.alloc(1);
        await fh.read(last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = '\n';
      }
      try {
        await fh.appendFile(prefix + p.text);
        await fh.datasync();
      } catch (err) {
        // Part of the batch may have landed. Re-read the file next time
        // rather than reuse sequence numbers that are already on disk.
        sequences.delete(callerDir);
        p.rollback?.();
        throw err;
      }
      state.lastSequence = p.lastSequence;
    } finally {
      await fh.close();
    }
  });
}

// ── Budget and quota markers ───────────────────────────────────────────────

/** Budget-refused records not yet reported in a marker. */
interface Pending {
  records: number;
  bytes: number;
  windowStart: number;
  windowEnd: number;
}

interface CallerQuota {
  tokens: number;
  refilledAt: number;
  pending?: Pending;
  lastMarkerAt?: number;
  headroom: { day: string; used: number };
  timer?: NodeJS.Timeout;
  /** Backoff after a timer attempt that left the marker unwritten. */
  retryDelayMs: number;
  retryAt?: number;
  /** What a marker written from the timer or at shutdown needs. */
  auditRoot: string;
  callerAlias: string;
  budget: BudgetOptions;
}

/** Keyed by caller dir, so bounded by the number of callers. */
const quotas = new Map<string, CallerQuota>();

/** The caller's quota state, with its bucket refilled up to `now`. */
function quotaFor(
  callerDir: string,
  auditRoot: string,
  callerAlias: string,
  budget: BudgetOptions,
  now: number,
): CallerQuota {
  let q = quotas.get(callerDir);
  if (!q) {
    q = {
      tokens: budget.capacityBytes,
      refilledAt: now,
      headroom: { day: utcDay(now), used: 0 },
      retryDelayMs: 0,
      auditRoot,
      callerAlias,
      budget,
    };
    quotas.set(callerDir, q);
  }
  q.budget = budget;
  const elapsed = Math.max(0, now - q.refilledAt);
  q.tokens = Math.min(
    budget.capacityBytes,
    q.tokens + (elapsed * budget.refillBytesPerMinute) / 60_000,
  );
  q.refilledAt = Math.max(q.refilledAt, now);
  return q;
}

function addPending(q: CallerQuota, records: number, bytes: number, now: number): void {
  if (q.pending) {
    q.pending.records += records;
    q.pending.bytes += bytes;
    q.pending.windowStart = Math.min(q.pending.windowStart, now);
    q.pending.windowEnd = Math.max(q.pending.windowEnd, now);
  } else {
    q.pending = { records, bytes, windowStart: now, windowEnd: now };
  }
}

/**
 * If a marker is due (interval passed, or `force`) and the day's headroom
 * allows it, take the pending counts and return the rendered line, with a
 * rollback that restores them if the write fails.
 */
function takeMarker(
  q: CallerQuota,
  seq: number,
  now: number,
  force = false,
): { text: string; rollback: () => void } | undefined {
  const pending = q.pending;
  if (!pending) return undefined;
  if (!force && q.lastMarkerAt !== undefined && now - q.lastMarkerAt < QUOTA_MARKER_INTERVAL_MS) {
    return undefined;
  }
  const day = utcDay(now);
  if (q.headroom.day !== day) q.headroom = { day, used: 0 };
  const line: QuotaExceededLine = {
    'drawlatch.caller': q.callerAlias,
    'drawlatch.received_at': new Date(now).toISOString(),
    'drawlatch.sequence': seq,
    'drawlatch.source': 'daemon',
    'drawlatch.event': 'quota_exceeded',
    rejected_records: pending.records,
    rejected_bytes: pending.bytes,
    window_start: new Date(pending.windowStart).toISOString(),
    window_end: new Date(pending.windowEnd).toISOString(),
    budget: {
      capacity_bytes: q.budget.capacityBytes,
      refill_bytes_per_minute: q.budget.refillBytesPerMinute,
    },
  };
  const text = JSON.stringify(line) + '\n';
  const bytes = Buffer.byteLength(text);
  const headroom = q.budget.markerHeadroomBytesPerDay ?? QUOTA_HEADROOM_BYTES_PER_DAY;
  if (q.headroom.used + bytes > headroom) return undefined;

  const prevMarkerAt = q.lastMarkerAt;
  q.pending = undefined;
  q.lastMarkerAt = now;
  q.headroom.used += bytes;
  return {
    text,
    rollback: () => {
      q.lastMarkerAt = prevMarkerAt;
      q.headroom.used -= bytes;
      addPending(q, pending.records, pending.bytes, pending.windowStart);
      addPending(q, 0, 0, pending.windowEnd);
    },
  };
}

/** Write a caller's pending marker on its own line (timer or shutdown). */
async function writePendingMarker(callerDir: string, force: boolean): Promise<void> {
  const q = quotas.get(callerDir);
  if (!q?.pending) return;
  const now = Date.now();
  await appendToDayFile(q.auditRoot, callerDir, utcDay(now), (lastSequence) => {
    const marker = takeMarker(q, lastSequence + 1, now, force);
    if (!marker) return undefined;
    return { text: marker.text, lastSequence: lastSequence + 1, rollback: marker.rollback };
  });
}

/**
 * Make sure counts that couldn't be reported yet (interval not passed) are
 * written once it has. If an attempt leaves them pending (write error, or
 * the day's headroom is spent), back off exponentially from that attempt.
 * The timer is unref'd so it never holds the process open.
 */
function scheduleMarker(callerDir: string, q: CallerQuota, now: number): void {
  if (!q.pending || q.timer) return;
  const due = Math.max((q.lastMarkerAt ?? now) + QUOTA_MARKER_INTERVAL_MS, q.retryAt ?? 0);
  q.timer = setTimeout(
    () => {
      q.timer = undefined;
      writePendingMarker(callerDir, false)
        .catch((err: unknown) => {
          logLimited(`marker:${callerDir}`, 'quota marker write failed', err);
        })
        .finally(() => {
          if (q.pending) {
            retryMarkerLater(callerDir, q);
          } else {
            q.retryDelayMs = 0;
            q.retryAt = undefined;
          }
        });
    },
    Math.max(0, due - now),
  );
  q.timer.unref();
}

/**
 * A marker attempt left counts pending: back off (1 s doubling to
 * MARKER_RETRY_MAX_MS, from now) and make sure a timer is armed. Used by the
 * timer itself and by a failed inline marker, so pending counts always have
 * a timer and never wait on the caller's next call.
 */
function retryMarkerLater(callerDir: string, q: CallerQuota): void {
  q.retryDelayMs = Math.min(
    MARKER_RETRY_MAX_MS,
    q.retryDelayMs ? q.retryDelayMs * 2 : MARKER_RETRY_MIN_MS,
  );
  q.retryAt = Date.now() + q.retryDelayMs;
  if (quotas.get(callerDir) === q) scheduleMarker(callerDir, q, Date.now());
}

/**
 * Write every pending `quota_exceeded` marker now, ignoring the interval.
 * Called on shutdown so a flood that ends with the daemon still leaves its
 * marker.
 */
export async function flushQuotaMarkers(): Promise<void> {
  for (const [callerDir, q] of quotas) {
    if (q.timer) clearTimeout(q.timer);
    q.timer = undefined;
    await writePendingMarker(callerDir, true).catch((err: unknown) => {
      logLimited(`marker:${callerDir}`, 'quota marker write failed', err);
    });
  }
}

/**
 * flushQuotaMarkers, but never waiting longer than `ms`: shutdown must not
 * hang on a stuck disk. Resolves whether or not the flush finished.
 */
export async function flushQuotaMarkersWithin(ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  try {
    await Promise.race([flushQuotaMarkers(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

export interface IngestOptions {
  /** Override `<config dir>/audit` (tests). */
  auditRoot?: string;
  /** Override the receive time (tests). */
  now?: Date;
  /** Override the byte budget (tests). */
  budget?: BudgetOptions;
}

/** Filesystem errors carry absolute paths; the caller gets only the code. */
function safeWriteError(err: unknown): Error {
  logLimited('write', 'audit write failed', err);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return new Error(
    `ingest_logs: audit write failed${typeof code === 'string' ? ` (${code})` : ''}`,
  );
}

/**
 * Set by graceful shutdown. New calls are refused (the client keeps its batch
 * and resends after the restart, as with wait_for_events' drain), and calls
 * already in flight write their quota marker inline, so a refusal answered
 * during shutdown is never left pending.
 */
let shuttingDown = false;

export const SHUTTING_DOWN_MESSAGE = 'ingest_logs: server shutting down; retry after restart';

export function beginAuditShutdown(): void {
  shuttingDown = true;
}

/** Accept calls again (a new app in the same process, and tests). */
export function resumeAuditIngest(): void {
  shuttingDown = false;
}

/**
 * Validate and append one `ingest_logs` batch for `callerAlias`.
 *
 * Every line in a call shares one received_at, so a batch lands in a single
 * day file and is written with one append. Appends to the same file are
 * serialized in-process, so concurrent calls never interleave partial lines,
 * and each append is fsync'd before we answer: a record we acknowledge is on
 * disk. Assumes one daemon process per config dir, which `drawlatch start`
 * already enforces with its PID file.
 */
export async function ingestLogs(
  input: unknown,
  callerAlias: string,
  options: IngestOptions = {},
): Promise<IngestLogsResponse> {
  if (shuttingDown) throw new Error(SHUTTING_DOWN_MESSAGE);
  const auditRoot = options.auditRoot ?? auditRootDir();
  const callerDir = auditCallerDir(auditRoot, callerAlias);
  const batch = parseIngestRequest(input);
  const now = (options.now ?? new Date()).getTime();
  const budget = options.budget ?? {
    capacityBytes: BUDGET_CAPACITY_BYTES,
    refillBytesPerMinute: BUDGET_REFILL_BYTES_PER_MINUTE,
  };

  let rejected = batch.rejected;
  const reasons = batch.reasons;
  const addRejected = (reason: string): void => {
    rejected++;
    noteReason(reasons.rejected, reason);
  };

  if (batch.records.length > 0) {
    const receivedAt = new Date(now).toISOString();
    try {
      await appendToDayFile(auditRoot, callerDir, utcDay(now), (lastSequence) => {
        const q = quotaFor(callerDir, auditRoot, callerAlias, budget, now);
        const chunks: string[] = [];
        let seq = lastSequence;
        let callBytes = 0;
        let spent = 0;
        let refusedRecords = 0;
        let refusedBytes = 0;

        for (const rec of batch.records) {
          const { parts, bytes } = renderParts(rec, {
            'drawlatch.caller': callerAlias,
            'drawlatch.received_at': receivedAt,
            'drawlatch.sequence': seq + 1,
          });
          if (bytes > MAX_RECORD_BYTES) {
            addRejected(`record exceeds ${MAX_RECORD_BYTES} bytes after truncation`);
            continue;
          }
          if (callBytes + bytes > MAX_BYTES_PER_CALL) {
            addRejected(`call exceeds ${MAX_BYTES_PER_CALL} stored bytes`);
            continue;
          }
          if (q.tokens < bytes) {
            refusedRecords++;
            refusedBytes += bytes;
            addRejected('audit byte budget exhausted for this caller; retry later');
            continue;
          }
          q.tokens -= bytes;
          spent += bytes;
          seq++;
          callBytes += bytes;
          chunks.push(parts.join(''));
        }

        if (refusedRecords > 0) addPending(q, refusedRecords, refusedBytes, now);
        // During shutdown nothing may stay pending: write the marker now.
        const marker = takeMarker(q, seq + 1, now, shuttingDown);
        if (marker) {
          seq++;
          chunks.push(marker.text);
        }
        scheduleMarker(callerDir, q, now);
        if (chunks.length === 0) return undefined;
        return {
          text: chunks.join(''),
          lastSequence: seq,
          rollback: () => {
            q.tokens = Math.min(budget.capacityBytes, q.tokens + spent);
            if (marker) {
              marker.rollback();
              // takeMarker cleared pending before scheduleMarker ran, so no
              // timer is armed for the restored counts. Arm one.
              retryMarkerLater(callerDir, q);
            }
          },
        };
      });
    } catch (err) {
      throw safeWriteError(err);
    }
  }

  if (rejected === 0 && reasons.kept.length === 0) return {};
  const message = [
    ...reasons.rejected.map((r) => `rejected: ${r}`),
    ...reasons.kept.map((r) => `kept: ${r}`),
  ].join('; ');
  return { partialSuccess: { rejectedLogRecords: rejected, errorMessage: message } };
}

// ── Daemon events ──────────────────────────────────────────────────────────

/** A line the daemon writes for its own events (vault reveals, item changes). */
export interface DaemonEventLine {
  'drawlatch.caller': string;
  'drawlatch.received_at': string;
  'drawlatch.sequence': number;
  'drawlatch.source': 'daemon';
  'drawlatch.event': string;
  [field: string]: unknown;
}

export interface DaemonEventOptions {
  /** Override `<config dir>/audit` (tests). */
  auditRoot?: string;
  /** Override the receive time (tests). */
  now?: Date;
}

/**
 * Append one daemon-authored line to `callerAlias`'s audit log, under the same
 * per-file lock and sequence as client lines, fsync'd before it resolves.
 *
 * Not charged to the caller's byte budget: these lines record what the daemon
 * did for the caller (one per tool call at most, so bounded by the request
 * rate limit), and a caller flooding `ingest_logs` must not be able to block
 * them. Still refused past MAX_RECORD_BYTES. Rejects with the error code only,
 * never a path, so callers that must fail closed can surface the message.
 */
export async function appendDaemonEvent(
  callerAlias: string,
  fields: { 'drawlatch.event': string } & Record<string, unknown>,
  options: DaemonEventOptions = {},
): Promise<void> {
  const auditRoot = options.auditRoot ?? auditRootDir();
  const callerDir = auditCallerDir(auditRoot, callerAlias);
  const now = (options.now ?? new Date()).getTime();
  const render = (sequence: number): string => {
    const stamps = {
      'drawlatch.caller': callerAlias,
      'drawlatch.received_at': new Date(now).toISOString(),
      'drawlatch.sequence': sequence,
      'drawlatch.source': 'daemon' as const,
    };
    // Stamps first and last: re-assigning keeps them at the front and wins any collision.
    const line: Plain = { ...stamps, ...fields };
    Object.assign(line, stamps);
    return JSON.stringify(line) + '\n';
  };
  if (Buffer.byteLength(render(0)) > MAX_RECORD_BYTES) {
    throw new Error(`audit event exceeds ${MAX_RECORD_BYTES} bytes`);
  }
  try {
    await appendToDayFile(auditRoot, callerDir, utcDay(now), (lastSequence) => ({
      text: render(lastSequence + 1),
      lastSequence: lastSequence + 1,
    }));
  } catch (err) {
    logLimited('daemon-event', 'audit event write failed', err);
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(`audit write failed${typeof code === 'string' ? ` (${code})` : ''}`);
  }
}

/** Forget all in-memory state: sequences, budgets, pending markers, log limits (tests). */
export function resetAuditLogState(): void {
  sequences.clear();
  errorLogState.clear();
  shuttingDown = false;
  for (const q of quotas.values()) {
    if (q.timer) clearTimeout(q.timer);
  }
  quotas.clear();
}
