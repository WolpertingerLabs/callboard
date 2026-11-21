import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendDaemonEvent,
  auditCallerDir,
  flushQuotaMarkers,
  beginAuditShutdown,
  flushQuotaMarkersWithin,
  ingestLogs,
  parseIngestRequest,
  renderParts,
  resetAuditLogState,
  ERROR_LOG_WINDOW_MS,
  MARKER_RETRY_MAX_MS,
  MAX_NOTE_ENTRIES,
  MAX_ARRAY_ITEMS,
  MAX_ATTRIBUTES,
  MAX_KEY_CHARS,
  MAX_BYTES_PER_CALL,
  MAX_RECORDS_PER_CALL,
  MAX_RECORD_BYTES,
  MAX_STRING_CHARS,
  MAX_VALUE_DEPTH,
  QUOTA_MARKER_INTERVAL_MS,
  TRUNCATION_MARKER,
  type AuditLine,
  type BudgetOptions,
  type QuotaExceededLine,
} from './audit-log.js';

const NOW = new Date('2026-10-11T12:00:00.000Z');
const TRACE = '0123456789abcdef0123456789abcdef';
const SPAN = '0123456789abcdef';

/** A private parent dir per test, so nothing is ever asserted about shared /tmp. */
let parent: string;
let root: string;

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-audit-'));
  root = path.join(parent, 'audit');
  resetAuditLogState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetAuditLogState();
  fs.rmSync(parent, { recursive: true, force: true });
});

function str(v: string) {
  return { stringValue: v };
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timeUnixNano: '1760184000000000000',
    observedTimeUnixNano: '1760184000000000001',
    severityNumber: 9,
    severityText: 'INFO',
    eventName: 'permission.review.requested',
    body: str('hello'),
    attributes: [{ key: 'tool.name', value: str('Bash') }],
    traceId: TRACE,
    spanId: SPAN,
    flags: 1,
    ...overrides,
  };
}

function request(records: unknown[], extra: { resource?: unknown; scope?: unknown } = {}) {
  return {
    resourceLogs: [
      {
        resource: extra.resource ?? {
          attributes: [{ key: 'service.name', value: str('callboard') }],
        },
        scopeLogs: [
          {
            scope: extra.scope ?? { name: 'callboard.permission-review', version: '1' },
            logRecords: records,
          },
        ],
      },
    ],
  };
}

function ingest(input: unknown, caller = 'callboard', now = NOW, budget?: BudgetOptions) {
  return ingestLogs(input, caller, { auditRoot: root, now, ...(budget && { budget }) });
}

function fileFor(caller = 'callboard', day = '2026-10-11'): string {
  return path.join(root, caller, `${day}.jsonl`);
}

function readLines<T = AuditLine>(file = fileFor()): T[] {
  const text = fs.readFileSync(file, 'utf8');
  expect(text.endsWith('\n')).toBe(true);
  return text
    .slice(0, -1)
    .split('\n')
    .map((l) => JSON.parse(l) as T);
}

function clientLines(file = fileFor()): AuditLine[] {
  return readLines<AuditLine | QuotaExceededLine>(file).filter(
    (l): l is AuditLine => l['drawlatch.source'] === 'client',
  );
}

function markers(file = fileFor()): QuotaExceededLine[] {
  return readLines<AuditLine | QuotaExceededLine>(file).filter(
    (l): l is QuotaExceededLine => l['drawlatch.source'] === 'daemon',
  );
}

describe('ingest_logs storage format', () => {
  it('stores one flattened line per record with server stamps', async () => {
    const res = await ingest(request([record({ parentSpanId: 'FEDCBA9876543210' })]));
    expect(res).toEqual({});

    const [line] = readLines();
    expect(line).toEqual({
      'drawlatch.caller': 'callboard',
      'drawlatch.received_at': NOW.toISOString(),
      'drawlatch.sequence': 1,
      'drawlatch.source': 'client',
      time_unix_nano: '1760184000000000000',
      observed_time_unix_nano: '1760184000000000001',
      severity_number: 9,
      severity_text: 'INFO',
      event_name: 'permission.review.requested',
      trace_id: TRACE,
      span_id: SPAN,
      parent_span_id: 'fedcba9876543210',
      flags: 1,
      body: 'hello',
      attributes: { 'tool.name': 'Bash' },
      resource: { 'service.name': 'callboard' },
      scope: { name: 'callboard.permission-review', version: '1' },
    });
  });

  it('writes stamps first and shared context last', async () => {
    await ingest(request([record()]));
    const keys = Object.keys(readLines()[0]);
    expect(keys.slice(0, 4)).toEqual([
      'drawlatch.caller',
      'drawlatch.received_at',
      'drawlatch.sequence',
      'drawlatch.source',
    ]);
    expect(keys.slice(-3)).toEqual(['attributes', 'resource', 'scope']);
  });

  it('flattens every AnyValue kind, including proto3 JSON spellings', async () => {
    await ingest(
      request([
        record({
          severityNumber: 'SEVERITY_NUMBER_WARN2',
          flags: '1',
          attributes: [
            { key: 's', value: str('x') },
            { key: 'b', value: { boolValue: false } },
            { key: 'i', value: { intValue: '42' } },
            { key: 'n', value: { intValue: 7 } },
            { key: 'big', value: { intValue: '9223372036854775807' } },
            { key: 'neg', value: { intValue: '-5' } },
            { key: 'd', value: { doubleValue: 1.5 } },
            { key: 'dstr', value: { doubleValue: '2.5' } },
            { key: 'nan', value: { doubleValue: 'NaN' } },
            { key: 'inf', value: { doubleValue: '-Infinity' } },
            { key: 'bytes', value: { bytesValue: 'aGk=' } },
            { key: 'urlbytes', value: { bytesValue: 'a-_b' } },
            { key: 'arr', value: { arrayValue: { values: [str('a'), { intValue: 1 }] } } },
            { key: 'kv', value: { kvlistValue: { values: [{ key: 'k', value: str('v') }] } } },
            { key: 'empty', value: {} },
            { key: 'missing' },
          ],
        }),
      ]),
    );
    const [line] = readLines();
    expect(line.severity_number).toBe(14);
    expect(line.flags).toBe(1);
    expect(line.attributes).toEqual({
      s: 'x',
      b: false,
      i: 42,
      n: 7,
      big: '9223372036854775807',
      neg: -5,
      d: 1.5,
      dstr: 2.5,
      nan: 'NaN',
      inf: '-Infinity',
      bytes: 'aGk=',
      urlbytes: 'a-_b',
      arr: ['a', 1],
      kv: { k: 'v' },
      empty: null,
      missing: null,
    });
    expect(line.invalid).toBeUndefined();
  });

  it('keeps a __proto__ key as plain data', async () => {
    await ingest(request([record({ attributes: [{ key: '__proto__', value: str('x') }] })]));
    expect(fs.readFileSync(fileFor(), 'utf8')).toContain('"__proto__":"x"');
  });

  it('omits ids that OTLP/JSON sends as empty strings', async () => {
    await ingest(request([record({ traceId: '', spanId: '', parentSpanId: '' })]));
    const [line] = readLines();
    expect(line).not.toHaveProperty('trace_id');
    expect(line).not.toHaveProperty('span_id');
    expect(line).not.toHaveProperty('parent_span_id');
    expect(line.invalid).toBeUndefined();
  });

  it('accepts an empty request and creates nothing', async () => {
    expect(await ingest({})).toEqual({});
    expect(await ingest({ resourceLogs: [] })).toEqual({});
    expect(fs.existsSync(root)).toBe(false);
  });

  it('names the file by the UTC day of receipt', async () => {
    // 23:30 in New York on the 11th is the 12th in UTC.
    await ingest(request([record()]), 'callboard', new Date('2026-10-11T23:30:00-04:00'));
    expect(fs.existsSync(fileFor('callboard', '2026-10-12'))).toBe(true);
  });
});

