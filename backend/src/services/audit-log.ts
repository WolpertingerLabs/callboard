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
 * count as dropped, per caller alias. A `callboard.audit.dropped` record then
 * reports the counts and the window, so a gap shows up in drawlatch, not just
 * in callboard's own (agent-writable) log.
 *
 * That report goes in its OWN `ingest_logs` call. drawlatch refuses records
 * one by one (a per-caller byte budget) and only says how many, so a report
 * riding in a batch could be refused while the call "succeeds". Alone, a
 * refusal is unambiguous: the counts stay and the same report — same ids, so a
 * reader can dedupe a retried one — is retried with backoff until it is
 * stored. Losses counted meanwhile wait for the next report; reports never
 * overlap. A refused report is not itself counted as a loss.
 *
 * ## Old hubs
 *
 * A hub without the tool answers "Unknown tool: ingest_logs" — same as the
 * `wait_for_events` fallback in event-watcher.ts. The alias is then disabled
 * for {@link REPROBE_INTERVAL_MS}; records emitted meanwhile are counted as
 * dropped rather than queued; after the interval the loss report (or the next
 * batch, whichever comes first) is the re-probe. Logged once, not per batch.
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
/**
 * Send attempts for one batch before it is dropped. ProxyClient already
 * retries transport errors inside each. Five attempts wait 2+4+8+16 = 30 s in
 * all — longer than a drawlatch restart (its stop can take ~15 s, answering
 * "server shutting down; retry after restart" meanwhile), so a normal hub
 * restart is not a loss.
 */
export const MAX_SEND_ATTEMPTS = 5;
/** Backoff before attempt n+1 is BASE * 2^(n-1): 2s, 4s, 8s, 16s. */
export const RETRY_BASE_MS = 2000;
/** Loss-report attempts per alias in one run (a guard against a spin, not a policy). */
const MAX_REPORTS_PER_FLUSH = 4;
/** A loss report is never given up on; its retry backoff stops growing here. */
export const MAX_REPORT_BACKOFF_MS = 60_000;
/** One `ingest_logs` call may not take longer than this. */
export const SEND_TIMEOUT_MS = 15_000;
/** How long an alias whose hub lacks `ingest_logs` stays disabled before it is re-probed. */
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
  /**
   * When the event happened (ms since epoch). Defaults to when it was queued.
   * A caller that hands records over asynchronously sets it so the record
   * carries the decision's time, not the hand-over's.
   */
  timeMs?: number;
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

/** When the lost records were emitted. */
interface DropWindow {
  firstMs: number;
  lastMs: number;
}

interface DropTally extends DropWindow {
  count: number;
  reasons: Partial<Record<DropReason, number>>;
  /**
   * The window of drops counted since the in-flight batch snapshotted this
   * tally. When that batch succeeds and its snapshot is subtracted, whatever
   * count remains was counted in exactly this window.
   */
  sinceSnapshot: DropWindow | null;
}

/** The counts one batch reports — frozen when the batch is built. */
type DropSnapshot = Pick<DropTally, "count" | "reasons" | "firstMs" | "lastMs">;

/** A loss report in flight or awaiting retry. Its counts are fixed; its ids are reused on every retry. */
interface PendingReport {
  snapshot: DropSnapshot;
  traceId: string;
  spanId: string;
  attempts: number;
  retryAt: number;
}

interface AliasState {
  /** While set and in the future, the hub lacks ingest_logs: records are dropped, not queued. */
  disabledUntil: number;
  /** "Unknown tool" already logged at info for this alias; re-probe failures log at debug. */
  loggedUnsupported: boolean;
  dropped: DropTally | null;
  report: PendingReport | null;
}

const queue: QueuedRecord[] = [];
const aliases = new Map<string, AliasState>();
/** The DATA flush timer: armed only for queued records, always at the flush interval. */
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
/**
 * Loss reports run on their own timer and their own per-alias chains, so a
 * report backing off (up to a minute) or hanging never holds a data flush —
 * of its own caller or any other.
 */
let reportTimer: ReturnType<typeof setTimeout> | null = null;
let reportTimerDue = Infinity;
const reportChains = new Map<string, Promise<void>>();
let stopped = false;
/** Set when shutdownAuditLog returns: from then on no send or report attempt starts. */
let closed = false;
/** Records in the batch being sent right now (for the shutdown "unsent" count). */
let inFlightRecords = 0;

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
    s = { disabledUntil: 0, loggedUnsupported: false, dropped: null, report: null };
    aliases.set(alias, s);
  }
  return s;
}

