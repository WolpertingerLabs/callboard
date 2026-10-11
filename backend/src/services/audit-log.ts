/**
 * Audit log — ships OTLP-shaped log records to drawlatch for durable storage.
 *
 * drawlatch stores what it receives append-only, on a hub an agent may not be
 * able to reach or modify. callboard's own logs are not that: they live on
 * the same box, owned by the same OS user the agents run as. See
 * plans/audit-log-callboard-to-drawlatch.md.
 *
 * ## Shape
 *
 * Records go out through `getProxy(alias).callTool("ingest_logs", …)`, whose
 * input mirrors OTLP `ExportLogsServiceRequest` (JSON encoding: hex trace and
 * span ids, decimal-string nanosecond timestamps) and whose reply mirrors
 * `ExportLogsServiceResponse`. drawlatch rejects unknown keys on a record, so
 * {@link toOtlpRecord} emits exactly the OTLP LogRecord keys plus drawlatch's
 * one extension, a top-level `parentSpanId`.
 *
 * ## Never on the decision path
 *
 * {@link emitAuditRecord} is synchronous, O(1) and cannot throw: it captures a
 * timestamp and a record FACTORY, and pushes them. Everything that costs
 * anything — serializing a tool input, reading chat metadata for correlation
 * attributes — runs in the factory, at flush time, behind a try/catch. A
 * factory that throws costs one record (counted as dropped), never a decision.
 *
 * ## Loss is visible
 *
 * Overflow, a batch that exhausts its retries, a factory that throws, a record
 * drawlatch rejects, and records refused while the hub lacks `ingest_logs` all
 * count as dropped, per caller alias. The next batch that alias sends carries
 * one `callboard.audit.dropped` record with the counts and the window, so a gap
 * shows up in drawlatch, not just in callboard's own (agent-writable) log.
 *
 * ## Old hubs
 *
 * A hub without the tool answers "Unknown tool: ingest_logs" — same as the
 * `wait_for_events` fallback in event-watcher.ts. The alias is then disabled
 * for {@link REPROBE_INTERVAL_MS}; records emitted meanwhile are counted as
 * dropped rather than queued, and the first batch after the interval (which
 * carries the dropped record) is the re-probe. Logged once, not per batch.
 */
import { randomBytes } from "crypto";
import { readFileSync } from "fs";
import { hostname } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createLogger } from "../utils/logger.js";
import { getProxy, type ProxyLike } from "./proxy-singleton.js";

const log = createLogger("audit-log");

/** Most records held in memory across all aliases. Past it, new records are dropped (and counted). */
export const MAX_QUEUE = 1000;
/** Records per `ingest_logs` call. drawlatch accepts up to 1000; small batches keep a retry cheap. */
export const MAX_BATCH = 100;
/** Rough byte budget per call (drawlatch caps a call at 4 MiB of stored JSON). */
export const MAX_BATCH_BYTES = 1024 * 1024;
/** A flush runs at most this long after the first queued record. */
export const FLUSH_INTERVAL_MS = 1000;
/** Send attempts for one batch before it is dropped. ProxyClient already retries transport errors inside each. */
export const MAX_SEND_ATTEMPTS = 4;
/** Backoff before attempt n+1 is BASE * 2^(n-1): 2s, 4s, 8s. */
export const RETRY_BASE_MS = 2000;
/** One `ingest_logs` call may not take longer than this. */
export const SEND_TIMEOUT_MS = 15_000;
/** How long an alias whose hub lacks `ingest_logs` stays disabled before the next batch re-probes. */
export const REPROBE_INTERVAL_MS = 10 * 60_000;
/** Client-side cap on one string value. Matches drawlatch's own truncation, so nothing is shipped only to be cut. */
export const MAX_STRING_BYTES = 16 * 1024;

export const AUDIT_DROPPED_EVENT = "callboard.audit.dropped";

// ── OTLP JSON value types ───────────────────────────────────────────

