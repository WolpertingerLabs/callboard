/**
 * The spend limit on `du`.
 *
 * `execFileSync` blocks the event loop — measured: zero timer ticks during a
 * 56ms `du` — so a listing that measures N directories with only a per-entry
 * timeout is N × 15s of daemon that serves no HTTP, flushes no SSE and fires no
 * timer. The per-directory ceiling is not a bound on a listing; this is.
 *
 * The other half of the property is that a skip is never silent. A missing size
 * that says nothing reads as "this directory is small", which is the opposite
 * of true for everything in these listings.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearDiskUsageCache, newAsyncDiskUsageBudget, newDiskUsageBudget } from "./disk-usage.js";

const root = mkdtempSync(join(tmpdir(), "callboard-disk-budget-"));
writeFileSync(join(root, "a.txt"), "x".repeat(4096));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** `n` distinct real directories, so a budget has something to parallelise over. */
function dirs(n: number, label: string): string[] {
  return Array.from({ length: n }, (_, i) => {
    const dir = join(root, `${label}-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "f.txt"), "x".repeat(2048));
    return dir;
  });
}

describe("the listing budget", () => {
  it("measures while there is budget left", () => {
    const budget = newDiskUsageBudget();
    expect(budget.measure(root).bytes).toBeGreaterThan(0);
    expect(budget.skipped).toBe(0);
    expect(budget.note()).toBeUndefined();
  });

  it("stops measuring once the wall clock is spent", () => {
    let clock = 1000;
    const budget = newDiskUsageBudget({ budgetMs: 100, now: () => clock });
    expect(budget.measure(root).bytes).toBeGreaterThan(0);

    clock += 100;
    const skipped = budget.measure(root);
    expect(skipped.bytes).toBeUndefined();
    expect(skipped.error).toContain("budget");
    expect(budget.skipped).toBe(1);
  });

  /** A skipped measurement is reported per entry *and* summarised for the listing. */
  it("gives the listing a sentence to surface", () => {
    const budget = newDiskUsageBudget({ budgetMs: 0 });
    budget.measure(root);
    budget.measure(root);
    expect(budget.note(5)).toContain("2 of 5");
    expect(budget.note(5)).toContain("du -sh");
  });
});

/**
 * The async budget carries the same contract off the event loop. The properties
 * below are the ones a caller and a reviewer actually depend on; each is written
 * so that removing the line of production code it covers fails it.
 */
describe("the async listing budget", () => {
  beforeEach(() => clearDiskUsageCache());

  it("fills in the placeholders it handed out while the rows were being built", async () => {
    const budget = newAsyncDiskUsageBudget();
    const [a, b] = dirs(2, "fill");

    // Exactly how a row builder uses it: synchronous call, value stored in a row.
    const first = budget.measure(a);
    const second = budget.measure(b);
    // Nothing has been measured yet — and the unfilled value says so out loud
    // rather than looking like a directory of unknown size.
    expect(first.bytes).toBeUndefined();
    expect(first.error).toContain("did not settle");

    await budget.settle();

    expect(first.bytes).toBeGreaterThan(0);
    expect(second.bytes).toBeGreaterThan(0);
    // The placeholder error is replaced, not merged alongside the total.
    expect(first.error).toBeUndefined();
    expect(budget.note()).toBeUndefined();
  });

  it("bounds the total: once the budget is spent nothing further is started", async () => {
    let clock = 1000;
    const budget = newAsyncDiskUsageBudget({ budgetMs: 50, concurrency: 1, now: () => clock });
    const all = dirs(4, "spend");
    const usages = all.map((dir) => budget.measure(dir));

    // Advance past the deadline after the first dispatch, so the tail is skipped.
    const tick = setInterval(() => {
      clock += 40;
    }, 1);
    await budget.settle();
    clearInterval(tick);

    expect(budget.skipped).toBeGreaterThan(0);
    const skippedOnes = usages.filter((u) => u.error?.includes("budget"));
    expect(skippedOnes.length).toBe(budget.skipped);
    for (const usage of skippedOnes) expect(usage.bytes).toBeUndefined();
  });

  it("sets a note the listing can surface when it runs out", async () => {
    const budget = newAsyncDiskUsageBudget({ budgetMs: 0 });
    const [a, b] = dirs(2, "note");
    budget.measure(a);
    budget.measure(b);
    await budget.settle();

    expect(budget.skipped).toBe(2);
    expect(budget.note(5)).toContain("2 of 5");
    expect(budget.note(5)).toContain("du -sh");
  });

  it("does not measure a directory that is missing", async () => {
    const budget = newAsyncDiskUsageBudget();
    const gone = join(root, "no-such-directory");
    const usage = budget.measure(gone);
    await budget.settle();

    expect(usage.bytes).toBeUndefined();
    expect(usage.error).toContain("does not exist");
    // Absent, not skipped — a missing directory is not a budget casualty, and
    // conflating the two would put a misleading note on the listing.
    expect(budget.skipped).toBe(0);
    expect(budget.note()).toBeUndefined();
  });

  it("hits the memo instead of re-running du", async () => {
    const [dir] = dirs(1, "memo");

    const cold = newAsyncDiskUsageBudget();
    const first = cold.measure(dir);
    await cold.settle();
    expect(first.bytes).toBeGreaterThan(0);

    // Grow the directory. A second budget that re-ran `du` would see the new
    // size; one that reads the five-minute memo reports the old one.
    writeFileSync(join(dir, "big.txt"), "y".repeat(512 * 1024));
    const warm = newAsyncDiskUsageBudget();
    const second = warm.measure(dir);
    await warm.settle();
    expect(second.bytes).toBe(first.bytes);

    // ...and clearing the memo is what makes the growth visible, which is the
    // property the callers that move directories depend on.
    clearDiskUsageCache();
    const fresh = newAsyncDiskUsageBudget();
    const third = fresh.measure(dir);
    await fresh.settle();
    expect(third.bytes).toBeGreaterThan(first.bytes!);
  });

  /**
   * `cached: false` is a read/write split, not an opt-out: skip the memo, still
   * populate it. A scan is the most expensive measurement in the daemon, and
   * dropping the write leaves the next polled listing paying for the same
   * directories again.
   */
  it("re-measures without the memo, and still publishes what it measured", async () => {
    const [dir] = dirs(1, "uncached");

    const seed = newAsyncDiskUsageBudget();
    const before = seed.measure(dir);
    await seed.settle();

    writeFileSync(join(dir, "grew.txt"), "y".repeat(512 * 1024));

    // Skips the read: strictly larger than the memo holds, which a budget that
    // consulted the memo could not report.
    const fresh = newAsyncDiskUsageBudget({ cached: false });
    const grown = fresh.measure(dir);
    await fresh.settle();
    expect(grown.bytes).toBeGreaterThan(before.bytes!);

    // Keeps the write. Grown a second time first, so that a cold memo and a live
    // one give different answers — without this, a budget that published nothing
    // would re-run `du` and land on the same number by coincidence.
    writeFileSync(join(dir, "grew-again.txt"), "z".repeat(512 * 1024));
    const after = newAsyncDiskUsageBudget();
    const recalled = after.measure(dir);
    await after.settle();
    expect(recalled.bytes).toBe(grown.bytes);
  });

  /**
   * The stray-call fallback obeys the same split. Unreachable from this
   * codebase — nothing measures after settling — but an aspirational contract
   * is how the two halves drift apart, so it is pinned rather than described.
   */
  it("keeps the read/write split on a measure() that arrives after settle()", async () => {
    const [dir] = dirs(1, "stray");

    const seed = newAsyncDiskUsageBudget();
    const before = seed.measure(dir);
    await seed.settle();

    writeFileSync(join(dir, "grew.txt"), "y".repeat(512 * 1024));

    const budget = newAsyncDiskUsageBudget({ cached: false });
    await budget.settle(); // nothing registered; the budget is now spent
    const strayed = budget.measure(dir);
    // Skipped the read: the memo still holds the pre-growth number.
    expect(strayed.bytes).toBeGreaterThan(before.bytes!);
    expect(strayed.error).toBeUndefined();

    // Kept the write. Grown again first, so only a memo the stray call populated
    // can produce `strayed.bytes` here.
    writeFileSync(join(dir, "grew-again.txt"), "z".repeat(512 * 1024));
    const after = newAsyncDiskUsageBudget();
    const recalled = after.measure(dir);
    await after.settle();
    expect(recalled.bytes).toBe(strayed.bytes);
  });

  it("fills every row that asked for the same directory", async () => {
    const [dir] = dirs(1, "shared");
    const budget = newAsyncDiskUsageBudget();
    // Two workspaces on one cwd is a supported state, not a bug. That it costs
    // one `du` rather than two is pinned in disk-usage.concurrency.test.ts.
    const a = budget.measure(dir);
    const b = budget.measure(join(dir, ".", ""));
    await budget.settle();

    expect(a.bytes).toBeGreaterThan(0);
    expect(b.bytes).toBe(a.bytes);
  });

  it("is safe to settle twice, and is not left holding placeholders", async () => {
    const budget = newAsyncDiskUsageBudget();
    const usage = budget.measure(dirs(1, "twice")[0]);
    await budget.settle();
    const measured = usage.bytes;
    await budget.settle();
    expect(usage.bytes).toBe(measured);
  });

  /**
   * The dangerous half of idempotence. A `settled` boolean makes the *second*
   * call resolve immediately — before the first has filled anything in — so a
   * caller that awaited it would serialise placeholders while believing it had
   * waited. Awaiting either call has to mean the same thing.
   */
  it("makes a second settle already in flight wait for the first", async () => {
    const budget = newAsyncDiskUsageBudget();
    const usage = budget.measure(dirs(1, "inflight")[0]);

    const first = budget.settle();
    const second = budget.settle();
    expect(second).toBe(first); // the same run, not a fresh resolved promise

    await second;
    expect(usage.bytes).toBeGreaterThan(0);
    expect(usage.error).toBeUndefined();

    await first;
  });
});