describe('ingest_logs lenient validation', () => {
  it('throws only on an unusable top level', async () => {
    await expect(ingest(null)).rejects.toThrow(/must be an object/);
    await expect(ingest([])).rejects.toThrow(/must be an object/);
    await expect(ingest({ resourceLogs: {} })).rejects.toThrow(/must be an array/);
  });

  it.each([
    ['short traceId', { traceId: 'abc' }, 'logRecord.traceId', 'trace_id'],
    ['non-hex spanId', { spanId: 'zzzzzzzzzzzzzzzz' }, 'logRecord.spanId', 'span_id'],
    ['bad parentSpanId', { parentSpanId: TRACE }, 'logRecord.parentSpanId', 'parent_span_id'],
    [
      'severity out of range',
      { severityNumber: 25 },
      'logRecord.severityNumber',
      'severity_number',
    ],
    [
      'unknown severity name',
      { severityNumber: 'LOUD' },
      'logRecord.severityNumber',
      'severity_number',
    ],
    ['negative time', { timeUnixNano: -1 }, 'logRecord.timeUnixNano', 'time_unix_nano'],
    [
      'time overflow',
      { timeUnixNano: '18446744073709551616' },
      'logRecord.timeUnixNano',
      'time_unix_nano',
    ],
    ['flags too big', { flags: 2 ** 32 }, 'logRecord.flags', 'flags'],
    ['long eventName', { eventName: 'e'.repeat(257) }, 'logRecord.eventName', 'event_name'],
    ['non-string severityText', { severityText: 3 }, 'logRecord.severityText', 'severity_text'],
    ['body not AnyValue', { body: 'plain' }, 'logRecord.body', 'body'],
    [
      'body with two kinds',
      { body: { stringValue: 'a', boolValue: true } },
      'logRecord.body',
      'body',
    ],
    ['null double (NaN through JSON)', { body: { doubleValue: null } }, 'logRecord.body', 'body'],
    ['int64 overflow', { body: { intValue: '9223372036854775808' } }, 'logRecord.body', 'body'],
    ['unsafe int number', { body: { intValue: 2 ** 60 } }, 'logRecord.body', 'body'],
    ['bad base64', { body: { bytesValue: '!!' } }, 'logRecord.body', 'body'],
    ['fractional severity', { severityNumber: 1.5 }, 'logRecord.severityNumber', 'severity_number'],
    ['time not a number', { timeUnixNano: '12abc' }, 'logRecord.timeUnixNano', 'time_unix_nano'],
  ])('keeps a record with %s, moving the value to invalid', async (_name, bad, where, field) => {
    const res = await ingest(request([record(), record(bad), record()]));
    expect(res.partialSuccess?.rejectedLogRecords).toBe(0);
    expect(res.partialSuccess?.errorMessage).toMatch(/^kept: invalid /);

    const lines = readLines();
    expect(lines.map((l) => l['drawlatch.sequence'])).toEqual([1, 2, 3]);
    expect(lines[1]).not.toHaveProperty(field);
    expect(typeof lines[1].invalid?.[where]?.reason).toBe('string');
    expect(lines[1].invalid?.[where]).toHaveProperty('raw');
    expect(lines[0].invalid).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['numeric', 7],
    ['overlong', 'K'.repeat(257)],
  ])('keeps the value of an attribute with a bad (%s) key', async (_name, key) => {
    await ingest(request([record({ attributes: [{ key, value: str('the value') }] })]));
    const [line] = readLines();
    expect(line.invalid?.['logRecord.attributes[0]']).toMatchObject({
      raw: { value: { stringValue: 'the value' } },
    });
  });

  it('keeps the good attributes when one is bad', async () => {
    await ingest(
      request([
        record({
          attributes: [
            { key: 'latency_ms', value: { doubleValue: null } },
            { key: 'a', value: str('1') },
            { key: 'a', value: str('2') },
            { key: '', value: str('x') },
            { key: 'k'.repeat(257), value: str('x') },
            'not-a-kv',
            { key: 'ok', value: str('yes') },
          ],
        }),
      ]),
    );
    const [line] = readLines();
    expect(line.attributes).toEqual({ a: '1', ok: 'yes' });
    expect(Object.keys(line.invalid ?? {}).sort()).toEqual([
      'logRecord.attributes["latency_ms"]',
      'logRecord.attributes[2]',
      'logRecord.attributes[3]',
      'logRecord.attributes[4]',
      'logRecord.attributes[5]',
    ]);
  });

  it('keeps unknown fields at every level under extra', async () => {
    const res = await ingest({
      futureTop: 1,
      resourceLogs: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: str('callboard') }],
            entityRefs: [{ type: 'service' }],
          },
          schemaUrl: 'https://opentelemetry.io/schemas/1.0.0',
          rlNew: true,
          scopeLogs: [
            {
              scope: { name: 'callboard.permission-review', scopeNew: 'x' },
              slNew: 2,
              logRecords: [
                record({
                  spanID: 'typo',
                  attributes: [{ key: 'a', value: { stringValue: 'v', futureKind: 1 }, kvNew: 3 }],
                }),
              ],
            },
          ],
        },
      ],
    });
    expect(res.partialSuccess?.rejectedLogRecords).toBe(0);
    const [line] = readLines();
    expect(line.extra).toEqual({
      'request["futureTop"]': 1,
      'resourceLogs["rlNew"]': true,
      'resource["entityRefs"]': [{ type: 'service' }],
      'scopeLogs["slNew"]': 2,
      'scope["scopeNew"]': 'x',
      'logRecord["spanID"]': 'typo',
      'logRecord.attributes[0]["kvNew"]': 3,
      'logRecord.attributes["a"]["futureKind"]': 1,
    });
    expect(line.attributes).toEqual({ a: 'v' });
    expect(line.resource_schema_url).toBe('https://opentelemetry.io/schemas/1.0.0');
  });

  it('keeps malformed resource and scope containers as invalid, not rejected', async () => {
    const res = await ingest({
      resourceLogs: [
        { resource: { attributes: 'bad' }, scopeLogs: [{ logRecords: [record(), record()] }] },
        { scopeLogs: [{ scope: { name: 5 }, logRecords: [record()] }] },
        { resource: 'nope', scopeLogs: [{ scope: [], logRecords: [record()] }] },
      ],
    });
    expect(res.partialSuccess?.rejectedLogRecords).toBe(0);
    const lines = readLines();
    expect(lines).toHaveLength(4);
    expect(Object.keys(lines[0].invalid ?? {})).toEqual(['resource.attributes']);
    expect(Object.keys(lines[2].invalid ?? {})).toEqual(['scope.name']);
    expect(Object.keys(lines[3].invalid ?? {}).sort()).toEqual(['resource', 'scope']);
  });

  it('rejects only what it cannot reach or keep, counting records exactly', async () => {
    const res = await ingest({
      resourceLogs: [
        'not-an-object',
        { scopeLogs: 'not-an-array' },
        { scopeLogs: ['not-an-object', { logRecords: 'not-an-array' }] },
        { scopeLogs: [{ logRecords: [record(), 'not-a-record', 7, null] }] },
        { scopeLogs: [{ logRecords: [] }, {}] },
      ],
    });
    // 1 + 1 + (1 + 1) + 3 + 0
    expect(res.partialSuccess?.rejectedLogRecords).toBe(7);
    expect(readLines()).toHaveLength(1);
  });

  it('counts zero rejected for an oversize resource with empty scopes', async () => {
    const bigAttrs = Array.from({ length: 20 }, (_, i) => ({
      key: `k${i}`,
      value: str('x'.repeat(MAX_STRING_CHARS)),
    }));
    const empty = await ingest({
      resourceLogs: [
        { resource: { attributes: bigAttrs }, scopeLogs: [{}, {}, { logRecords: [] }] },
      ],
    });
    expect(empty).toEqual({});

    const two = await ingest(request([record(), record()], { resource: { attributes: bigAttrs } }));
    expect(two.partialSuccess?.rejectedLogRecords).toBe(2);
    expect(two.partialSuccess?.errorMessage).toMatch(/resource exceeds/);
  });

  it('gives keys that look like paths their own entries', async () => {
    const bad = { doubleValue: null };
    await ingest(
      request([
        record({
          attributes: [
            { key: 'a.b', value: bad },
            { key: 'a', value: { kvlistValue: { values: [{ key: 'b', value: bad }] } } },
            { key: 'c[0]', value: bad },
            { key: 'c', value: { arrayValue: { values: [bad] } } },
          ],
          'attributes[0]': 'unknown field named like a path',
        }),
      ]),
    );
    const [line] = readLines();
    expect(Object.keys(line.invalid ?? {}).sort()).toEqual([
      'logRecord.attributes["a"]["b"]',
      'logRecord.attributes["a.b"]',
      'logRecord.attributes["c"][0]',
      'logRecord.attributes["c[0]"]',
    ]);
    expect(Object.keys(line.extra ?? {})).toEqual(['logRecord["attributes[0]"]']);
  });

  it('keeps both of two long unknown names that truncate alike', async () => {
    const prefix = 'u'.repeat(MAX_KEY_CHARS);
    await ingest(request([record({ [`${prefix}-one`]: 1, [`${prefix}-two`]: 2 })]));
    const [line] = readLines();
    const cut = `logRecord[${JSON.stringify(prefix + TRUNCATION_MARKER)}]`;
    expect(line.extra).toEqual({ [cut]: 1, [`${cut}#2`]: 2 });
    expect(line.truncated).toBe(true);
  });

  it('caps unknown fields per object instead of rejecting the record', async () => {
    const many = Object.fromEntries(Array.from({ length: 20_000 }, (_, i) => [`u${i}`, i]));
    const res = await ingest(request([record(many)]));
    expect(res.partialSuccess?.rejectedLogRecords).toBe(0);
    const [line] = readLines();
    expect(Object.keys(line.extra ?? {})).toHaveLength(MAX_ATTRIBUTES);
    expect(line.truncated).toBe(true);
  });

  it(`caps ${MAX_NOTE_ENTRIES} invalid entries per record`, async () => {
    const bad = { doubleValue: null };
    const attrs = Array.from({ length: MAX_ATTRIBUTES }, (_, i) => ({ key: `k${i}`, value: bad }));
    const items = Array.from({ length: MAX_ARRAY_ITEMS }, () => bad);
    const res = await ingest(
      request([record({ attributes: attrs, body: { arrayValue: { values: items } } })]),
    );
    expect(res.partialSuccess?.rejectedLogRecords).toBe(0);
    const [line] = readLines();
    expect(Object.keys(line.invalid ?? {})).toHaveLength(MAX_NOTE_ENTRIES);
    expect(line.truncated).toBe(true);
  });

  it('bounds and marks what it keeps in extra', async () => {
    await ingest(request([record({ huge: 'z'.repeat(MAX_STRING_CHARS + 5) })]));
    const [line] = readLines();
    expect(line.extra?.['logRecord["huge"]']).toBe(
      'z'.repeat(MAX_STRING_CHARS) + TRUNCATION_MARKER,
    );
    expect(line.truncated).toBe(true);
  });

  it('bounds the error message', async () => {
    const bad = Array.from({ length: 50 }, (_, i) => record({ [`f${i}${'x'.repeat(500)}`]: 1 }));
    const res = await ingest(request([...bad, ...Array.from({ length: 30 }, () => 'bad')]));
    expect(res.partialSuccess?.rejectedLogRecords).toBe(30);
    expect(res.partialSuccess?.errorMessage.length).toBeLessThan(5000);
    expect(res.partialSuccess?.errorMessage).toMatch(/^rejected: /);
  });
});

