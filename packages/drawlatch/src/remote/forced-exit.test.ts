/**
 * The daemon's forced-exit wiring: `main()`'s shutdown handler arms
 * armForcedExit(), which fires at SHUTDOWN_FORCE_EXIT_MS and flushes pending
 * audit quota markers before exiting.
 *
 * SHUTDOWN_FORCE_EXIT_MS is mocked to an unusual value, so a timer that
 * hardcodes a delay (even the real 10 s) instead of using the shared constant
 * fails here: `drawlatch stop` derives its SIGKILL window from that constant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORCE_EXIT_MS = 1234;

vi.mock('../shared/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shared/config.js')>()),
  SHUTDOWN_FORCE_EXIT_MS: FORCE_EXIT_MS,
}));

const { armForcedExit } = await import('./server.js');
const { ingestLogs, resetAuditLogState } = await import('./audit-log.js');

const here = path.dirname(fileURLToPath(import.meta.url));

let parent: string;
let root: string;

beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'drawlatch-forced-exit-'));
  root = path.join(parent, 'audit');
  resetAuditLogState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetAuditLogState();
  fs.rmSync(parent, { recursive: true, force: true });
});

function markerCount(): number {
  const dir = path.join(root, 'gina');
  if (!fs.existsSync(dir)) return 0;
  return fs
    .readdirSync(dir)
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n'))
    .filter((l) => l.includes('"drawlatch.source":"daemon"')).length;
}

describe('armForcedExit', () => {
  it('fires at SHUTDOWN_FORCE_EXIT_MS and flushes markers before exiting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const now = Date.now();
    const batch = {
      resourceLogs: [{ scopeLogs: [{ logRecords: [{ eventName: 'flood' }] }] }],
    };
    const budget = { capacityBytes: 1, refillBytesPerMinute: 1 };
    const flood = (ms: number) =>
      ingestLogs(batch, 'gina', { auditRoot: root, budget, now: new Date(now + ms) });
    await flood(0); // marker written inline
    await flood(1000); // pending
    expect(markerCount()).toBe(1);

    // A real exit never returns: record what is on disk at the call.
    let atExit = -1;
    const exit = vi.fn(() => {
      atExit = markerCount();
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const timer = armForcedExit(exit);
    expect(timer.hasRef()).toBe(false);

    await vi.advanceTimersByTimeAsync(FORCE_EXIT_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(atExit).toBe(2);
  });

  it("is what main()'s shutdown handler arms, with no exit of its own", () => {
    const src = fs.readFileSync(path.join(here, 'server.ts'), 'utf8');
    const handler = /const shutdown = \(\) => \{([\s\S]*?)\n {2}\};/.exec(src)?.[1];
    expect(handler).toBeDefined();
    expect(handler).toContain('armForcedExit();');
    // The graceful path exits 0 once closed; any other exit here would skip
    // the forced-exit flush.
    expect(handler?.match(/process\.exit\(/g)).toEqual(['process.exit(']);
    expect(handler).toContain('process.exit(0)');
  });
});