export type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAnyValue[] } }
  | { kvlistValue: { values: OtlpKeyValue[] } };

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  eventName: string;
  body: OtlpAnyValue;
  attributes: OtlpKeyValue[];
  traceId?: string;
  spanId?: string;
  /** drawlatch extension — OTLP LogRecord has no parent span. */
  parentSpanId?: string;
  flags?: number;
}

export interface IngestLogsInput {
  resourceLogs: Array<{
    resource: { attributes: OtlpKeyValue[] };
    scopeLogs: Array<{ scope: { name: string; version: string }; logRecords: OtlpLogRecord[] }>;
  }>;
}

/** A plain attribute value; `null`/`undefined` attributes are omitted. */
export type AttrValue = string | number | boolean | null | undefined;

/** What a record factory produces. Ids/time are filled from the emit call when absent. */
export interface AuditRecordInput {
  eventName: string;
  severity: "INFO" | "WARN";
  body: string;
  attributes: Record<string, AttrValue>;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
}

/** OTLP severity numbers (logs data model). */
const SEVERITY_NUMBER = { INFO: 9, WARN: 13 } as const;

export const AUDIT_SCOPE_NAME = "callboard.permission-review";

// ── Ids ─────────────────────────────────────────────────────────────

/** A random 16-byte trace id, lowercase hex. */
export const newTraceId = (): string => randomBytes(16).toString("hex");
/** A random 8-byte span id, lowercase hex. */
export const newSpanId = (): string => randomBytes(8).toString("hex");

// ── Value encoding ──────────────────────────────────────────────────

/** Truncate to at most `max` UTF-8 bytes without splitting a character. */
export function truncateUtf8(value: string, max = MAX_STRING_BYTES): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, "utf8") <= max) return { value, truncated: false };
  let cut = Buffer.from(value, "utf8").subarray(0, max).toString("utf8");
  // A split multi-byte char decodes to U+FFFD at the end; drop it.
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return { value: cut, truncated: true };
}

function encodeValue(value: string | number | boolean): OtlpAnyValue {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: truncateUtf8(value).value };
}

export function encodeAttributes(attrs: Record<string, AttrValue>): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out.push({ key, value: encodeValue(value) });
  }
  return out;
}

/** Milliseconds since the epoch → OTLP decimal-string nanoseconds. */
const msToNano = (ms: number): string => (BigInt(Math.trunc(ms)) * 1_000_000n).toString();

function toOtlpRecord(input: AuditRecordInput, timeMs: number, observedMs: number): OtlpLogRecord {
  return {
    timeUnixNano: msToNano(timeMs),
    observedTimeUnixNano: msToNano(observedMs),
    severityNumber: SEVERITY_NUMBER[input.severity],
    severityText: input.severity,
    eventName: input.eventName,
    body: { stringValue: truncateUtf8(input.body).value },
    attributes: encodeAttributes(input.attributes),
    ...(input.traceId && { traceId: input.traceId }),
    ...(input.spanId && { spanId: input.spanId }),
    ...(input.parentSpanId && { parentSpanId: input.parentSpanId }),
    ...(input.traceId && { flags: 0 }),
  };
}

// ── Resource ────────────────────────────────────────────────────────

const __pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
let cachedResource: OtlpKeyValue[] | undefined;