describe('ingest_logs size bounds', () => {
  it(`rejects records past ${MAX_RECORDS_PER_CALL} per call`, async () => {
    const records = Array.from({ length: MAX_RECORDS_PER_CALL + 5 }, () => record());
    const res = await ingest(request(records));
    expect(res.partialSuccess?.rejectedLogRecords).toBe(5);
    expect(res.partialSuccess?.errorMessage).toMatch(/more than 1000 records/);
    expect(readLines()).toHaveLength(MAX_RECORDS_PER_CALL);
  });

  it('truncates long strings with a marker and flags the line', async () => {
    const long = 'a'.repeat(MAX_STRING_CHARS + 10);
    await ingest(request([record({ body: str(long) }), record()]));
    const [cut, whole] = readLines();
    expect(cut.body).toBe('a'.repeat(MAX_STRING_CHARS) + TRUNCATION_MARKER);
    expect(cut.truncated).toBe(true);
    expect(whole.truncated).toBeUndefined();
  });

  it('does not split a surrogate pair when truncating', async () => {
    const long = 'a'.repeat(MAX_STRING_CHARS - 1) + '😀' + 'b';
    await ingest(request([record({ body: str(long) })]));
    expect(readLines()[0].body).toBe('a'.repeat(MAX_STRING_CHARS - 1) + TRUNCATION_MARKER);
  });

  it('caps attribute count and array length', async () => {
    const attrs = Array.from({ length: MAX_ATTRIBUTES + 3 }, (_, i) => ({
      key: `k${i}`,
      value: str('v'),
    }));
    const items = Array.from({ length: MAX_ARRAY_ITEMS + 3 }, () => ({ intValue: 1 }));
    await ingest(
      request([record({ attributes: attrs }), record({ body: { arrayValue: { values: items } } })]),
    );
    const [a, b] = readLines();
    expect(Object.keys(a.attributes)).toHaveLength(MAX_ATTRIBUTES);
    expect(a.truncated).toBe(true);
    expect(b.body).toHaveLength(MAX_ARRAY_ITEMS);
    expect(b.truncated).toBe(true);
  });

  it(`collapses nesting deeper than ${MAX_VALUE_DEPTH}`, async () => {
    let value: unknown = str('leaf');
    for (let i = 0; i < MAX_VALUE_DEPTH + 2; i++) value = { arrayValue: { values: [value] } };
    await ingest(request([record({ body: value })]));
    const [line] = readLines();
    let node = line.body;
    let depth = 0;
    while (Array.isArray(node)) {
      node = node[0];
      depth++;
    }
    expect(depth).toBe(MAX_VALUE_DEPTH);
    expect(node).toBe(TRUNCATION_MARKER);
    expect(line.truncated).toBe(true);
  });

  it('marks lines whose resource was truncated', async () => {
    await ingest(
      request([record()], {
        resource: { attributes: [{ key: 'x', value: str('r'.repeat(MAX_STRING_CHARS + 1)) }] },
      }),
    );
    expect(readLines()[0].truncated).toBe(true);
  });

  it(`rejects a record still over ${MAX_RECORD_BYTES} bytes after truncation`, async () => {
    const attrs = Array.from({ length: 20 }, (_, i) => ({
      key: `k${i}`,
      value: str('x'.repeat(MAX_STRING_CHARS)),
    }));
    const res = await ingest(request([record({ attributes: attrs }), record()]));
    expect(res.partialSuccess?.rejectedLogRecords).toBe(1);
    expect(res.partialSuccess?.errorMessage).toMatch(/after truncation/);
    expect(readLines()).toHaveLength(1);
  });

  it(`stops storing at ${MAX_BYTES_PER_CALL} bytes per call`, async () => {
    // ~245 KB per record, under the per-record cap.
    const attrs = Array.from({ length: 15 }, (_, i) => ({
      key: `k${i}`,
      value: str('x'.repeat(MAX_STRING_CHARS)),
    }));
    const res = await ingest(
      request(Array.from({ length: 20 }, () => record({ attributes: attrs }))),
    );
    expect(fs.statSync(fileFor()).size).toBeLessThanOrEqual(MAX_BYTES_PER_CALL);
    const kept = readLines().length;
    expect(kept).toBeGreaterThan(10);
    expect(res.partialSuccess?.rejectedLogRecords).toBe(20 - kept);
    expect(res.partialSuccess?.errorMessage).toMatch(/stored bytes/);
  });
});

