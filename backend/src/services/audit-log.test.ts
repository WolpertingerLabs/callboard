/**
 * audit-log.ts: the bounded queue, batched flush, retry with backoff, the
 * `callboard.audit.dropped` record, the old-hub fallback and the shutdown
 * flush — all against a fake ProxyLike.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __auditQueueLength,
  __resetAuditLogForTests,
  AUDIT_DROPPED_EVENT,
  AUDIT_SCOPE_NAME,
  emitAuditRecord,
  encodeAttributes,
  flushAuditLog,
  MAX_BATCH,
  FLUSH_INTERVAL_MS,
  MAX_QUEUE,
  MAX_REPORT_BACKOFF_MS,
  MAX_SEND_ATTEMPTS,
  MAX_STRING_BYTES,
  REPROBE_INTERVAL_MS,
  RETRY_BASE_MS,
  shutdownAuditLog,
  truncateUtf8,
  unsentCount,
  type AuditRecordInput,
  type IngestLogsInput,
  type OtlpLogRecord,
} from "./audit-log.js";

/** drawlatch's allowed keys (strict: anything else rejects the record). */
const LOG_RECORD_KEYS = new Set(["timeUnixNano", "observedTimeUnixNano", "severityNumber", "severityText", "eventName", "body", "attributes", "droppedAttributesCount", "flags", "traceId", "spanId", "parentSpanId"]);

const rec = (n: number, extra: Partial<AuditRecordInput> = {}): (() => AuditRecordInput) => () => ({
  eventName: "test.event",
  severity: "INFO",
  body: `record ${n}`,
  attributes: { n },
  ...extra,
});

let now = 1_760_000_000_000;
const sleep = vi.fn(async (_ms: number) => {});

function fakeProxy(impl: (input: IngestLogsInput) => Promise<unknown>) {
  const calls: IngestLogsInput[] = [];
  const callTool = vi.fn(async (tool: string, input?: Record<string, unknown>) => {
    expect(tool).toBe("ingest_logs");
    calls.push(input as unknown as IngestLogsInput);
    return impl(input as unknown as IngestLogsInput);
  });
  return { calls, callTool, proxy: { callTool } };
}

const recordsOf = (input: IngestLogsInput): OtlpLogRecord[] => input.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords));
/** Loss reports go in their own calls; these split a hub's traffic accordingly. */
const isReportCall = (input: IngestLogsInput) => recordsOf(input).some((r) => r.eventName === AUDIT_DROPPED_EVENT);
const reportsIn = (calls: IngestLogsInput[]) => calls.flatMap(recordsOf).filter((r) => r.eventName === AUDIT_DROPPED_EVENT);
const dataCalls = (calls: IngestLogsInput[]) => calls.filter((c) => !isReportCall(c));
/** Sum of every dropped count drawlatch received, per reason. */
function deliveredDropsOf(calls: IngestLogsInput[]): Record<string, number> {
  const out: Record<string, number> = {};
  // Deduped by spanId, as a reader would: a retried report reuses its ids.
  const seen = new Set<string>();
  for (const r of calls.flatMap(recordsOf).filter((x) => x.eventName === AUDIT_DROPPED_EVENT)) {
    if (r.spanId && seen.has(r.spanId)) continue;
    if (r.spanId) seen.add(r.spanId);
    for (const a of r.attributes) {
      const m = /^callboard\.audit\.dropped\.(count|overflow|send_failed|build_failed|rejected|hub_unsupported)$/.exec(a.key);
      if (m) out[m[1]] = (out[m[1]] ?? 0) + Number((a.value as { intValue: string }).intValue);
    }
  }
  return out;
}

/** Sum of the loss reports a hub stored (deduped by spanId). */
const storedDropsIn = (stored: OtlpLogRecord[]) =>
  deliveredDropsOf([{ resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ scope: { name: "", version: "" }, logRecords: stored }] }] }]);

/** Let any report backoff expire, then flush. */
async function flushAfterBackoff() {
  now += MAX_REPORT_BACKOFF_MS;
  await flushAuditLog();
}
const attr = (r: OtlpLogRecord, key: string) => r.attributes.find((a) => a.key === key)?.value;

function setup(impl: (input: IngestLogsInput) => Promise<unknown> = async () => ({})) {
  const fake = fakeProxy(impl);
  __resetAuditLogForTests({ getProxy: () => fake.proxy, now: () => now, sleep });
  return fake;
}