function serviceVersion(): string {
  try {
    return JSON.parse(readFileSync(path.join(__pkgRoot, "package.json"), "utf-8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * `service.instance.id` is a per-process id, not a stable per-install one:
 * stable would need a file under the data dir, which an agent (same OS user)
 * can read and copy anyway, so it would add no authenticity. drawlatch's
 * server-stamped caller is the identity; this only tells restarts apart.
 */
const INSTANCE_ID = randomBytes(8).toString("hex");

function resourceAttributes(): OtlpKeyValue[] {
  cachedResource ??= encodeAttributes({
    "service.name": "callboard",
    "service.version": serviceVersion(),
    "service.instance.id": INSTANCE_ID,
    "host.name": hostname(),
  });
  return cachedResource;
}

// ── State ───────────────────────────────────────────────────────────

interface QueuedRecord {
  alias: string;
  timeMs: number;
  build: () => AuditRecordInput;
}

type DropReason = "overflow" | "send_failed" | "build_failed" | "rejected" | "hub_unsupported";

interface DropTally {
  count: number;
  reasons: Partial<Record<DropReason, number>>;
  firstMs: number;
  lastMs: number;
}

interface AliasState {
  /** While set and in the future, the hub lacks ingest_logs: records are dropped, not queued. */
  disabledUntil: number;
  /** "Unknown tool" already logged at info for this alias; re-probe failures log at debug. */
  loggedUnsupported: boolean;
  dropped: DropTally | null;
}

const queue: QueuedRecord[] = [];
const aliases = new Map<string, AliasState>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let stopped = false;

export interface AuditLogDeps {
  getProxy: (alias: string) => ProxyLike | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultDeps: AuditLogDeps = {
  // Looked up per call, not captured at import: a test that mocks
  // proxy-singleton without `getProxy` must still be able to import this.
  getProxy: (alias) => getProxy(alias),
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
};
let deps: AuditLogDeps = defaultDeps;

/** Off when `CALLBOARD_AUDIT_LOG` is `0`/`off`/`false`. Read per emit, so tests and a restart both see it. */
export function isAuditLogEnabled(): boolean {
  const v = process.env.CALLBOARD_AUDIT_LOG?.trim().toLowerCase();
  return !(v === "0" || v === "off" || v === "false");
}

function aliasState(alias: string): AliasState {
  let s = aliases.get(alias);
  if (!s) {
    s = { disabledUntil: 0, loggedUnsupported: false, dropped: null };
    aliases.set(alias, s);
  }
  return s;
}

function countDropped(alias: string, reason: DropReason, n: number, atMs: number): void {
  if (n <= 0) return;
  const s = aliasState(alias);
  const d = (s.dropped ??= { count: 0, reasons: {}, firstMs: atMs, lastMs: atMs });
  d.count += n;
  d.reasons[reason] = (d.reasons[reason] ?? 0) + n;
  d.firstMs = Math.min(d.firstMs, atMs);
  d.lastMs = Math.max(d.lastMs, atMs);
}

// ── Emit ────────────────────────────────────────────────────────────

/**
 * Queue one record for `alias`. Synchronous, O(1), never throws, never awaits.
 * `build` runs later, at flush time; put anything costly in it.
 *
 * A record with no alias (no drawlatch caller for this chat) is not queued:
 * there is nowhere to send it, so it is not "lost" either.
 */
export function emitAuditRecord(alias: string | undefined, build: () => AuditRecordInput): void {
  try {
    if (!alias || stopped || !isAuditLogEnabled()) return;
    const now = deps.now();
    const s = aliasState(alias);
    if (s.disabledUntil > now) {
      countDropped(alias, "hub_unsupported", 1, now);
      return;
    }
    if (queue.length >= MAX_QUEUE) {
      // Drop the NEW record, not the oldest: the gap is then one contiguous
      // window at the tail, which is what the dropped record's window claims.
      countDropped(alias, "overflow", 1, now);
      return;
    }
    queue.push({ alias, timeMs: now, build });
    scheduleFlush(FLUSH_INTERVAL_MS);
  } catch (err) {
    // Never into the caller. Log only: there is no alias state to count into if this threw.
    try {
      log.warn(`emitAuditRecord failed: ${err}`);
    } catch {
      /* ignore */
    }
  }
}

function scheduleFlush(delay: number): void {
  if (flushTimer || inFlight || stopped) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void runFlush();
  }, delay);
  flushTimer.unref?.();
}

// ── Flush ───────────────────────────────────────────────────────────

function runFlush(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      await flushAll();
    } catch (err) {
      log.warn(`audit flush failed: ${err}`);
    } finally {
      inFlight = null;
      if (queue.length > 0) scheduleFlush(FLUSH_INTERVAL_MS);
    }
  })();
  return inFlight;
}