describe('ingest_logs cost stays linear in request size', () => {
  /**
   * Count the characters the daemon serializes or measures while handling a
   * request. Linear handling touches each input byte a small constant number
   * of times; re-serializing a shared resource per record (the round-1
   * freeze) touches it once per record, ~1000x here. Machine-independent,
   * unlike a wall-clock bound.
   */
  async function charsProcessed(input: unknown): Promise<number> {
    let chars = 0;
    const stringify = JSON.stringify.bind(JSON);
    const byteLength = Buffer.byteLength.bind(Buffer);
    vi.spyOn(JSON, 'stringify').mockImplementation(((
      ...args: Parameters<typeof JSON.stringify>
    ) => {
      const out = stringify(...args);
      chars += out.length;
      return out;
    }) as typeof JSON.stringify);
    vi.spyOn(Buffer, 'byteLength').mockImplementation(((
      v: string | Buffer,
      enc?: BufferEncoding,
    ) => {
      if (typeof v === 'string') chars += v.length;
      return byteLength(v, enc);
    }) as typeof Buffer.byteLength);
    try {
      await ingest(input);
    } finally {
      vi.restoreAllMocks();
    }
    return chars;
  }

  it('serializes an oversize shared resource once, not per record', async () => {
    const chunk = 'x'.repeat(MAX_STRING_CHARS);
    const attrs = Array.from({ length: MAX_ATTRIBUTES }, (_, i) => ({
      key: `k${i}`,
      value: { arrayValue: { values: Array.from({ length: 5 }, () => str(chunk)) } },
    }));
    const input = request(
      Array.from({ length: MAX_RECORDS_PER_CALL }, () => ({ eventName: 'tiny' })),
      { resource: { attributes: attrs } },
    );
    const size = JSON.stringify(input).length;
    expect(size).toBeGreaterThan(10_000_000);
    expect(await charsProcessed(input)).toBeLessThan(3 * size);
  });

  it('serializes each near-limit shared resource once, not per record', async () => {
    const attrs = Array.from({ length: 15 }, (_, i) => ({
      key: `k${i}`,
      value: str('x'.repeat(MAX_STRING_CHARS)),
    }));
    const input = {
      resourceLogs: Array.from({ length: 40 }, () => ({
        resource: { attributes: attrs },
        scopeLogs: [{ logRecords: Array.from({ length: 25 }, () => ({ eventName: 'tiny' })) }],
      })),
    };
    const size = JSON.stringify(input).length;
    expect(size).toBeGreaterThan(9_500_000);
    expect(await charsProcessed(input)).toBeLessThan(3 * size);
    // The per-call byte cap still stores ~17 and rejects the rest.
    expect(readLines().length).toBeGreaterThan(10);
  });
});

