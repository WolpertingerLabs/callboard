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
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newAsyncDiskUsageBudget } from "./disk-usage.js";

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

/**
 * The budget, off the event loop. The properties
 * below are the ones a caller and a reviewer actually depend on; each is written
 * so that removing the line of production code it covers fails it.
 */
describe("the async listing budget", () => {
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

  it("still returns a real number for a measure() that arrives after settle()", async () => {
    const [dir] = dirs(1, "stray");
    const budget = newAsyncDiskUsageBudget();
    await budget.settle(); // nothing registered; the budget is now spent
    const strayed = budget.measure(dir);
    expect(strayed.bytes).toBeGreaterThan(0);
    expect(strayed.error).toBeUndefined();
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
