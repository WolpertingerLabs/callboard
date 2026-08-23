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
 *
 * There are two ways to spend it, and the difference is which thread waits:
 *
 * - {@link newAsyncDiskUsageBudget} — what the polled listings use. `du` runs in
 *   the background, {@link DISK_USAGE_CONCURRENCY} at a time, and the daemon goes
 *   on serving HTTP while it does. Costs the caller one `await settle()`.
 * - {@link newDiskUsageBudget} — the synchronous original, kept for the callers
 *   that measure a single directory, and for synchronous call sites that cannot
 *   await. It blocks the event loop for as long as `du` runs.
 *
 * The distinction is not stylistic. Measured against 34 worktrees, the
 * synchronous budget held the event loop for 2.1s — every request, every SSE
 * flush and every timer in the process waited behind it. Prefer the async one
 * anywhere more than one directory is measured.
 */
import { execFile, execFileSync } from "child_process";
import { existsSync } from "fs";
import { availableParallelism } from "os";
import { resolve } from "path";
import type { WorktreeDiskUsage } from "shared/types/index.js";

/** Per-directory ceiling. A cold `node_modules` on a slow disk is seconds. */
export const DISK_USAGE_TIMEOUT_MS = 15000;

/**
 * How many `du` processes this daemon runs at once, across every listing.
 *
 * Measured on the machine this was written for — 34 worktrees, ~1.5 GB each,
 * eight cores — sweeping the concurrency of the async path:
 *
 * | cap | listing wall | worst event-loop stall |
 * |-----|--------------|------------------------|
 * |   1 |      2142 ms |                 0.9 ms |
 * |   4 |       704 ms |                 1.1 ms |
 * |   8 |       493 ms |                 2.1 ms |
 * |  12 |       489 ms |                  11 ms |
 * |  16 |       465 ms |                  31 ms |
 * |  34 |       458 ms |                  100 ms |
 *
 * Two things fall out of that. The knee is at the core count, because `du` on a
 * warm page cache is not I/O-wait — it is ~100% CPU, nearly all of it kernel
 * time in `getdents`/`statx` — so past one process per core there is no wall
 * clock left to win: 8 → 34 buys 7%. And past the knee the cost is paid by the
 * event loop, which is the thing this whole change exists to protect: saturating
 * every core with `du` starves the Node process itself of CPU, and the stall it
 * reintroduces grows 15× between cap 8 and cap 34.
 *
 * So: one process per core, never more than eight. The upper clamp is not about
 * this laptop — it is that the marginal wall clock past eight is already inside
 * the noise, so a 64-core machine would be spawning 64 subprocesses to win
 * nothing. Floor of two so a single-core container still overlaps.
 *
 * This is a **daemon-wide** budget, not a per-listing one. Bounding each listing
 * separately does not bound the machine: two tabs opening the Manage modal at
 * once would be 2 × cap. Every listing draws from this one pool.
 */
export const DISK_USAGE_CONCURRENCY = Math.max(2, Math.min(8, availableParallelism()));

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
  const hit = memoPeek(key, now);
  if (hit) return hit;
  const usage = directoryDiskUsage(directory);
  cache.set(key, { measuredAt: now, usage });
  return usage;
}

/** The live memo entry for an already-resolved key, or undefined when there is none. */
function memoPeek(key: string, now: number): WorktreeDiskUsage | undefined {
  const hit = cache.get(key);
  return hit && now - hit.measuredAt < DISK_USAGE_TTL_MS ? hit.usage : undefined;
}

/** Drop everything memoised. For tests, and for a caller that just moved a directory. */
export function clearDiskUsageCache(): void {
  cache.clear();
}

// ── The daemon-wide `du` pool ────────────────────────────────────────
//
// A counting semaphore, shared by every async budget in the process. See
// {@link DISK_USAGE_CONCURRENCY} for why the cap is what it is, and why it is
// daemon-wide rather than per-listing.

let running = 0;
const waiting: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (running < DISK_USAGE_CONCURRENCY) {
    running++;
    return;
  }
  await new Promise<void>((release) => waiting.push(release));
  // Whoever woke us handed their slot over without decrementing, so `running`
  // is already accounted for. Incrementing here would double-count it.
}

function releaseSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

/**
 * {@link directoryDiskUsage}, off the event loop.
 *
 * Identical contract — never throws, partial totals are used and labelled — but
 * the wait happens in the background rather than inside a blocking syscall, so
 * the daemon keeps serving HTTP and flushing SSE while `du` walks the tree.
 */