describe('ingest_logs byte budget and quota markers', () => {
  const tiny: BudgetOptions = { capacityBytes: 3000, refillBytesPerMinute: 1 };

  it('refuses records past the budget and writes a daemon marker', async () => {
    const res = await ingest(
      request(Array.from({ length: 10 }, () => record())),
      'callboard',
      NOW,
      tiny,
    );
    const kept = clientLines().length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(10);
    expect(res.partialSuccess?.rejectedLogRecords).toBe(10 - kept);
    expect(res.partialSuccess?.errorMessage).toMatch(/budget exhausted/);

    const [m] = markers();
    expect(m).toMatchObject({
      'drawlatch.caller': 'callboard',
      'drawlatch.source': 'daemon',
      'drawlatch.event': 'quota_exceeded',
      'drawlatch.sequence': kept + 1,
      rejected_records: 10 - kept,
      window_start: NOW.toISOString(),
      window_end: NOW.toISOString(),
      budget: { capacity_bytes: 3000, refill_bytes_per_minute: 1 },
    });
    expect(m.rejected_bytes).toBeGreaterThan(0);
  });

  it('coalesces refusals into at most one marker per interval', async () => {
    const batch = request([record(), record(), record(), record(), record(), record()]);
    await ingest(batch, 'callboard', NOW, tiny);
    const first = markers()[0].rejected_records;

    const t1 = new Date(NOW.getTime() + 10_000);
    const t2 = new Date(NOW.getTime() + 20_000);
    await ingest(batch, 'callboard', t1, tiny);
    await ingest(batch, 'callboard', t2, tiny);
    expect(markers()).toHaveLength(1);

    const t3 = new Date(NOW.getTime() + QUOTA_MARKER_INTERVAL_MS + 1);
    await ingest(request([record()]), 'callboard', t3, tiny);
    const all = markers();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({
      rejected_records: 6 + 6 + 1,
      window_start: t1.toISOString(),
      window_end: t3.toISOString(),
    });
    expect(first).toBeGreaterThan(0);
  });

  it('writes a pending marker from the timer even if the client goes quiet', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    const batch = request(Array.from({ length: 6 }, () => record()));
    await ingest(batch, 'callboard', new Date(), tiny);
    vi.setSystemTime(NOW.getTime() + 5_000);
    await ingest(batch, 'callboard', new Date(), tiny);
    expect(markers()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(QUOTA_MARKER_INTERVAL_MS);
    vi.useRealTimers();
    await vi.waitFor(() => expect(markers()).toHaveLength(2));
    expect(markers()[1].rejected_records).toBe(6);
  });

  it('flushes pending markers on shutdown regardless of the interval', async () => {
    const batch = request(Array.from({ length: 6 }, () => record()));
    const now = new Date();
    await ingest(batch, 'callboard', now, tiny);
    await ingest(batch, 'callboard', new Date(now.getTime() + 1000), tiny);
    const file = fileFor('callboard', now.toISOString().slice(0, 10));
    expect(markers(file)).toHaveLength(1);

    await flushQuotaMarkers();
    expect(markers(file)).toHaveLength(2);
  });

  it('accepts records again once the bucket refills', async () => {
    const budget = { capacityBytes: 2000, refillBytesPerMinute: 60_000 };
    const batch = request(Array.from({ length: 6 }, () => record()));
    const first = await ingest(batch, 'callboard', NOW, budget);
    expect(first.partialSuccess?.rejectedLogRecords).toBeGreaterThan(0);

    const later = await ingest(
      request([record()]),
      'callboard',
      new Date(NOW.getTime() + 60_000),
      budget,
    );
    expect(later).toEqual({});
  });

  it('keeps budgets per caller', async () => {
    const batch = request(Array.from({ length: 6 }, () => record()));
    await ingest(batch, 'alpha', NOW, tiny);
    expect(await ingest(request([record()]), 'beta', NOW, tiny)).toEqual({});
  });

  /** An fs error the way a full disk reports it. */
  function enospc(): Error {
    return Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  }

  /** Make every append to a `.jsonl` file throw, until restored. */
  function failAppends(): void {
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const fh = await realOpen(...args);
      if (String(args[0]).endsWith('.jsonl')) {
        fh.appendFile = () => Promise.reject(enospc());
      }
      return fh;
    });
  }

  it('backs off a failing marker write and recovers once writes succeed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    const batch = request(Array.from({ length: 6 }, () => record()));
    await ingest(batch, 'callboard', new Date(), tiny);
    vi.setSystemTime(NOW.getTime() + 5_000);
    await ingest(batch, 'callboard', new Date(), tiny);
    expect(markers()).toHaveLength(1);

    // Fail without touching the disk, so fake time fully drives each attempt.
    const mkdir = vi.spyOn(fs.promises, 'mkdir').mockRejectedValue(enospc());
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (let t = 0; t < 15 * 60; t++) await vi.advanceTimersByTimeAsync(1000);

    // Without backoff this is one attempt per tick or a zero-delay spin;
    // with it: 60s, then +1, +2, +4 … capped at 5 min, ~11 attempts.
    const attempts = mkdir.mock.calls.length;
    expect(attempts).toBeGreaterThanOrEqual(5);
    expect(attempts).toBeLessThanOrEqual(15);
    expect(errors.mock.calls.length).toBeLessThanOrEqual(
      Math.ceil((15 * 60_000) / ERROR_LOG_WINDOW_MS) + 1,
    );
    // Rate-limited: retries inside one log window share one error line.
    expect(errors.mock.calls.length).toBeLessThan(attempts);

    mkdir.mockRestore();
    await vi.advanceTimersByTimeAsync(MARKER_RETRY_MAX_MS);
    vi.useRealTimers();
    await vi.waitFor(() => expect(markers()).toHaveLength(2));
    expect(markers()[1].rejected_records).toBe(6);
  });

  it('rate-limits error logging for repeated failed writes', async () => {
    failAppends();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (let i = 0; i < 20; i++) {
      await expect(ingest(request([record()]))).rejects.toThrow('audit write failed (ENOSPC)');
    }
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('arms the retry timer when the append carrying a due marker fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    const batch = request(Array.from({ length: 6 }, () => record()));
    await ingest(batch, 'callboard', new Date(), tiny);
    expect(markers()).toHaveLength(1);

    // A minute on, this call's marker is due and rides its append, which fails.
    vi.setSystemTime(NOW.getTime() + 61_000);
    failAppends();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(ingest(batch, 'callboard', new Date(), tiny)).rejects.toThrow(/ENOSPC/);
    vi.restoreAllMocks();

    // The disk is back and the caller is silent: only a timer can write it.
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(markers()).toHaveLength(2));
    expect(markers()[1].rejected_records).toBe(6);
  });

  it('writes the marker inline for a call that was in flight when shutdown began', async () => {
    const batch = request(Array.from({ length: 6 }, () => record()));
    await ingest(batch, 'callboard', NOW, tiny);
    expect(markers()).toHaveLength(1);

    // Started before shutdown, refused after it began, inside the interval.
    const inFlight = ingest(batch, 'callboard', new Date(NOW.getTime() + 5_000), tiny);
    beginAuditShutdown();
    await inFlight;
    // On disk before the reply, with no flush needed.
    expect(markers()).toHaveLength(2);
    expect(markers()[1].rejected_records).toBe(6);
  });

  it('refuses new calls once shutdown has begun', async () => {
    beginAuditShutdown();
    await expect(ingest(request([record()]))).rejects.toThrow('server shutting down');
    expect(fs.existsSync(root)).toBe(false);
  });

  it('keeps a marker’s counts when the append carrying it fails', async () => {
    const batch = request(Array.from({ length: 6 }, () => record()));
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    await ingest(request(Array.from({ length: 10 }, () => record())), 'callboard', NOW, tiny);
    expect(markers()).toHaveLength(1);
    await ingest(batch, 'callboard', at(10_000), tiny); // 6 pending

    failAppends();
    // Due now: this append carries the marker for 12 refusals, and fails.
    await expect(ingest(batch, 'callboard', at(61_000), tiny)).rejects.toThrow(/ENOSPC/);
    vi.restoreAllMocks();

    await ingest(batch, 'callboard', at(62_000), tiny);
    const all = markers();
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({
      rejected_records: 6 + 6 + 6,
      window_start: at(10_000).toISOString(),
      window_end: at(62_000).toISOString(),
    });
  });

  it('refunds the budget for records whose append failed', async () => {
    const five = request(Array.from({ length: 5 }, () => record()));
    await ingest(five, 'probe');
    const budget = {
      capacityBytes: fs.statSync(fileFor('probe')).size + 50,
      refillBytesPerMinute: 1,
    };

    failAppends();
    await expect(ingest(five, 'callboard', NOW, budget)).rejects.toThrow(/ENOSPC/);
    vi.restoreAllMocks();

    expect(await ingest(five, 'callboard', NOW, budget)).toEqual({});
  });

  it('never writes markers past the daily allowance', async () => {
    const budget = { ...tiny, markerHeadroomBytesPerDay: 700 };
    const batch = request(Array.from({ length: 6 }, () => record()));
    await ingest(batch, 'callboard', NOW, budget);
    expect(markers()).toHaveLength(1);

    // Due, but a second ~430-byte marker doesn't fit in 700 bytes.
    await ingest(batch, 'callboard', new Date(NOW.getTime() + 61_000), budget);
    await flushQuotaMarkers();
    expect(markers()).toHaveLength(1);
  });

  it('never holds the process open with a marker timer', async () => {
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    const batch = request(Array.from({ length: 6 }, () => record()));
    await ingest(batch, 'callboard', NOW, tiny);
    await ingest(batch, 'callboard', new Date(NOW.getTime() + 5_000), tiny);

    const timers = timeouts.mock.results.map((r) => r.value as NodeJS.Timeout);
    expect(timers.length).toBeGreaterThan(0);
    expect(timers.map((t) => t.hasRef())).toEqual(timers.map(() => false));
  });

  it('bounds the shutdown flush when the disk hangs', async () => {
    const batch = request(Array.from({ length: 6 }, () => record()));
    await ingest(batch, 'callboard', NOW, tiny);
    await ingest(batch, 'callboard', new Date(NOW.getTime() + 5_000), tiny);
    vi.spyOn(fs.promises, 'mkdir').mockReturnValue(new Promise(() => undefined));

    // Without the bound this never resolves and the test times out.
    await flushQuotaMarkersWithin(50);
  }, 5_000);

  it('a client cannot forge a daemon line', async () => {
    await ingest(
      request([
        record({
          'drawlatch.source': 'daemon',
          'drawlatch.event': 'quota_exceeded',
          attributes: [{ key: 'drawlatch.source', value: str('daemon') }],
        }),
      ]),
    );
    const [line] = readLines<Record<string, unknown>>();
    expect(line['drawlatch.source']).toBe('client');
    expect(line).not.toHaveProperty('drawlatch.event');
    expect(line.extra).toEqual({
      'logRecord["drawlatch.source"]': 'daemon',
      'logRecord["drawlatch.event"]': 'quota_exceeded',
    });
  });
});

