/**
 * How much disk a directory occupies.
 *
 * Exists for one reason: worktrees are the biggest thing Callboard leaks, and
 * "43 directories" is not a number anyone acts on — "40 GB" is. Adoption
 * discovery reports it per candidate so the human deciding what to adopt can
 * start with the expensive ones.
 *
 * `du -sk` rather than a recursive walk in Node: `-s` and `-k` are both POSIX,
 * it counts blocks actually allocated rather than apparent size, and a
 * `node_modules` that would take a JS walk tens of seconds takes it a fraction
 * of that. It is still slow enough to need a timeout and a budget, which is why
 * a measurement can legitimately come back absent — a missing number is never
 * fatal here, it is just a column a caller cannot sort on.
 */
import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import type { WorktreeDiskUsage } from "shared/types/index.js";

/** Per-directory ceiling. A cold `node_modules` on a slow disk is seconds. */
export const DISK_USAGE_TIMEOUT_MS = 15000;

/**
 * Total wall-clock budget for measuring disk usage across ONE listing.
 *
 * The per-directory timeout above is not a bound on a listing: `execFileSync`
 * blocks the event loop, so N entries with nothing but a per-entry ceiling is
 * N × {@link DISK_USAGE_TIMEOUT_MS} of frozen daemon — no HTTP served, no SSE
 * flushed, no timer fired. Every listing that measures more than one directory
 * therefore shares one budget, and entries past it report a labelled skip in
 * their own `diskUsage.error` plus a summary note on the listing. Nothing is
 * silently truncated.
 */
export const DISK_USAGE_BUDGET_MS = 120000;

/**
 * How long a measurement is reused.
 *
 * The listings that show sizes are *polled* — the sidebar refreshes every
 * fifteen seconds while a session is live — and a directory's size does not
 * meaningfully change between two of those. Without this, turning sizes on
 * would run `du` over every listed worktree four times a minute forever.
 *
 * Five minutes is chosen to be obviously stale-tolerant: the number is an
 * order-of-magnitude prompt for "which of these is worth cleaning up", never an
 * input to a decision about whether to delete something.
 */
export const DISK_USAGE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  measuredAt: number;
  usage: WorktreeDiskUsage;
}

const cache = new Map<string, CacheEntry>();

/**
 * {@link directoryDiskUsage}, memoised per resolved directory for
 * {@link DISK_USAGE_TTL_MS}.
 *
 * Failures are cached too, and deliberately: a `du` that timed out will time
 * out again, and re-running it on every poll is precisely the cost this exists
 * to avoid. The error travels with the entry, so a caller still sees why there
 * is no number.
 */
export function directoryDiskUsageCached(directory: string, now: number = Date.now()): WorktreeDiskUsage {
  const key = resolve(directory);
  const hit = cache.get(key);
  if (hit && now - hit.measuredAt < DISK_USAGE_TTL_MS) return hit.usage;
  const usage = directoryDiskUsage(directory);
  cache.set(key, { measuredAt: now, usage });
  return usage;
}

/** Drop everything memoised. For tests, and for a caller that just moved a directory. */
export function clearDiskUsageCache(): void {
  cache.clear();
}

/**
 * One listing's share of `du`, with a spend limit.
 *
 * Every listing that measures more than one directory takes one of these and
 * measures through it. A skip is *reported*, never silent: the entry gets an
 * error string saying why it has no number, and {@link DiskUsageBudget.note}
 * gives the listing a sentence to surface.
 */
export interface DiskUsageBudget {
  /** Measure `directory`, or return a labelled skip once the budget is spent. */
  measure(directory: string): WorktreeDiskUsage;
  /** How many measurements were skipped for want of budget. */
  readonly skipped: number;
  /** A sentence for the listing to surface, or undefined when nothing was skipped. */
  note(measured?: number): string | undefined;
}

export function newDiskUsageBudget(opts?: {
  budgetMs?: number;
  /**
   * Whether to go through the five-minute memo. True for the polled listings
   * (sidebar, workspaces, trash); discovery measures uncached because a scan is
   * user-initiated and expected to be current.
   */
  cached?: boolean;
  now?: () => number;
}): DiskUsageBudget {
  const budgetMs = opts?.budgetMs ?? DISK_USAGE_BUDGET_MS;
  const now = opts?.now ?? Date.now;
  const startedAt = now();
  let skipped = 0;

  return {
    measure(directory: string): WorktreeDiskUsage {
      if (now() - startedAt >= budgetMs) {
        skipped++;
        return { error: `not measured — the ${budgetMs}ms disk-usage budget for this listing was exhausted` };
      }
      return opts?.cached === false ? directoryDiskUsage(directory) : directoryDiskUsageCached(directory);
    },
    get skipped() {
      return skipped;
    },
    note(measured?: number): string | undefined {
      if (skipped === 0) return undefined;
      const of = measured === undefined ? "" : ` of ${measured}`;
      return (
        `Disk usage was not measured for ${skipped}${of} entr${skipped === 1 ? "y" : "ies"}: the ${budgetMs}ms budget for this listing ran out. ` +
        `Re-run for the rest, or measure them with "du -sh".`
      );
    },
  };
}

/**
 * Size of `directory` in bytes, or an explanation of why there is no number.
 *
 * Never throws. `du` exits non-zero when it cannot read a subdirectory but
 * still prints a total for what it could read, so a partial answer is used and
 * labelled rather than discarded.
 */
export function directoryDiskUsage(directory: string, timeoutMs: number = DISK_USAGE_TIMEOUT_MS): WorktreeDiskUsage {
  if (!directory || !existsSync(directory)) {
    return { error: `Directory does not exist: ${directory}` };
  }
  const parse = (out: string): number | undefined => {
    const kb = Number.parseInt(String(out).trim().split(/\s+/)[0], 10);
    return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : undefined;
  };
  try {
    const bytes = parse(execFileSync("du", ["-sk", directory], { encoding: "utf8", stdio: "pipe", timeout: timeoutMs }));
    return bytes === undefined ? { error: "du produced no parseable total" } : { bytes };
  } catch (err: any) {
    const partial = typeof err?.stdout === "string" ? parse(err.stdout) : undefined;
    const message = (err?.killed ? `timed out after ${timeoutMs}ms` : err?.message) || String(err);
    return partial === undefined ? { error: `du failed: ${message}` } : { bytes: partial, error: `du reported errors (${message}); total is partial` };
  }
}
