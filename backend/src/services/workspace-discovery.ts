/**
 * Discovery — which worktrees of a repository Callboard is not managing.
 *
 * **Read-only, absolutely.** This module creates no workspace record, writes no
 * identity token and modifies nothing on disk. It runs `git worktree list`,
 * `git status` and `du`, reads the registry, and returns what it saw. If a
 * change ever appears in here, adoption has stopped being user-initiated.
 *
 * For each candidate it reports the four things a human needs to decide:
 *
 *  - **what it is** — path, branch, the repository it belongs to;
 *  - **what it would cost to keep** — disk usage, the number that motivates all
 *    of this (43 worktrees, ~40 GB on the author's machine);
 *  - **what state the work is in** — the same `checkWorktreeClean` that gates
 *    removal in Phase 2, so the answer here and the answer there cannot
 *    disagree, plus the ignored entries that would travel into the trash if it
 *    were ever archived (`listIgnoredEntries`, also Phase 2's);
 *  - **whether adoption would even work** — the Phase 2b refusal codes,
 *    evaluated up front so a caller sees "main checkout" or "detached HEAD"
 *    before trying.
 *
 * And one thing that is *not* in that list, which is why the labelling matters:
 *
 * > **`naming` is a guess.** Callboard has used at least two worktree naming
 * > conventions, so a path pattern is a heuristic about the past, not a fact
 * > about who created a directory. It is here to help a person choose. It is
 * > not passed to adoption, adoption does not read it, and
 * > services/workspace-adoption.ts does not import utils/worktree-naming.ts at
 * > all. Pattern-matching offers; it never acts.
 *
 * @see plans/workspace-object.md — Phase 2b
 */
import { resolve } from "path";
import type { UnmanagedWorktree, UnmanagedWorktreeListing, WorktreeDiskUsage } from "shared/types/index.js";
import { checkWorktreeClean, listIgnoredEntries, resolveWorktreeToMainRepo } from "../utils/git.js";
import { DISK_USAGE_BUDGET_MS, newAsyncDiskUsageBudget } from "../utils/disk-usage.js";
import { guessWorktreeNaming } from "../utils/worktree-naming.js";
import { evaluateAdoption, newAdoptionContext } from "./workspace-adoption.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-discovery");

/**
 * Total wall-clock budget for measuring disk usage across one listing.
 *
 * Defined once in utils/disk-usage.ts and re-exported here: this listing is
 * where the budget was first needed, and every other listing that measures more
 * than one directory now shares the same primitive rather than a copy of it.
 */
export { DISK_USAGE_BUDGET_MS };

export interface DiscoveryOptions {
  /**
   * Default true, and the one listing in the codebase for which that is right.
   * @see listUnmanagedWorktrees
   */
  includeDiskUsage?: boolean;
  /** Total budget for disk measurement. @see DISK_USAGE_BUDGET_MS */
  diskUsageBudgetMs?: number;
}

/**
 * Every registered worktree of `repoPathOrWorktree`'s repository that has no
 * active workspace record.
 *
 * The argument may be the main checkout *or* any worktree of it — a caller
 * holding a worktree path should not have to work out the repository first.
 * The main checkout is never a candidate (Callboard does not manage its
 * removal) but is counted in `totalWorktrees`.
 *
 * **Disk usage is on by default here and opt-in everywhere else, on purpose.**
 * That asymmetry has been mistaken for a typo, so: the other listings that carry
 * sizes are *polled* — the sidebar refreshes every fifteen seconds from every
 * open tab — and a size nobody asked for, measured four times a minute forever,
 * is pure cost. This one is a button. A human pressed Scan on a modal whose
 * entire job is to answer "which of these 43 worktrees is worth reclaiming", and
 * the answer to that question is a number of gigabytes: the size column and the
 * headline total are what the screen is *for*. Defaulting it off would ship that
 * modal with its main column empty. So `GET /unmanaged` reads the parameter as
 * opt-*out* (`!== "false"`), which is how it has read it since #287 introduced
 * it — four PRs before #291 established the opt-in convention for the polled
 * listings. It did not diverge from that convention; it predates it.
 *
 * The cost that made this look like a bug was real, and is what changed: the
 * measurement now runs on {@link newAsyncDiskUsageBudget}'s bounded pool instead
 * of freezing the daemon for ~72ms per candidate.
 */
export async function listUnmanagedWorktrees(repoPathOrWorktree: string, opts?: DiscoveryOptions): Promise<UnmanagedWorktreeListing> {
  const given = resolve(repoPathOrWorktree);
  const resolution = resolveWorktreeToMainRepo(given);
  const repoPath = resolution.isWorktree ? resolution.mainRepoPath : given;

  const ctx = newAdoptionContext(repoPath);
  const includeDiskUsage = opts?.includeDiskUsage !== false;
  // Uncached, and still uncached after the move to the pool: a scan is a human
  // asking what is on disk *now*, and the memo would answer with a number from
  // up to five minutes before they emptied the `node_modules` they are looking
  // at, with nothing on screen admitting its age. Speed is not the thing to buy
  // here — the pool already bought it, without costing the freshness.
  //
  // The measurement is still *published* to the memo, so the polled listings
  // that follow a scan get it free. @see newAsyncDiskUsageBudget
  //
  // This function is async solely because of this budget: the rows below are
  // built synchronously, holding placeholders that `settle()` fills in.
  const budget = newAsyncDiskUsageBudget({ budgetMs: opts?.diskUsageBudgetMs, cached: false });

  const worktrees: UnmanagedWorktree[] = [];
  let managedWorktrees = 0;

  for (const entry of ctx.worktrees) {
    if (entry.isMainWorktree || entry.isBare) continue;
    const path = resolve(entry.path);
    const evaluation = evaluateAdoption(path, ctx);

    // "Unmanaged" is defined by the registry, never by the filesystem — and it
    // is read off adoption's own verdict rather than re-derived here, so the
    // set this lists and the set adoption would accept cannot drift.
    if (evaluation.blockers.some((b) => b.code === "already-managed")) {
      managedWorktrees++;
      continue;
    }

    const diskUsage: WorktreeDiskUsage = includeDiskUsage ? budget.measure(path) : { error: "not measured (disk usage was not requested)" };

    worktrees.push({
      path,
      branch: entry.branch,
      repoPath,
      // A GUESS, for display. Computed here and nowhere else; never handed to
      // adoption, which does not accept it and does not import the module that
      // produces it.
      naming: guessWorktreeNaming(path, repoPath, entry.branch),
      cleanliness: checkWorktreeClean(path),
      ignored: listIgnoredEntries(path),
      diskUsage,
      adoptable: evaluation.blockers.length === 0,
      adoptionBlockers: evaluation.blockers,
    });
  }

  // The rows above are holding unfilled measurements; this is what fills them.
  // It has to happen before `note()` is read or the listing is serialised.
  await budget.settle();

  const diskUsageNote = budget.note(worktrees.length);
  if (diskUsageNote) {
    log.warn(`Disk usage not measured for ${budget.skipped} worktree(s) of ${repoPath} — budget exhausted`);
  }

  return {
    repoPath,
    totalWorktrees: ctx.worktrees.length,
    managedWorktrees,
    worktrees,
    ...(diskUsageNote && { diskUsageNote }),
  };
}