describe('ingest_logs caller stamping', () => {
  it('stamps the authenticated caller whatever the payload claims', async () => {
    await ingest(
      request(
        [
          record({
            'drawlatch.caller': 'admin',
            'drawlatch.sequence': 999,
            attributes: [
              { key: 'drawlatch.caller', value: str('admin') },
              { key: 'drawlatch.received_at', value: str('1970-01-01T00:00:00Z') },
            ],
          }),
        ],
        { resource: { attributes: [{ key: 'drawlatch.caller', value: str('admin') }] } },
      ),
      'callboard',
    );
    const [line] = readLines();
    expect(line['drawlatch.caller']).toBe('callboard');
    expect(line['drawlatch.sequence']).toBe(1);
    expect(line['drawlatch.received_at']).toBe(NOW.toISOString());
    // The claims survive only as nested, client-supplied data.
    expect(line.attributes['drawlatch.caller']).toBe('admin');
    expect(line.resource['drawlatch.caller']).toBe('admin');
    expect(line.extra?.['logRecord["drawlatch.caller"]']).toBe('admin');
    expect(fs.existsSync(path.join(root, 'admin'))).toBe(false);
  });

  it('stamps win over any record field with the same key', () => {
    const [rec] = parseIngestRequest(request([record()])).records;
    // parseRecord only emits fixed keys today; the renderer must not rely on it.
    Object.assign(rec.fields, {
      'drawlatch.caller': 'evil',
      'drawlatch.sequence': 999,
      'drawlatch.source': 'daemon',
    });
    const stamps = {
      'drawlatch.caller': 'callboard',
      'drawlatch.received_at': NOW.toISOString(),
      'drawlatch.sequence': 7,
    };
    const line = JSON.parse(renderParts(rec, stamps).parts.join('')) as Record<string, unknown>;
    expect(line).toMatchObject({ ...stamps, 'drawlatch.source': 'client' });
    expect(Object.keys(line).slice(0, 4)).toEqual([...Object.keys(stamps), 'drawlatch.source']);
  });

  it('keeps callers in separate directories and sequences', async () => {
    await ingest(request([record()]), 'alpha');
    await ingest(request([record(), record()]), 'beta');
    expect(readLines(fileFor('alpha')).map((l) => l['drawlatch.sequence'])).toEqual([1]);
    expect(readLines(fileFor('beta')).map((l) => l['drawlatch.sequence'])).toEqual([1, 2]);
  });
});

