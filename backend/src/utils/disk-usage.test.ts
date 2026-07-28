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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newDiskUsageBudget } from "./disk-usage.js";

const root = mkdtempSync(join(tmpdir(), "callboard-disk-budget-"));
writeFileSync(join(root, "a.txt"), "x".repeat(4096));
afterAll(() => rmSync(root, { recursive: true, force: true }));

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