/** Count `n` lost records for `alias`, emitted between `firstMs` and `lastMs`. */
function countDropped(alias: string, reason: DropReason, n: number, firstMs: number, lastMs = firstMs): void {
  if (n <= 0) return;
  const s = aliasState(alias);
  const d = (s.dropped ??= { count: 0, reasons: {}, firstMs, lastMs, sinceSnapshot: null });
  d.count += n;
  d.reasons[reason] = (d.reasons[reason] ?? 0) + n;
  d.firstMs = Math.min(d.firstMs, firstMs);
  d.lastMs = Math.max(d.lastMs, lastMs);
  d.sinceSnapshot = d.sinceSnapshot ? { firstMs: Math.min(d.sinceSnapshot.firstMs, firstMs), lastMs: Math.max(d.sinceSnapshot.lastMs, lastMs) } : { firstMs, lastMs };
  scheduleReports();
}

/** Freeze the counts a batch reports, and start tracking what is counted after. */
function snapshotDropped(s: AliasState): DropSnapshot | null {
  const d = s.dropped;
  if (!d) return null;
  d.sinceSnapshot = null;
  return { count: d.count, reasons: { ...d.reasons }, firstMs: d.firstMs, lastMs: d.lastMs };
}

/**
 * The batch carrying `sent` was stored: subtract exactly those counts. Any
 * remainder was counted while the batch was in flight, so its window is
 * `sinceSnapshot`.
 */
function settleDropped(s: AliasState, sent: DropSnapshot): void {
  const d = s.dropped;
  if (!d) return;
  d.count -= sent.count;
  for (const [reason, n] of Object.entries(sent.reasons) as [DropReason, number][]) {
    const left = (d.reasons[reason] ?? 0) - n;
    if (left > 0) d.reasons[reason] = left;
    else delete d.reasons[reason];
  }
  if (d.count <= 0) {
    s.dropped = null;
    return;
  }
  if (d.sinceSnapshot) {
    d.firstMs = d.sinceSnapshot.firstMs;
    d.lastMs = d.sinceSnapshot.lastMs;
  }
}