describe('ingest_logs path safety', () => {
  it.each(['..', '.', '../evil', 'a/b', 'a\\b', '', '-lead', 'a\0b', 'x'.repeat(129), '/abs'])(
    'refuses caller alias %j',
    async (alias) => {
      expect(() => auditCallerDir(root, alias)).toThrow(/safe path segment/);
      await expect(ingest(request([record()]), alias)).rejects.toThrow(/safe path segment/);
    },
  );

  it('writes nothing outside the audit root for a refused alias', async () => {
    await expect(ingest(request([record()]), '../escape')).rejects.toThrow();
    // `parent` is private to this test, so this can't see another run's leftovers.
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('accepts ordinary aliases', () => {
    expect(auditCallerDir(root, 'callboard_2-x')).toBe(path.join(root, 'callboard_2-x'));
  });
});

describe('ingest_logs append-only writes', () => {
  it('serializes concurrent calls into whole, contiguous lines', async () => {
    const calls = 40;
    const perCall = 25;
    const pad = 'p'.repeat(4000);
    await Promise.all(
      Array.from({ length: calls }, (_, c) =>
        ingest(
          request(
            Array.from({ length: perCall }, (_, r) => record({ body: str(`${c}:${r}:${pad}`) })),
          ),
        ),
      ),
    );

    const lines = readLines();
    expect(lines).toHaveLength(calls * perCall);
    expect(lines.map((l) => l['drawlatch.sequence'])).toEqual(
      Array.from({ length: calls * perCall }, (_, i) => i + 1),
    );
    // Each call's records land together and in order.
    for (let i = 0; i < lines.length; i += perCall) {
      const chunk = lines.slice(i, i + perCall).map((l) => (l.body as string).split(':'));
      expect(new Set(chunk.map(([c]) => c)).size).toBe(1);
      expect(chunk.map(([, r]) => Number(r))).toEqual(Array.from({ length: perCall }, (_, r) => r));
    }
  });

  it('continues the sequence after a restart', async () => {
    await ingest(request([record(), record()]));
    resetAuditLogState();
    await ingest(request([record()]));
    expect(readLines().map((l) => l['drawlatch.sequence'])).toEqual([1, 2, 3]);
  });

  it('isolates a torn last line left by a crash', async () => {
    await ingest(request([record()]));
    fs.appendFileSync(fileFor(), '{"drawlatch.caller":"callboard","drawlatch.seq');
    resetAuditLogState();
    await ingest(request([record()]));

    const raw = fs.readFileSync(fileFor(), 'utf8').split('\n');
    expect(raw[1]).toBe('{"drawlatch.caller":"callboard","drawlatch.seq');
    expect((JSON.parse(raw[2]) as AuditLine)['drawlatch.sequence']).toBe(2);
  });

  it('keeps sequences unique after an append that fails partway', async () => {
    await ingest(request([record()]));

    // The next append writes two whole lines and a torn third, then fails
    // the way a full disk does.
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const fh = await realOpen(...args);
      if (!String(args[0]).endsWith('.jsonl')) return fh;
      const realAppend = fh.appendFile.bind(fh);
      fh.appendFile = async (data: string | Uint8Array) => {
        const text = String(data);
        const cut = text.indexOf('\n', text.indexOf('\n') + 1) + 1 + 10;
        await realAppend(text.slice(0, cut));
        throw Object.assign(
          new Error(`ENOSPC: no space left on device, write '${String(args[0])}'`),
          {
            code: 'ENOSPC',
          },
        );
      };
      return fh;
    });
    const failed = ingest(request([record(), record(), record(), record()]));
    await expect(failed).rejects.toThrow('ingest_logs: audit write failed (ENOSPC)');
    await expect(failed).rejects.not.toThrow(new RegExp(parent));
    vi.restoreAllMocks();

    await ingest(request([record(), record()]));
    // The torn line stays (append-only) on its own line; every whole line
    // has a unique sequence continuing from what actually reached the disk.
    const raw = fs.readFileSync(fileFor(), 'utf8').trimEnd().split('\n');
    const whole = raw.flatMap((l) => {
      try {
        return [(JSON.parse(l) as AuditLine)['drawlatch.sequence']];
      } catch {
        return [];
      }
    });
    expect(raw).toHaveLength(6);
    expect(whole).toEqual([1, 2, 3, 4, 5]);
  });

  it('never rewrites earlier lines', async () => {
    await ingest(request([record()]));
    const before = fs.readFileSync(fileFor(), 'utf8');
    await ingest(request([record({ eventName: 'second' })]));
    expect(fs.readFileSync(fileFor(), 'utf8').startsWith(before)).toBe(true);
  });

  it('fsyncs the parent directory only when it creates an entry', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    const opened: string[] = [];
    vi.spyOn(fs.promises, 'open').mockImplementation((...args) => {
      if (args[1] === 'r') opened.push(String(args[0]));
      return realOpen(...args);
    });
    await ingest(request([record()]));
    expect(opened.sort()).toEqual([parent, root, path.join(root, 'callboard')].sort());

    opened.length = 0;
    await ingest(request([record()]));
    expect(opened).toEqual([]);

    await ingest(request([record()]), 'callboard', new Date('2026-10-12T00:00:01Z'));
    expect(opened).toEqual([path.join(root, 'callboard')]);
  });

  it('starts a fresh sequence for each day', async () => {
    await ingest(request([record(), record()]));
    await ingest(request([record()]), 'callboard', new Date('2026-10-12T00:00:01Z'));
    // A batch received before midnight but written after still continues its own file.
    await ingest(request([record()]), 'callboard', new Date('2026-10-11T23:59:59Z'));
    expect(readLines().map((l) => l['drawlatch.sequence'])).toEqual([1, 2, 3]);
    expect(
      readLines(fileFor('callboard', '2026-10-12')).map((l) => l['drawlatch.sequence']),
    ).toEqual([1]);
  });
});

