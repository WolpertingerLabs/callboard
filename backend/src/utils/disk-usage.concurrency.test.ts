/**
 * The cap on concurrent `du`.
 *
 * Splitting `du` off the event loop is only half the fix; the other half is not
 * replacing one stall with another. Measured on 34 worktrees, running every
 * measurement at once cut the listing's wall clock by 7% over running eight, and
 * cost 100ms of event-loop stall to do it — because `du` on a warm page cache is
 * CPU, not I/O-wait, so saturating every core starves the daemon's own loop. The
 * cap is what keeps the fix from undoing itself, which makes it worth a test
 * that cannot pass by accident.
 *
 * `du` is faked here rather than run. The point is to hold measurements open on
 * purpose and count exactly how many the pool allowed to start, which real
 * subprocesses finishing in a millisecond cannot be made to demonstrate
 * reliably.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The directories have to be real: a missing one is answered without ever
// reaching `du`, which is a property the other suite pins and this one relies on
// not tripping over.
const root = mkdtempSync(join(tmpdir(), "callboard-du-pool-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const dir = (name: string): string => {
  const full = join(root, name);
  mkdirSync(full, { recursive: true });
  return full;
};

/** Every fake `du` currently in flight, keyed in call order, with its release. */
const inFlight: Array<{ directory: string; finish: (kb: number) => void }> = [];
let started: string[] = [];
let peak = 0;

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    execFile: (_cmd: string, args: string[], _opts: unknown, cb: (e: unknown, out: string) => void) => {
      const directory = args[args.length - 1];
      started.push(directory);
      const entry = {
        directory,
        finish: (kb: number) => {
          const at = inFlight.indexOf(entry);
          if (at >= 0) inFlight.splice(at, 1);
          cb(null, `${kb}\t${directory}\n`);
        },
      };
      inFlight.push(entry);
      if (inFlight.length > peak) peak = inFlight.length;
      return {} as never;
    },
  };
});

// Imported after the mock so the module under test binds the faked `execFile`.
const { clearDiskUsageCache, DISK_USAGE_CONCURRENCY, newAsyncDiskUsageBudget } = await import("./disk-usage.js");

/** Let the pool's microtasks run, so anything it is going to start has started. */
const settleTicks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Release everything currently open, repeatedly, until the pool drains. */
async function drain(): Promise<void> {
  for (let guard = 0; guard < 500 && inFlight.length > 0; guard++) {
    for (const entry of [...inFlight]) entry.finish(8);
    await settleTicks();
  }
}

beforeEach(() => {
  clearDiskUsageCache();
  inFlight.length = 0;
  started = [];
  peak = 0;
});

afterEach(() => {
  for (const entry of [...inFlight]) entry.finish(8);
});

describe("the daemon-wide du pool", () => {
  it("starts no more than the cap, and starts the next only as one finishes", async () => {
    const budget = newAsyncDiskUsageBudget();
    const wanted = DISK_USAGE_CONCURRENCY * 3;
    for (let i = 0; i < wanted; i++) budget.measure(dir(`m-${i}`));

    const done = budget.settle();
    await settleTicks();

    // The whole listing was registered up front, so an unbounded implementation
    // would have all `wanted` open right now.
    expect(inFlight.length).toBe(DISK_USAGE_CONCURRENCY);
    expect(started.length).toBe(DISK_USAGE_CONCURRENCY);

    // Finish exactly one. Exactly one more may start — no more.
    inFlight[0].finish(16);
    await settleTicks();
    expect(inFlight.length).toBe(DISK_USAGE_CONCURRENCY);
    expect(started.length).toBe(DISK_USAGE_CONCURRENCY + 1);

    await drain();
    await done;
    expect(started.length).toBe(wanted);
    expect(peak).toBe(DISK_USAGE_CONCURRENCY);
  });

  it("shares the cap across concurrent listings rather than giving each its own", async () => {
    // Two tabs opening the Manage modal at once. A per-listing cap would allow
    // 2 × DISK_USAGE_CONCURRENCY processes, which is the thing the cap exists to
    // prevent.
    const first = newAsyncDiskUsageBudget();
    const second = newAsyncDiskUsageBudget();
    for (let i = 0; i < DISK_USAGE_CONCURRENCY; i++) first.measure(dir(`first-${i}`));
    for (let i = 0; i < DISK_USAGE_CONCURRENCY; i++) second.measure(dir(`second-${i}`));

    const done = Promise.all([first.settle(), second.settle()]);
    await settleTicks();

    expect(inFlight.length).toBe(DISK_USAGE_CONCURRENCY);

    await drain();
    await done;
    expect(peak).toBe(DISK_USAGE_CONCURRENCY);
    expect(started.length).toBe(DISK_USAGE_CONCURRENCY * 2);
  });

  it("runs one du for a directory two rows both asked for", async () => {
    const budget = newAsyncDiskUsageBudget();
    const shared = dir("shared");
    const a = budget.measure(shared);
    const b = budget.measure(shared);

    const done = budget.settle();
    await settleTicks();
    expect(started).toEqual([shared]);

    await drain();
    await done;
    expect(a.bytes).toBe(8 * 1024);
    expect(b.bytes).toBe(8 * 1024);
  });

  it("checks the deadline when a slot comes free, not when the row registered", async () => {
    // Every measurement is registered at time zero, so a budget that checked its
    // deadline on registration could never skip anything at all.
    let clock = 0;
    const budget = newAsyncDiskUsageBudget({ budgetMs: 100, concurrency: 1, now: () => clock });
    const wanted = 4;
    const usages = Array.from({ length: wanted }, (_, i) => budget.measure(dir(`late-${i}`)));

    const done = budget.settle();
    await settleTicks();
    expect(started.length).toBe(1); // registration alone started nothing beyond the first slot

    // The first measurement takes longer than the whole listing's budget.
    clock = 150;
    await drain();
    await done;

    expect(started.length).toBe(1); // nothing started after the deadline passed
    expect(budget.skipped).toBe(wanted - 1);
    expect(usages[0].bytes).toBe(8 * 1024);
    for (const usage of usages.slice(1)) {
      expect(usage.bytes).toBeUndefined();
      expect(usage.error).toContain("budget");
    }
    expect(budget.note(wanted)).toContain(`${wanted - 1} of ${wanted}`);
  });
});