beforeEach(() => {
  now = 1_760_000_000_000;
  sleep.mockClear();
  delete process.env.CALLBOARD_AUDIT_LOG;
});
afterEach(() => {
  __resetAuditLogForTests();
  delete process.env.CALLBOARD_AUDIT_LOG;
});

describe("wire shape", () => {
  it("sends one OTLP ExportLogsServiceRequest per alias batch, with only keys drawlatch accepts", async () => {
    const { calls } = setup();
    emitAuditRecord("alice", rec(1, { traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: "c".repeat(16) }));
    emitAuditRecord("alice", rec(2));
    await flushAuditLog();
    expect(calls).toHaveLength(1);
    const [req] = calls;
    expect(Object.keys(req)).toEqual(["resourceLogs"]);
    expect(req.resourceLogs).toHaveLength(1);
    const resource = req.resourceLogs[0].resource;
    expect(Object.keys(resource)).toEqual(["attributes"]);
    expect(resource.attributes.map((a) => a.key).sort()).toEqual(["host.name", "service.instance.id", "service.name", "service.version"]);
    expect(resource.attributes.find((a) => a.key === "service.name")!.value).toEqual({ stringValue: "callboard" });
    expect(req.resourceLogs[0].scopeLogs[0].scope).toEqual({ name: AUDIT_SCOPE_NAME, version: "1" });

    const [first, second] = recordsOf(req);
    for (const r of [first, second]) for (const k of Object.keys(r)) expect(LOG_RECORD_KEYS.has(k)).toBe(true);
    expect(first).toMatchObject({
      timeUnixNano: `${now}000000`,
      observedTimeUnixNano: `${now}000000`,
      severityNumber: 9,
      severityText: "INFO",
      eventName: "test.event",
      body: { stringValue: "record 1" },
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      parentSpanId: "c".repeat(16),
      flags: 0,
    });
    expect(attr(first, "n")).toEqual({ intValue: "1" });
    expect(second).not.toHaveProperty("traceId");
    expect(second).not.toHaveProperty("parentSpanId");
  });

  it("encodes attribute types per OTLP/JSON and omits null/undefined", () => {
    expect(encodeAttributes({ s: "x", i: 42, d: 1.5, b: false, n: null, u: undefined, nan: Number.NaN })).toEqual([
      { key: "s", value: { stringValue: "x" } },
      { key: "i", value: { intValue: "42" } },
      { key: "d", value: { doubleValue: 1.5 } },
      { key: "b", value: { boolValue: false } },
    ]);
  });

  it("truncates strings to drawlatch's limit without splitting a character", () => {
    const long = "é".repeat(MAX_STRING_BYTES); // 2 bytes each
    const { value, truncated } = truncateUtf8(long);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(MAX_STRING_BYTES);
    expect(value.endsWith("�")).toBe(false);
    expect(truncateUtf8("short")).toEqual({ value: "short", truncated: false });
  });

  it("batches per alias and caps records per call", async () => {
    const { calls } = setup();
    for (let i = 0; i < MAX_BATCH + 5; i++) emitAuditRecord("alice", rec(i));
    emitAuditRecord("bob", rec(999));
    await flushAuditLog();
    expect(calls.map((c) => recordsOf(c).length)).toEqual([MAX_BATCH, 5, 1]);
    expect(__auditQueueLength()).toBe(0);
  });

  it("does not queue without an alias, or when CALLBOARD_AUDIT_LOG=off", async () => {
    const { calls } = setup();
    emitAuditRecord(undefined, rec(1));
    process.env.CALLBOARD_AUDIT_LOG = "off";
    emitAuditRecord("alice", rec(2));
    expect(__auditQueueLength()).toBe(0);
    await flushAuditLog();
    expect(calls).toHaveLength(0);
  });

  it("flushes on its own within the interval", async () => {
    vi.useFakeTimers();
    try {
      const { calls } = setup();
      emitAuditRecord("alice", rec(1));
      expect(calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("emit never throws and never blocks", () => {
  it("returns synchronously even when the hub never answers", () => {
    setup(() => new Promise(() => {}));
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) emitAuditRecord("alice", rec(i));
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("a record factory that throws is counted as dropped; the rest of the batch still goes", async () => {
    const { calls } = setup();
    emitAuditRecord("alice", () => {
      throw new Error("bad factory");
    });
    emitAuditRecord("alice", rec(2));
    await flushAuditLog();
    // The batch goes; the loss is reported in its own call right after.
    expect(recordsOf(calls[0]).map((r) => attr(r, "n"))).toEqual([{ intValue: "2" }]);
    const [dropped] = recordsOf(calls[1]);
    expect(dropped.eventName).toBe(AUDIT_DROPPED_EVENT);
    expect(attr(dropped, "callboard.audit.dropped.build_failed")).toEqual({ intValue: "1" });
  });
});

describe("loss is visible downstream", () => {

  it("drops counted while a tally-carrying batch is in flight survive that batch's success (review B1)", async () => {
    // 1. Hub down: the first batch exhausts its retries → send_failed=1 (its
    //    report fails too and backs off).
    // 2. Hub back but slow: the next batch hangs.
    // 3. Meanwhile the queue fills and 7 records overflow.
    // 4. The slow batch succeeds. All 8 losses must reach drawlatch.
    let mode: "down" | "slow" | "up" = "down";
    let releaseSlow!: () => void;
    const delivered: IngestLogsInput[] = [];
    setup(async (input) => {
      if (mode === "down") throw new Error("fetch failed");
      if (mode === "slow") await new Promise<void>((r) => (releaseSlow = r));
      delivered.push(input);
      return {};
    });
    emitAuditRecord("alice", rec(1));
    await flushAuditLog();

    mode = "slow";
    emitAuditRecord("alice", rec(2));
    const slowFlush = flushAuditLog();
    await vi.waitFor(() => expect(releaseSlow).toBeTypeOf("function"));
    for (let i = 0; i < MAX_QUEUE + 7; i++) emitAuditRecord("alice", rec(100 + i));
    expect(__auditQueueLength()).toBe(MAX_QUEUE);

    mode = "up";
    releaseSlow();
    await slowFlush;
    await flushAfterBackoff();

    expect(deliveredDropsOf(delivered)).toEqual({ count: 8, send_failed: 1, overflow: 7 });
    // ...and each loss is reported exactly once: nothing is left to report.
    emitAuditRecord("alice", rec(9999));
    await flushAuditLog();
    expect(recordsOf(delivered.at(-1)!).map((r) => r.eventName)).toEqual(["test.event"]);
  });

  /**
   * A hub whose byte budget refuses exactly the dropped (meta) record while
   * `refuseDropped` is set, and stores everything else — drawlatch#46 refuses
   * per record and does not say which (`partialSuccess` carries only a count).
   */
  function budgetHub() {
    const hub = { refuseDropped: true, stored: [] as OtlpLogRecord[] };
    const fake = setup(async (input) => {
      const records = recordsOf(input);
      const refused = hub.refuseDropped ? records.filter((r) => r.eventName === AUDIT_DROPPED_EVENT) : [];
      hub.stored.push(...records.filter((r) => !refused.includes(r)));
      return refused.length ? { partialSuccess: { rejectedLogRecords: refused.length, errorMessage: "rejected: audit byte budget exhausted for this caller; retry later" } } : {};
    });
    return { hub, ...fake };
  }

  function storedDrops(stored: OtlpLogRecord[]): Record<string, number> {
    return deliveredDropsOf([{ resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ scope: { name: "", version: "" }, logRecords: stored }] }] }]);
  }

  it("a dropped record the hub refuses keeps its counts until one is stored (review round 2, B1)", async () => {
    const { hub } = budgetHub();
    for (let i = 0; i < MAX_QUEUE + 7; i++) emitAuditRecord("alice", rec(i)); // 7 overflow
    await flushAuditLog();
    // Budget exhausted: the report was refused, the audit records were stored.
    expect(hub.stored.filter((r) => r.eventName === "test.event")).toHaveLength(MAX_QUEUE);
    expect(storedDrops(hub.stored)).toEqual({});

    // Budget refills; the next try lands with the original counts, exactly once.
    hub.refuseDropped = false;
    now += 10 * 60_000;
    emitAuditRecord("alice", rec(-1));
    await flushAuditLog();
    expect(storedDrops(hub.stored)).toEqual({ count: 7, overflow: 7 });
  });

  it("a loss report travels alone, keeps its ids across retries, and backs off between them", async () => {
    const { hub, calls } = budgetHub();
    for (let i = 0; i < MAX_QUEUE + 3; i++) emitAuditRecord("alice", rec(i)); // 3 overflow
    await flushAuditLog();
    const reportCalls = () => calls.filter(isReportCall);
    expect(reportCalls()).toHaveLength(1);
    for (const c of reportCalls()) expect(recordsOf(c)).toHaveLength(1); // nothing else in the call
    const [first] = reportsIn(calls);
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.spanId).toMatch(/^[0-9a-f]{16}$/);

    // Not retried before its backoff (2s), then retried with the SAME ids.
    now += RETRY_BASE_MS - 1;
    await flushAuditLog();
    expect(reportCalls()).toHaveLength(1);
    now += 1;
    await flushAuditLog();
    expect(reportCalls()).toHaveLength(2);
    now += RETRY_BASE_MS * 2; // the next backoff doubles
    await flushAuditLog();
    expect(reportCalls()).toHaveLength(3);
    const ids = reportsIn(calls).map((r) => `${r.traceId}/${r.spanId}`);
    expect(new Set(ids).size).toBe(1);

    hub.refuseDropped = false;
    await flushAfterBackoff();
    expect(storedDrops(hub.stored)).toEqual({ count: 3, overflow: 3 });
    expect(hub.stored.filter((r) => r.eventName === AUDIT_DROPPED_EVENT).map((r) => r.spanId)).toEqual([first.spanId]);
  });

  it("under sustained budget exhaustion, losses accumulate and are reported once it refills — counts and windows intact", async () => {
    const { hub } = budgetHub();
    const t0 = now;
    for (let i = 0; i < MAX_QUEUE + 2; i++) emitAuditRecord("alice", rec(i)); // 2 overflow at t0
    await flushAuditLog(); // report A (overflow=2) refused

    // Minutes of refusals; more losses keep arriving behind the pending report.
    for (let round = 1; round <= 5; round++) {
      now = t0 + round * MAX_REPORT_BACKOFF_MS;
      for (let i = 0; i < MAX_QUEUE + 1; i++) emitAuditRecord("alice", rec(i)); // 1 overflow per round
      await flushAuditLog();
    }
    expect(storedDrops(hub.stored)).toEqual({});

    hub.refuseDropped = false;
    await flushAfterBackoff();
    const stored = hub.stored.filter((r) => r.eventName === AUDIT_DROPPED_EVENT);
    // Report A as first snapshotted, then one report for everything after it.
    expect(stored).toHaveLength(2);
    expect(attr(stored[0], "callboard.audit.dropped.count")).toEqual({ intValue: "2" });
    expect(attr(stored[0], "callboard.audit.dropped.window_start_unix_ms")).toEqual({ intValue: String(t0) });
    expect(attr(stored[0], "callboard.audit.dropped.window_end_unix_ms")).toEqual({ intValue: String(t0) });
    expect(attr(stored[1], "callboard.audit.dropped.count")).toEqual({ intValue: "5" });
    expect(attr(stored[1], "callboard.audit.dropped.window_start_unix_ms")).toEqual({ intValue: String(t0 + MAX_REPORT_BACKOFF_MS) });
    expect(attr(stored[1], "callboard.audit.dropped.window_end_unix_ms")).toEqual({ intValue: String(t0 + 5 * MAX_REPORT_BACKOFF_MS) });
    // Refused reports are not themselves counted as lost audit records (no `rejected`).
    expect(storedDrops(hub.stored)).toEqual({ count: 7, overflow: 7 });
    expect(hub.stored.filter((r) => r.eventName === "test.event")).toHaveLength(6 * MAX_QUEUE);
  });

  it("overflow drops new records and the next successful batch carries a dropped record with count and window", async () => {
    const { calls } = setup();
    for (let i = 0; i < MAX_QUEUE; i++) emitAuditRecord("alice", rec(i));
    now += 10;
    emitAuditRecord("alice", rec(-1));
    now += 10;
    emitAuditRecord("alice", rec(-2));
    expect(__auditQueueLength()).toBe(MAX_QUEUE);
    await flushAuditLog();
    const all = calls.flatMap(recordsOf);
    const droppedRecords = all.filter((r) => r.eventName === AUDIT_DROPPED_EVENT);
    expect(droppedRecords).toHaveLength(1);
    const d = droppedRecords[0];
    expect(calls.filter(isReportCall).map(recordsOf)).toEqual([[d]]); // in its own call
    expect(d.severityText).toBe("WARN");
    expect(attr(d, "callboard.audit.dropped.count")).toEqual({ intValue: "2" });
    expect(attr(d, "callboard.audit.dropped.overflow")).toEqual({ intValue: "2" });
    expect(attr(d, "callboard.audit.dropped.window_start_unix_ms")).toEqual({ intValue: String(now - 10) });
    expect(attr(d, "callboard.audit.dropped.window_end_unix_ms")).toEqual({ intValue: String(now) });
    expect(all.filter((r) => r.eventName === "test.event")).toHaveLength(MAX_QUEUE);
    // Reported once: the tally is cleared after it was delivered.
    emitAuditRecord("alice", rec(1));
    await flushAuditLog();
    expect(recordsOf(calls.at(-1)!).map((r) => r.eventName)).toEqual(["test.event"]);
  });

  it("a delivered snapshot is subtracted exactly: in-flight losses are reported next, with their own window", async () => {
    let mode: "down" | "slow" | "up" = "down";
    let releaseSlow!: () => void;
    const delivered: IngestLogsInput[] = [];
    setup(async (input) => {
      if (mode === "down") throw new Error("fetch failed");
      if (mode === "slow") await new Promise<void>((r) => (releaseSlow = r));
      delivered.push(input);
      return {};
    });
    const t0 = now;
    emitAuditRecord("alice", rec(1)); // lost to send_failed, emitted at t0
    await flushAuditLog();

    now = t0 + 60_000;
    mode = "slow";
    emitAuditRecord("alice", rec(2));
    const slowFlush = flushAuditLog();
    await vi.waitFor(() => expect(releaseSlow).toBeTypeOf("function"));
    // Two overflow losses while record 2's batch is in flight and the report
    // carrying send_failed=1 is still pending.
    for (let i = 0; i < MAX_QUEUE; i++) emitAuditRecord("alice", rec(100 + i));
    now = t0 + 70_000;
    emitAuditRecord("alice", rec(-1));
    now = t0 + 80_000;
    emitAuditRecord("alice", rec(-2));
    mode = "up";
    releaseSlow();
    await slowFlush;
    await flushAuditLog();

    const reports = delivered.flatMap(recordsOf).filter((r) => r.eventName === AUDIT_DROPPED_EVENT);
    expect(reports).toHaveLength(2);
    const [first, second] = reports;
    expect(attr(first, "callboard.audit.dropped.count")).toEqual({ intValue: "1" });
    expect(attr(first, "callboard.audit.dropped.send_failed")).toEqual({ intValue: "1" });
    expect(attr(first, "callboard.audit.dropped.window_start_unix_ms")).toEqual({ intValue: String(t0) });
    // Only the in-flight losses remain: send_failed subtracted, window is theirs alone.
    expect(attr(second, "callboard.audit.dropped.count")).toEqual({ intValue: "2" });
    expect(attr(second, "callboard.audit.dropped.overflow")).toEqual({ intValue: "2" });
    expect(attr(second, "callboard.audit.dropped.send_failed")).toBeUndefined();
    expect(attr(second, "callboard.audit.dropped.window_start_unix_ms")).toEqual({ intValue: String(t0 + 70_000) });
    expect(attr(second, "callboard.audit.dropped.window_end_unix_ms")).toEqual({ intValue: String(t0 + 80_000) });
  });

  it("the window of a failed batch is when its records were emitted, not when it was sent", async () => {
    let down = true;
    const { calls } = setup(async () => {
      if (down) throw new Error("fetch failed");
      return {};
    });
    const t0 = now;
    emitAuditRecord("alice", rec(1));
    now = t0 + 5_000;
    emitAuditRecord("alice", rec(2));
    now = t0 + 30_000; // queued behind a long retry storm before this batch goes out
    await flushAuditLog();
    down = false;
    emitAuditRecord("alice", rec(3));
    await flushAfterBackoff();
    const [d] = reportsIn(calls);
    expect(attr(d, "callboard.audit.dropped.send_failed")).toEqual({ intValue: "2" });
    expect(attr(d, "callboard.audit.dropped.window_start_unix_ms")).toEqual({ intValue: String(t0) });
    expect(attr(d, "callboard.audit.dropped.window_end_unix_ms")).toEqual({ intValue: String(t0 + 5_000) });
  });

  it("a record's own timeMs is its event time and its loss window", async () => {
    let down = true;
    const { calls } = setup(async () => {
      if (down) throw new Error("fetch failed");
      return {};
    });
    const decidedAt = now - 2_000;
    emitAuditRecord("alice", rec(1, { timeMs: decidedAt }));
    await flushAuditLog();
    down = false;
    emitAuditRecord("alice", rec(2, { timeMs: decidedAt + 1 }));
    await flushAfterBackoff();
    const [d] = reportsIn(calls);
    const [r] = recordsOf(dataCalls(calls).at(-1)!);
    expect(attr(d, "callboard.audit.dropped.window_start_unix_ms")).toEqual({ intValue: String(decidedAt) });
    expect(r.timeUnixNano).toBe(`${decidedAt + 1}000000`);
    expect(r).not.toHaveProperty("timeMs");
  });

  it("retries a failed send with exponential backoff, then succeeds without loss", async () => {
    let failures = 2;
    const { callTool } = setup(async () => {
      if (failures-- > 0) throw new Error("Proxy request failed: 503");
      return {};
    });
    emitAuditRecord("alice", rec(1));
    await flushAuditLog();
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([RETRY_BASE_MS, RETRY_BASE_MS * 2]);
    emitAuditRecord("alice", rec(2));
    await flushAuditLog();
    expect(recordsOf(callTool.mock.calls.at(-1)![1] as never).map((r: OtlpLogRecord) => r.eventName)).toEqual(["test.event"]);
  });

  it("a batch that exhausts its retries is dropped and reported on the next success", async () => {
    let down = true;
    const { calls } = setup(async () => {
      if (down) throw new Error("fetch failed");
      return {};
    });
    emitAuditRecord("alice", rec(1));
    emitAuditRecord("alice", rec(2));
    await flushAuditLog();
    expect(dataCalls(calls)).toHaveLength(MAX_SEND_ATTEMPTS);
    down = false;
    emitAuditRecord("alice", rec(3));
    await flushAfterBackoff();
    const [d] = reportsIn(calls);
    expect(attr(d, "callboard.audit.dropped.send_failed")).toEqual({ intValue: "2" });
    expect(recordsOf(dataCalls(calls).at(-1)!).map((r) => attr(r, "n"))).toEqual([{ intValue: "3" }]);
  });

  it("records drawlatch rejects (partialSuccess) are counted and reported", async () => {
    let first = true;
    const { calls } = setup(async () => {
      if (first) {
        first = false;
        return { partialSuccess: { rejectedLogRecords: 1, errorMessage: "record 0: bad traceId" } };
      }
      return {};
    });
    emitAuditRecord("alice", rec(1));
    await flushAuditLog();
    emitAuditRecord("alice", rec(2));
    await flushAuditLog();
    const d = recordsOf(calls[1])[0];
    expect(d.eventName).toBe(AUDIT_DROPPED_EVENT);
    expect(attr(d, "callboard.audit.dropped.rejected")).toEqual({ intValue: "1" });
  });

  it("partialSuccess with rejectedLogRecords: 0 (drawlatch's lenient 'kept' warnings) is a clean success", async () => {
    const { calls, callTool } = setup(async () => ({ partialSuccess: { rejectedLogRecords: 0, errorMessage: "kept: record 0 has unknown field 'x' (stored under extra)" } }));
    emitAuditRecord("alice", rec(1));
    await flushAuditLog();
    expect(callTool).toHaveBeenCalledTimes(1); // no retry
    expect(sleep).not.toHaveBeenCalled();
    emitAuditRecord("alice", rec(2));
    await flushAuditLog();
    expect(recordsOf(calls.at(-1)!).map((r) => r.eventName)).toEqual(["test.event"]); // no dropped record
  });

  it("drops are tallied per alias and reported to that alias's caller", async () => {
    const { calls } = setup(async (input) => {
      if (recordsOf(input).some((r) => (attr(r, "n") as { intValue?: string } | undefined)?.intValue === "1")) throw new Error("fetch failed");
      return {};
    });
    emitAuditRecord("alice", rec(1));
    await flushAuditLog();
    emitAuditRecord("bob", rec(2));
    await flushAuditLog();
    expect(recordsOf(calls.at(-1)!).map((r) => r.eventName)).toEqual(["test.event"]);
  });
});

describe("hub without ingest_logs", () => {
  it("disables the alias, logs once, counts records as dropped, and the first batch after 10 min re-probes", async () => {
    let supported = false;
    const { calls, callTool } = setup(async () => {
      if (!supported) throw new Error("Unknown tool: ingest_logs");
      return {};
    });
    emitAuditRecord("alice", rec(1));
    await flushAuditLog();
    expect(callTool).toHaveBeenCalledTimes(1); // no retries burned on an unsupported hub
    expect(sleep).not.toHaveBeenCalled();

    // Disabled: nothing queued, nothing sent.
    for (let i = 0; i < 5; i++) emitAuditRecord("alice", rec(10 + i));
    expect(__auditQueueLength()).toBe(0);
    await flushAuditLog();
    expect(callTool).toHaveBeenCalledTimes(1);

    now += REPROBE_INTERVAL_MS;
    emitAuditRecord("alice", rec(20));
    await flushAuditLog();
    expect(callTool).toHaveBeenCalledTimes(2); // the re-probe (the loss report) — still unsupported
    expect(__auditQueueLength()).toBe(0);

    // Hub upgraded: the re-probe succeeds and every record lost meanwhile is reported.
    supported = true;
    now += REPROBE_INTERVAL_MS;
    emitAuditRecord("alice", rec(30));
    await flushAuditLog();
    expect(deliveredDropsOf(calls)).toEqual({ count: 7, hub_unsupported: 7 }); // 1 + 5 + 1
    expect(recordsOf(dataCalls(calls).at(-1)!).map((r) => attr(r, "n"))).toEqual([{ intValue: "30" }]);
  });

  it("only an exact 'Unknown tool: ingest_logs' disables; other errors retry", async () => {
    const { callTool } = setup(async () => {
      throw new Error("Unknown tool: wait_for_events");
    });
    emitAuditRecord("alice", rec(1));
    await flushAuditLog();
    expect(dataCalls(callTool.mock.calls.map((c) => (c as unknown[])[1] as IngestLogsInput))).toHaveLength(MAX_SEND_ATTEMPTS);
  });
});

describe("report retries run on their own timer", () => {
  /**
   * Real module timing under vitest fake timers: `now` is the faked Date.now,
   * and each caller has its own fake hub. `refuseReports` makes a caller's hub
   * refuse loss reports (as a drained byte budget does) and store all else.
   */
  function timedHubs(aliasNames: string[]) {
    vi.useFakeTimers({ now: 1_760_000_000_000 });
    const hubs = new Map<string, { refuseReports: boolean; hangReports?: boolean; calls: IngestLogsInput[]; stored: OtlpLogRecord[] }>();
    for (const a of aliasNames) hubs.set(a, { refuseReports: false, calls: [], stored: [] });
    __resetAuditLogForTests({
      getProxy: (alias) => ({
        callTool: async (_tool: string, input?: Record<string, unknown>) => {
          const hub = hubs.get(alias)!;
          const body = input as unknown as IngestLogsInput;
          hub.calls.push(body);
          if (hub.hangReports && isReportCall(body)) return new Promise(() => {});
          if (hub.refuseReports && isReportCall(body)) return { partialSuccess: { rejectedLogRecords: 1, errorMessage: "rejected: audit byte budget exhausted" } };
          hub.stored.push(...recordsOf(body));
          return {};
        },
      }),
      sleep,
    });
    return hubs;
  }
  const lose = (alias: string) =>
    emitAuditRecord(alias, () => {
      throw new Error("lost");
    });

  /** Drive caller `a`'s refused report into a long (>=16 s) backoff. */
  async function backOffReports(hub: { calls: IngestLogsInput[] }) {
    lose("a");
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS); // the data flush counts the loss...
    await vi.advanceTimersByTimeAsync(1); // ...and the report timer it armed fires: refused, retry in 2 s
    for (const ms of [2000, 4000, 8000]) await vi.advanceTimersByTimeAsync(ms); // refused again each time
    expect(hub.calls.filter(isReportCall).length).toBeGreaterThanOrEqual(4);
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("another caller's record goes out at the normal cadence while one caller's report backs off (review round 3, S1)", async () => {
    const hubs = timedHubs(["a", "b"]);
    hubs.get("a")!.refuseReports = true;
    await backOffReports(hubs.get("a")!);

    emitAuditRecord("b", rec(1));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(hubs.get("b")!.stored.map((r) => attr(r, "n"))).toEqual([{ intValue: "1" }]);
  });

  it("the same caller's new records go out at the normal cadence while its report backs off", async () => {
    const hubs = timedHubs(["a"]);
    const hub = hubs.get("a")!;
    hub.refuseReports = true;
    await backOffReports(hub);

    emitAuditRecord("a", rec(7));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    expect(hub.stored.filter((r) => r.eventName === "test.event").map((r) => attr(r, "n"))).toEqual([{ intValue: "7" }]);
  });

  it("one caller's report that never returns does not hold another caller's report or records", async () => {
    const hubs = timedHubs(["a", "b"]);
    hubs.get("a")!.hangReports = true;
    lose("a");
    lose("b");
    emitAuditRecord("b", rec(5));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(1);
    expect(hubs.get("a")!.calls.filter(isReportCall)).toHaveLength(1); // out, never answered
    const b = hubs.get("b")!;
    expect(storedDropsIn(b.stored)).toEqual({ count: 1, build_failed: 1 });
    expect(b.stored.filter((r) => r.eventName === "test.event").map((r) => attr(r, "n"))).toEqual([{ intValue: "5" }]);
  });

  it("a loss with nothing queued behind it is retried on its own timer and lands without any new record", async () => {
    const hubs = timedHubs(["a"]);
    const hub = hubs.get("a")!;
    hub.refuseReports = true;
    lose("a");
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(1); // first report refused
    expect(hub.calls.filter(isReportCall)).toHaveLength(1);
    hub.refuseReports = false;
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS); // the scheduled retry, no emit, no flush call
    expect(storedDropsIn(hub.stored)).toEqual({ count: 1, build_failed: 1 });
  });

  it("shutdown gives a report that is backing off its last try (review round 3, S2)", async () => {
    const hubs = timedHubs(["a"]);
    const hub = hubs.get("a")!;
    hub.refuseReports = true;
    lose("a");
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(1); // refused; retry due in 2 s
    expect(hub.calls.filter(isReportCall)).toHaveLength(1);
    hub.refuseReports = false; // the hub is back — but the retry is not due yet
    const before = hub.calls.length;
    await shutdownAuditLog(1000);
    expect(hub.calls.length).toBe(before + 1);
    expect(storedDropsIn(hub.stored)).toEqual({ count: 1, build_failed: 1 });
  });
});

describe("shutdown", () => {
  it("flushes what is queued", async () => {
    const { calls } = setup();
    emitAuditRecord("alice", rec(1));
    await shutdownAuditLog(1000);
    expect(calls).toHaveLength(1);
    emitAuditRecord("alice", rec(2)); // ignored after shutdown
    expect(__auditQueueLength()).toBe(0);
  });

  it("counts the batch in flight as unsent, not just the queue", async () => {
    setup(() => new Promise(() => {}));
    emitAuditRecord("alice", rec(1));
    emitAuditRecord("alice", rec(2));
    void flushAuditLog();
    await vi.waitFor(() => expect(__auditQueueLength()).toBe(0));
    expect(unsentCount()).toBe(2);
  });

  it("a shutdown during backoff drops the batch at its next failure instead of retrying on", async () => {
    let shutdown: Promise<void> | undefined;
    sleep.mockImplementationOnce(async () => {
      shutdown = shutdownAuditLog(1000); // marks stopped synchronously
    });
    const { callTool, calls } = setup(async () => {
      throw new Error("fetch failed");
    });
    emitAuditRecord("alice", rec(1));
    await flushAuditLog();
    await shutdown;
    expect(dataCalls(calls)).toHaveLength(2); // not MAX_SEND_ATTEMPTS
    expect(callTool.mock.calls.length - dataCalls(calls).length).toBeLessThanOrEqual(1); // at most one loss report
    expect(MAX_SEND_ATTEMPTS).toBeGreaterThan(2);
  });

  it("gives up after the bounded wait when the hub never answers", async () => {
    setup(() => new Promise(() => {}));
    emitAuditRecord("alice", rec(1));
    const t0 = Date.now();
    await shutdownAuditLog(50);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