/** Earliest and latest emit time of some queued records. */
function windowOf(records: readonly { timeMs: number }[]): DropWindow {
  let firstMs = Infinity;
  let lastMs = -Infinity;
  for (const r of records) {
    firstMs = Math.min(firstMs, r.timeMs);
    lastMs = Math.max(lastMs, r.timeMs);
  }
  return { firstMs, lastMs };
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

/** Send everything queued, one alias at a time, in batches. Audit records only — loss reports run separately. */
async function flushAll(): Promise<void> {
  while (queue.length > 0) {
    const alias = queue[0].alias;
    const now = deps.now();
    const s = aliasState(alias);
    // Disabled since these were queued: count them, keep the rest moving.
    if (s.disabledUntil > now) {
      const lost = takeForAlias(alias, Infinity);
      const w = windowOf(lost);
      countDropped(alias, "hub_unsupported", lost.length, w.firstMs, w.lastMs);
      continue;
    }
    const taken = takeForAlias(alias, MAX_BATCH);
    await sendBatch(alias, taken);
  }
}

// ── Loss reports ────────────────────────────────────────────────────

/**
 * When this alias's report may next be attempted: a new report at once (the
 * timer fires after the current tick, so a burst of losses is one report), a
 * pending one after its backoff. Once shutting down, backoff is ignored: this
 * is the last try.
 */
function reportDueAt(s: AliasState): number {
  if (!s.dropped) return Infinity;
  const wait = stopped || !s.report ? 0 : s.report.retryAt;
  return Math.max(s.disabledUntil, wait);
}

/** Arm the report timer for the earliest due report not already being sent. */
function scheduleReports(): void {
  if (stopped) return;
  let next = Infinity;
  for (const [alias, s] of aliases) if (!reportChains.has(alias)) next = Math.min(next, reportDueAt(s));
  if (next === Infinity || next >= reportTimerDue) return;
  if (reportTimer) clearTimeout(reportTimer);
  reportTimerDue = next;
  reportTimer = setTimeout(
    () => {
      reportTimer = null;
      reportTimerDue = Infinity;
      void runReports();
    },
    Math.max(0, next - deps.now()),
  );
  reportTimer.unref?.();
}

/**
 * Start a report chain for every alias whose report is due, and wait for all
 * chains (new and already running). Each chain is one alias, sequential: one
 * report outstanding per alias, and a slow alias never holds another.
 */
function runReports(): Promise<void> {
  for (const [alias, s] of aliases) {
    if (reportChains.has(alias) || reportDueAt(s) > deps.now()) continue;
    const chain = (async () => {
      try {
        // A settled report can leave a remainder (counted while it was out),
        // due at once. Each attempt settles or backs off, so the cap only
        // turns a spin — if that ever stopped holding — into a deferred retry.
        // Once shutdown begins, at most one attempt STARTS (the last try); one
        // already out may finish. Once it has returned, none starts at all.
        let startedAfterStop = false;
        for (let n = 0; n < MAX_REPORTS_PER_FLUSH && reportDueAt(s) <= deps.now(); n++) {
          if (closed || (stopped && startedAfterStop)) break;
          if (stopped) startedAfterStop = true;
          await reportDropped(alias, s);
        }
      } catch (err) {
        log.warn(`[${alias}] loss report failed: ${err}`);
      } finally {
        reportChains.delete(alias);
        scheduleReports();
      }
    })();
    reportChains.set(alias, chain);
  }
  // Re-arm for whatever is not running now. The timer can fire with nothing
  // due — the alias was disabled after it was set, or the wall clock stepped
  // back (setTimeout is monotonic, Date.now is not) — and must not strand a
  // report until some new loss happens to schedule one.
  scheduleReports();
  return Promise.all(reportChains.values()).then(() => undefined);
}

/**
 * Send this alias's loss report in its own call. Settles (subtracts its
 * snapshot) only when drawlatch stored it — no error and no rejected record.
 * Otherwise keeps it for a retry with backoff. Never counts a loss itself.
 */
async function reportDropped(alias: string, s: AliasState): Promise<void> {
  if (!s.report) {
    const snapshot = snapshotDropped(s);
    if (!snapshot) return;
    s.report = { snapshot, traceId: newTraceId(), spanId: newSpanId(), attempts: 0, retryAt: 0 };
  }
  const report = s.report;
  const observedMs = deps.now();
  let failure: string | undefined;
  try {
    const proxy = safeGetProxy(alias);
    if (!proxy) throw new Error(`no drawlatch client for caller "${alias}"`);
    const result = await proxy.callTool("ingest_logs", ingestBody([droppedRecord(report.snapshot, observedMs, report)]) as unknown as Record<string, unknown>, {
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const { rejected, message } = rejectedCount(result);
    if (rejected === 0) {
      settleDropped(s, report.snapshot);
      s.report = null;
      noteSupported(alias, s);
      return;
    }
    failure = `refused: ${message ?? "no reason given"}`;
  } catch (err) {
    if (isUnsupported(err)) {
      markUnsupported(alias, s);
      return; // kept; retried (as the re-probe) once the interval is over
    }
    failure = err instanceof Error ? err.message : String(err);
  }
  report.attempts++;
  report.retryAt = deps.now() + Math.min(RETRY_BASE_MS * 2 ** (report.attempts - 1), MAX_REPORT_BACKOFF_MS);
  const line = `[${alias}] loss report (${report.snapshot.count} record(s)) not stored, attempt ${report.attempts} — kept for retry: ${failure}`;
  if (report.attempts === 1) log.warn(line);
  else log.debug(line);
}

function ingestBody(records: OtlpLogRecord[]): IngestLogsInput {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes() },
        scopeLogs: [{ scope: { name: AUDIT_SCOPE_NAME, version: "1" }, logRecords: records }],
      },
    ],
  };
}

function noteSupported(alias: string, s: AliasState): void {
  if (s.loggedUnsupported) {
    log.info(`[${alias}] drawlatch accepts ingest_logs again — audit log re-enabled`);
    s.loggedUnsupported = false;
  }
}