export function directoryDiskUsageAsync(directory: string, timeoutMs: number = DISK_USAGE_TIMEOUT_MS): Promise<WorktreeDiskUsage> {
  if (!directory || !existsSync(directory)) {
    return Promise.resolve({ error: `Directory does not exist: ${directory}` });
  }
  return new Promise((resolvePromise) => {
    execFile("du", ["-sk", directory], { encoding: "utf8", timeout: timeoutMs }, (err: any, stdout) => {
      if (!err) {
        const bytes = parseDuTotal(stdout);
        return resolvePromise(bytes === undefined ? { error: "du produced no parseable total" } : { bytes });
      }
      const partial = typeof stdout === "string" ? parseDuTotal(stdout) : undefined;
      const message = (err?.killed ? `timed out after ${timeoutMs}ms` : err?.message) || String(err);
      resolvePromise(partial === undefined ? { error: `du failed: ${message}` } : { bytes: partial, error: `du reported errors (${message}); total is partial` });
    });
  });
}

/** `du -sk` prints kibibytes then the path. Bytes, or undefined when that is not what arrived. */
function parseDuTotal(out: string): number | undefined {
  const kb = Number.parseInt(String(out).trim().split(/\s+/)[0], 10);
  return Number.isFinite(kb) && kb >= 0 ? kb * 1024 : undefined;
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
      return noteFor(skipped, budgetMs, measured);
    },
  };
}

/** The one sentence both budgets surface, so the two cannot drift apart. */
function noteFor(skipped: number, budgetMs: number, measured?: number): string | undefined {
  if (skipped === 0) return undefined;
  const of = measured === undefined ? "" : ` of ${measured}`;
  return (
    `Disk usage was not measured for ${skipped}${of} entr${skipped === 1 ? "y" : "ies"}: the ${budgetMs}ms budget for this listing ran out. ` +
    `Re-run for the rest, or measure them with "du -sh".`
  );
}

/**
 * A budget whose measurements happen *after* the rows are built.
 *
 * The problem this solves is that the row builders are synchronous and want to
 * stay that way — `buildFolderSummaries` and `toEntry` are pure shaping code,
 * and threading a promise through them to reach one optional field would be a
 * far larger change than the freeze warrants. So {@link DiskUsageBudget.measure}
 * keeps its synchronous signature and keeps returning a `WorktreeDiskUsage`; it
 * just returns an **empty one it has not filled in yet**, and remembers it.
 * {@link settle} then measures every remembered directory in parallel and writes
 * the answers back into the objects the rows are already holding.
 *
 * The caller's obligation is one line: `await budget.settle()` before reading
 * {@link DiskUsageBudget.note} or serialising the rows. Forgetting it does not
 * produce a silently empty measurement — the placeholder ships carrying an error
 * that says it was never settled, which is loud in exactly the way a `{}` would
 * not be.
 */
export interface AsyncDiskUsageBudget extends DiskUsageBudget {
  /**
   * Run every registered measurement, bounded by {@link DISK_USAGE_CONCURRENCY},
   * and fill in the objects `measure` handed out.
   *
   * Idempotent *and* safe to call concurrently: the second call returns the
   * first call's promise rather than a fresh resolved one, so awaiting it always
   * means the placeholders are filled. Returning early on a boolean would hand
   * the second caller a promise that resolves immediately with every row still
   * reading "did not settle" — the exact silent failure the placeholder error
   * exists to make loud.
   */
  settle(): Promise<void>;
}

/** What `measure` returns before `settle` has filled it in. */
const UNSETTLED = "not measured — the listing did not settle its disk-usage budget (this is a bug)";

/** Overwrite `target` in place, so a stale placeholder error cannot survive alongside a real total. */
function replaceUsage(target: WorktreeDiskUsage, usage: WorktreeDiskUsage): void {
  for (const key of Object.keys(target)) delete (target as Record<string, unknown>)[key];
  Object.assign(target, usage);
}

/**
 * A listing's share of `du`, spent off the event loop.
 *
 * Same contract as {@link newDiskUsageBudget} — one shared wall-clock budget,
 * skips reported per entry and summarised by {@link DiskUsageBudget.note} — with
 * two deliberate redefinitions that concurrency forces:
 *
 * **The budget bounds when a measurement may *start*, not when it must finish.**
 * A directory is not handed a `du` once the deadline has passed; up to
 * {@link DISK_USAGE_CONCURRENCY} already-running ones are allowed to finish, each
 * still capped by {@link DISK_USAGE_TIMEOUT_MS}. So the worst-case overrun is one
 * per-directory timeout, which is exactly what the synchronous budget's overrun
 * already was — a measurement starting one millisecond inside the deadline could
 * always run 15s past it. Concurrency does not widen that, because the stragglers
 * overlap rather than queue.
 *
 * **The deadline is checked after a slot comes free, not on registration.** Every
 * measurement is registered at time zero, so checking then would never skip
 * anything. Checking at dispatch also means time spent queued behind another
 * listing counts against this one, which is the honest accounting: a listing that
 * waited 120s for the pool really has spent its budget.
 *
 * A memo hit costs no slot and is served regardless of the deadline — it is not
 * work, and refusing to hand back a number already in memory would be a skip
 * reported for nothing.
 */