/** Send everything queued, one alias at a time, in batches. */
async function flushAll(): Promise<void> {
  while (queue.length > 0) {
    const alias = queue[0].alias;
    const now = deps.now();
    const s = aliasState(alias);
    // Disabled since these were queued: count them, keep the rest moving.
    if (s.disabledUntil > now) {
      const n = takeForAlias(alias, Infinity).length;
      countDropped(alias, "hub_unsupported", n, now);
      continue;
    }
    const taken = takeForAlias(alias, MAX_BATCH);
    await sendBatch(alias, taken);
  }
}

/** Remove up to `max` records for `alias` from the queue, preserving order. */
function takeForAlias(alias: string, max: number): QueuedRecord[] {
  const taken: QueuedRecord[] = [];
  for (let i = 0; i < queue.length && taken.length < max; ) {
    if (queue[i].alias === alias) taken.push(...queue.splice(i, 1));
    else i++;
  }
  return taken;
}

function buildRecords(alias: string, taken: QueuedRecord[], observedMs: number): OtlpLogRecord[] {
  const records: OtlpLogRecord[] = [];
  let bytes = 0;
  for (let i = 0; i < taken.length; i++) {
    let record: OtlpLogRecord;
    try {
      record = toOtlpRecord(taken[i].build(), taken[i].timeMs, observedMs);
    } catch (err) {
      log.warn(`audit record for ${alias} could not be built: ${err}`);
      countDropped(alias, "build_failed", 1, taken[i].timeMs);
      continue;
    }
    const size = JSON.stringify(record).length;
    if (records.length > 0 && bytes + size > MAX_BATCH_BYTES) {
      // Over budget: put the rest back at the head for the next batch.
      queue.unshift(...taken.slice(i));
      break;
    }
    bytes += size;
    records.push(record);
  }
  return records;
}

function droppedRecord(d: DropTally, observedMs: number): OtlpLogRecord {
  const attributes: Record<string, AttrValue> = {
    "callboard.audit.dropped.count": d.count,
    "callboard.audit.dropped.window_start_unix_ms": d.firstMs,
    "callboard.audit.dropped.window_end_unix_ms": d.lastMs,
  };
  for (const [reason, n] of Object.entries(d.reasons)) attributes[`callboard.audit.dropped.${reason}`] = n;
  return toOtlpRecord(
    {
      eventName: AUDIT_DROPPED_EVENT,
      severity: "WARN",
      body: `callboard dropped ${d.count} audit record(s) between ${new Date(d.firstMs).toISOString()} and ${new Date(d.lastMs).toISOString()}`,
      attributes,
    },
    observedMs,
    observedMs,
  );
}

function isUnsupported(err: unknown): boolean {
  return err instanceof Error && err.message === "Unknown tool: ingest_logs";
}

function rejectedCount(result: unknown): { rejected: number; message?: string } {
  if (!result || typeof result !== "object") return { rejected: 0 };
  const partial = (result as { partialSuccess?: { rejectedLogRecords?: unknown; errorMessage?: unknown } }).partialSuccess;
  if (!partial || typeof partial !== "object") return { rejected: 0 };
  const n = Number(partial.rejectedLogRecords);
  return { rejected: Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0, ...(typeof partial.errorMessage === "string" && { message: partial.errorMessage }) };
}