function markUnsupported(alias: string, s: AliasState): void {
  s.disabledUntil = deps.now() + REPROBE_INTERVAL_MS;
  if (!s.loggedUnsupported) {
    log.info(`[${alias}] drawlatch has no ingest_logs — audit log disabled for this caller, re-probing every ${REPROBE_INTERVAL_MS / 60_000} min`);
    s.loggedUnsupported = true;
  } else {
    log.debug(`[${alias}] re-probe: drawlatch still has no ingest_logs`);
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

/** Build the batch's records. Each comes back with its event time, for loss windows. */
function buildRecords(alias: string, taken: QueuedRecord[], observedMs: number): { record: OtlpLogRecord; timeMs: number }[] {
  const records: { record: OtlpLogRecord; timeMs: number }[] = [];
  let bytes = 0;
  for (let i = 0; i < taken.length; i++) {
    let record: OtlpLogRecord;
    let timeMs = taken[i].timeMs;
    try {
      const input = taken[i].build();
      if (typeof input.timeMs === "number" && Number.isFinite(input.timeMs)) timeMs = input.timeMs;
      record = toOtlpRecord(input, timeMs, observedMs);
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
    records.push({ record, timeMs });
  }
  return records;
}

function droppedRecord(d: DropSnapshot, observedMs: number, ids: { traceId: string; spanId: string }): OtlpLogRecord {
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
      // Stable across retries of this report: a reader dedupes on spanId.
      traceId: ids.traceId,
      spanId: ids.spanId,
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
  inFlightRecords = taken.length;
  try {
    await sendBuiltBatch(alias, taken);
  } finally {
    inFlightRecords = 0;
  }
}

async function sendBuiltBatch(alias: string, taken: QueuedRecord[]): Promise<void> {
  const observedMs = deps.now();
  const built = buildRecords(alias, taken, observedMs);
  const records = built.map((b) => b.record);
  // When this batch's records were emitted: the loss window if it is lost.
  const batchWindow = windowOf(built);
  const s = aliasState(alias);
  // Audit records only: losses are reported in their own call (reportDropped),
  // so every `rejected` counted below is an audit record, never the report.
  if (records.length === 0) return;
  const body = ingestBody(records);

  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    const proxy = safeGetProxy(alias);
    let err: unknown;
    if (proxy) {
      try {
        const result = await proxy.callTool("ingest_logs", body as unknown as Record<string, unknown>, { signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
        noteSupported(alias, s);
        const { rejected, message } = rejectedCount(result);
        if (rejected > 0) {
          log.warn(`[${alias}] drawlatch rejected ${rejected} audit record(s): ${message ?? "no reason given"}`);
          // drawlatch does not say which ones, so the window is the whole batch's.
          countDropped(alias, "rejected", rejected, batchWindow.firstMs, batchWindow.lastMs);
        }
        return;
      } catch (e) {
        err = e;
      }
    } else {
      err = new Error(`no drawlatch client for caller "${alias}"`);
    }

    if (isUnsupported(err)) {
      markUnsupported(alias, s);
      countDropped(alias, "hub_unsupported", records.length, batchWindow.firstMs, batchWindow.lastMs);
      return;
    }
    if (attempt === MAX_SEND_ATTEMPTS || stopped) {
      log.warn(`[${alias}] audit batch of ${records.length} record(s) dropped after ${attempt} attempt(s): ${err instanceof Error ? err.message : String(err)}`);
      countDropped(alias, "send_failed", records.length, batchWindow.firstMs, batchWindow.lastMs);
      return;
    }
    log.debug(`[${alias}] audit send failed (attempt ${attempt}/${MAX_SEND_ATTEMPTS}): ${err instanceof Error ? err.message : String(err)}`);
    await deps.sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
    if (closed) {
      // Shutdown returned while this batch slept: start nothing more.
      countDropped(alias, "send_failed", records.length, batchWindow.firstMs, batchWindow.lastMs);
      return;
    }
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
  clearReportTimer();
  const pending = queue.length;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const flushed = (async () => {
      // An in-flight flush may be sleeping on a backoff; mark stopped so its
      // next failure drops instead of retrying, then drain what is left.
      stopped = true;
      if (inFlight) await inFlight;
      await runFlush();
      // A pending loss report gets its last try, backoff or not (reportDueAt).
      await runReports();
    })();
    const timedOut = await Promise.race([flushed.then(() => false), new Promise<boolean>((r) => (timer = setTimeout(() => r(true), timeoutMs)))]);
    if (timedOut) log.warn(`audit log shutdown: gave up after ${timeoutMs}ms with ${unsentCount()} record(s) unsent`);
    else if (pending > 0) log.info(`audit log shutdown: flushed ${pending} queued record(s)`);
  } catch (err) {
    log.warn(`audit log shutdown flush failed: ${err}`);
  } finally {
    if (timer) clearTimeout(timer);
    closed = true;
  }
}

/** Records not yet stored: queued, plus the batch being sent. */
export function unsentCount(): number {
  return queue.length + inFlightRecords;
}

/** Flush now and wait for it. For tests and the shutdown path. */
export async function flushAuditLog(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (inFlight) await inFlight;
  await runFlush();
  // Reports that are due; one backing off keeps its backoff.
  await runReports();
}

function clearReportTimer(): void {
  if (reportTimer) clearTimeout(reportTimer);
  reportTimer = null;
  reportTimerDue = Infinity;
}

/** Test-only: reset all state and swap the dependencies. */
export function __resetAuditLogForTests(overrides: Partial<AuditLogDeps> = {}): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  clearReportTimer();
  reportChains.clear();
  inFlight = null;
  inFlightRecords = 0;
  stopped = false;
  closed = false;
  queue.length = 0;
  aliases.clear();
  cachedResource = undefined;
  deps = { ...defaultDeps, ...overrides };
}

/** Test-only: which of this module's timers are armed. */
export const __auditTimersArmed = (): { flush: boolean; report: boolean } => ({ flush: flushTimer !== null, report: reportTimer !== null });

/** Test-only: queue length. */
export const __auditQueueLength = (): number => queue.length;