export function newAsyncDiskUsageBudget(opts?: { budgetMs?: number; concurrency?: number; now?: () => number }): AsyncDiskUsageBudget {
  const budgetMs = opts?.budgetMs ?? DISK_USAGE_BUDGET_MS;
  const now = opts?.now ?? Date.now;
  const startedAt = now();
  let skipped = 0;
  /**
   * The single run, memoised. Not a `settled` boolean: a second `settle()` that
   * arrives while the first is still in flight must wait for it, not resolve
   * immediately on placeholders that are not filled in yet.
   */
  let run: Promise<void> | undefined;

  /** Registrations in listing order, so a skip lands on the tail rather than at random. */
  const pending: Array<{ key: string; directory: string; target: WorktreeDiskUsage }> = [];

  const budget: AsyncDiskUsageBudget = {
    measure(directory: string): WorktreeDiskUsage {
      // A stray call after settle() still has to be correct, so it falls back to
      // the synchronous path. Nothing in the codebase does this; the fallback is
      // here so that if something ever does, it gets a number rather than a
      // placeholder that will never be filled in.
      if (run) return directoryDiskUsageCached(directory, now());
      const target: WorktreeDiskUsage = { error: UNSETTLED };
      pending.push({ key: resolve(directory), directory, target });
      return target;
    },

    settle(): Promise<void> {
      return (run ??= drain());
    },

    get skipped() {
      return skipped;
    },

    note(measured?: number): string | undefined {
      return noteFor(skipped, budgetMs, measured);
    },
  };

  async function drain(): Promise<void> {
    // One dispatch per directory, however many rows asked for it: two
    // workspaces sharing a cwd is a supported state, and it must not be two
    // `du` processes. Insertion order is preserved, so the tail is still the
    // tail.
    const byDirectory = new Map<string, { directory: string; targets: WorktreeDiskUsage[] }>();
    for (const item of pending) {
      const group = byDirectory.get(item.key);
      if (group) group.targets.push(item.target);
      else byDirectory.set(item.key, { directory: item.directory, targets: [item.target] });
    }

    const queue = [...byDirectory.entries()];
    let next = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= queue.length) return;
        const [key, { directory, targets }] = queue[index];

        // Free: already in memory, so neither a slot nor the deadline applies.
        const memo = memoPeek(key, now());
        if (memo) {
          for (const target of targets) replaceUsage(target, memo);
          continue;
        }

        await acquireSlot();
        try {
          if (now() - startedAt >= budgetMs) {
            skipped += targets.length;
            const error = `not measured — the ${budgetMs}ms disk-usage budget for this listing was exhausted`;
            for (const target of targets) replaceUsage(target, { error });
            continue;
          }
          // Re-check the memo now that we actually hold a slot. This catches a
          // concurrent listing that *finished* this directory while we queued —
          // the tail of an overlapping sweep, not its head: the memo is only
          // written on completion, so two listings that acquire slots for the
          // same directory inside the same window both spawn `du`. Best-effort
          // by design; the cap still bounds the machine either way.
          const warmed = memoPeek(key, now());
          const usage = warmed ?? (await directoryDiskUsageAsync(directory));
          if (!warmed) cache.set(key, { measuredAt: now(), usage });
          for (const target of targets) replaceUsage(target, usage);
        } finally {
          releaseSlot();
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(opts?.concurrency ?? DISK_USAGE_CONCURRENCY, queue.length) }, worker));
    pending.length = 0;
  }

  return budget;
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
  try {
    const bytes = parseDuTotal(execFileSync("du", ["-sk", directory], { encoding: "utf8", stdio: "pipe", timeout: timeoutMs }));
    return bytes === undefined ? { error: "du produced no parseable total" } : { bytes };
  } catch (err: any) {
    const partial = typeof err?.stdout === "string" ? parseDuTotal(err.stdout) : undefined;
    const message = (err?.killed ? `timed out after ${timeoutMs}ms` : err?.message) || String(err);
    return partial === undefined ? { error: `du failed: ${message}` } : { bytes: partial, error: `du reported errors (${message}); total is partial` };
  }
}