async function sendBatch(alias: string, taken: QueuedRecord[]): Promise<void> {
  const observedMs = deps.now();
  const records = buildRecords(alias, taken, observedMs);
  const s = aliasState(alias);
  // The dropped tally travels with this batch; it is cleared only on success.
  const dropped = s.dropped;
  if (records.length === 0 && !dropped) return;
  const sentRecords = dropped ? [droppedRecord(dropped, observedMs), ...records] : records;
  const body: IngestLogsInput = {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes() },
        scopeLogs: [{ scope: { name: AUDIT_SCOPE_NAME, version: "1" }, logRecords: sentRecords }],
      },
    ],
  };

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    const proxy = safeGetProxy(alias);
    let err: unknown;
    if (proxy) {
      try {
        const result = await proxy.callTool("ingest_logs", body as unknown as Record<string, unknown>, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
        // Success. Anything counted while this was in flight stays for the next batch.
        if (dropped && s.dropped === dropped) s.dropped = null;
        else if (dropped && s.dropped) subtractTally(s.dropped, dropped);
        if (s.loggedUnsupported) {
          log.info(`[${alias}] drawlatch accepts ingest_logs again — audit log re-enabled`);
          s.loggedUnsupported = false;
        }
        const { rejected, message } = rejectedCount(result);
        if (rejected > 0) {
          log.warn(`[${alias}] drawlatch rejected ${rejected} audit record(s): ${message ?? "no reason given"}`);
          countDropped(alias, "rejected", rejected, observedMs);
        }
        return;
      } catch (e) {
        err = e;
      }
    } else {
      err = new Error(`no drawlatch client for caller "${alias}"`);
    }

    if (isUnsupported(err)) {
      s.disabledUntil = deps.now() + REPROBE_INTERVAL_MS;
      if (!s.loggedUnsupported) {
        log.info(`[${alias}] drawlatch has no ingest_logs — audit log disabled for this caller, re-probing every ${REPROBE_INTERVAL_MS / 60_000} min`);
        s.loggedUnsupported = true;
      } else {
        log.debug(`[${alias}] re-probe: drawlatch still has no ingest_logs`);
      }
      countDropped(alias, "hub_unsupported", records.length, observedMs);
      return;
    }
    if (attempt === MAX_SEND_ATTEMPTS || stopped) {
      log.warn(`[${alias}] audit batch of ${records.length} record(s) dropped after ${attempt} attempt(s): ${err instanceof Error ? err.message : String(err)}`);
      countDropped(alias, "send_failed", records.length, observedMs);
      return;
    }
    log.debug(`[${alias}] audit send failed (attempt ${attempt}/${MAX_SEND_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`);
    await deps.sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
  }
}

function subtractTally(current: DropTally, sent: DropTally): void {
  current.count -= sent.count;
  for (const [reason, n] of Object.entries(sent.reasons) as [DropReason, number][]) {
    current.reasons[reason] = (current.reasons[reason] ?? 0) - n;
    if (!current.reasons[reason]) delete current.reasons[reason];
  }
}

function safeGetProxy(alias: string): ProxyLike | null {
  try {
    return deps.getProxy(alias);
  } catch {
    return null;
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────

/**
 * Best-effort flush for shutdown: send what is queued, but give up after
 * `timeoutMs`. Never throws. Further emits are ignored afterwards.
 */
export async function shutdownAuditLog(timeoutMs = 3000): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const pending = queue.length;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const flushed = (async () => {
      // An in-flight flush may be sleeping on a backoff; mark stopped so its
      // next failure drops instead of retrying, then drain what is left.
      stopped = true;
      if (inFlight) await inFlight;
      if (queue.length > 0) await runFlush();
    })();
    const timedOut = await Promise.race([flushed.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), timeoutMs)))]);
    if (timedOut) log.warn(`audit log shutdown: gave up after ${timeoutMs}ms with ${queue.length} record(s) unsent`);
    else if (pending > 0) log.info(`audit log shutdown: flushed ${pending} queued record(s)`);
  } catch (err) {
    log.warn(`audit log shutdown flush failed: ${err}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Flush now and wait for it. For tests and the shutdown path. */
export async function flushAuditLog(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (inFlight) await inFlight;
  if (queue.length > 0) await runFlush();
}

/** Test-only: reset all state and swap the dependencies. */
export function __resetAuditLogForTests(overrides: Partial<AuditLogDeps> = {}): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  inFlight = null;
  stopped = false;
  queue.length = 0;
  aliases.clear();
  cachedResource = undefined;
  deps = { ...defaultDeps, ...overrides };
}

/** Test-only: queue length. */
export const __auditQueueLength = (): number => queue.length;