describe('ingest_logs file modes', () => {
  it('creates 0600 files and 0700 dirs even under a permissive umask', async () => {
    const old = process.umask(0);
    try {
      await ingest(request([record()]));
    } finally {
      process.umask(old);
    }
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(root, 'callboard')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(fileFor()).mode & 0o777).toBe(0o600);
  });

  it('tightens pre-existing loose permissions', async () => {
    fs.mkdirSync(path.join(root, 'callboard'), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.join(root, 'callboard'), 0o755);
    fs.writeFileSync(fileFor(), '', { mode: 0o644 });
    fs.chmodSync(fileFor(), 0o644);
    await ingest(request([record()]));
    expect(fs.statSync(path.join(root, 'callboard')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(fileFor()).mode & 0o777).toBe(0o600);
  });
});

describe('parseIngestRequest', () => {
  it('does no I/O and reports counts', () => {
    const parsed = parseIngestRequest(request([record(), 'bad']));
    expect(parsed.records).toHaveLength(1);
    expect(parsed.rejected).toBe(1);
  });
});

describe('appendDaemonEvent', () => {
  it('appends a stamped daemon line that shares the file sequence with client lines', async () => {
    await ingest(request([record()]));
    await appendDaemonEvent(
      'callboard',
      { 'drawlatch.event': 'vault.reveal', 'vault.item': 'gh' },
      { auditRoot: root, now: NOW },
    );
    const lines = readLines<Record<string, unknown>>();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toEqual({
      'drawlatch.caller': 'callboard',
      'drawlatch.received_at': NOW.toISOString(),
      'drawlatch.sequence': 2,
      'drawlatch.source': 'daemon',
      'drawlatch.event': 'vault.reveal',
      'vault.item': 'gh',
    });
    expect(fs.statSync(fileFor()).mode & 0o777).toBe(0o600);
  });

  it('never lets fields override the stamps', async () => {
    await appendDaemonEvent(
      'callboard',
      {
        'drawlatch.event': 'x',
        'drawlatch.caller': 'mallory',
        'drawlatch.source': 'client',
        'drawlatch.sequence': 99,
      },
      { auditRoot: root, now: NOW },
    );
    const [line] = readLines<Record<string, unknown>>();
    expect(line['drawlatch.caller']).toBe('callboard');
    expect(line['drawlatch.source']).toBe('daemon');
    expect(line['drawlatch.sequence']).toBe(1);
  });

  it('is not charged to the caller byte budget', async () => {
    const budget = { capacityBytes: 1, refillBytesPerMinute: 1 };
    await ingest(request([record()]), 'callboard', NOW, budget);
    await appendDaemonEvent('callboard', { 'drawlatch.event': 'x' }, { auditRoot: root, now: NOW });
    const daemon = readLines<Record<string, unknown>>().filter((l) => l['drawlatch.event'] === 'x');
    expect(daemon).toHaveLength(1);
  });

  it('refuses an unsafe caller alias and an oversized line', async () => {
    await expect(
      appendDaemonEvent('../x', { 'drawlatch.event': 'x' }, { auditRoot: root }),
    ).rejects.toThrow(/safe path segment/);
    await expect(
      appendDaemonEvent(
        'callboard',
        { 'drawlatch.event': 'x', big: 'a'.repeat(MAX_RECORD_BYTES) },
        { auditRoot: root },
      ),
    ).rejects.toThrow(/exceeds/);
  });

  it('rejects with the error code only when the write fails', async () => {
    fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(root, 'not a directory');
    const err = await appendDaemonEvent(
      'callboard',
      { 'drawlatch.event': 'x' },
      { auditRoot: root },
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^audit write failed \(E[A-Z]+\)$/);
    expect((err as Error).message).not.toContain(parent);
  });
});
