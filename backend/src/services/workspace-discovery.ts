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
import { directoryDiskUsage } from "../utils/disk-usage.js";
import { guessWorktreeNaming } from "../utils/worktree-naming.js";
import { evaluateAdoption, newAdoptionContext } from "./workspace-adoption.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-discovery");

/**
 * Total wall-clock budget for measuring disk usage across one listing.
 *
 * `du -sk` over a worktree with a cold `node_modules` is seconds, and there can
 * be dozens of worktrees. Rather than make an interactive listing take minutes,
 * measurement stops when the budget is spent and the remaining entries say so
 * in their own `diskUsage.error` — a skipped measurement is visible per entry
 * and summarised in `diskUsageNote`. Nothing is silently truncated.
 */
export const DISK_USAGE_BUDGET_MS = 120000;

export interface DiscoveryOptions {
  /** Default true. The motivating number, but the slow part — skippable. */
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
 */
export function listUnmanagedWorktrees(repoPathOrWorktree: string, opts?: DiscoveryOptions): UnmanagedWorktreeListing {
  const given = resolve(repoPathOrWorktree);
  const resolution = resolveWorktreeToMainRepo(given);
  const repoPath = resolution.isWorktree ? resolution.mainRepoPath : given;

  const ctx = newAdoptionContext(repoPath);
  const includeDiskUsage = opts?.includeDiskUsage !== false;
  const budgetMs = opts?.diskUsageBudgetMs ?? DISK_USAGE_BUDGET_MS;
  const startedAt = Date.now();

  const worktrees: UnmanagedWorktree[] = [];
  let managedWorktrees = 0;
  let skippedForBudget = 0;

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

    let diskUsage: WorktreeDiskUsage;
    if (!includeDiskUsage) {
      diskUsage = { error: "not measured (disk usage was not requested)" };
    } else if (Date.now() - startedAt >= budgetMs) {
      skippedForBudget++;
      diskUsage = { error: `not measured — the ${budgetMs}ms disk-usage budget for this listing was exhausted` };
    } else {
      diskUsage = directoryDiskUsage(path);
    }

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

  if (skippedForBudget > 0) {
    log.warn(`Disk usage not measured for ${skippedForBudget} worktree(s) of ${repoPath} — budget exhausted`);
  }

  return {
    repoPath,
    totalWorktrees: ctx.worktrees.length,
    managedWorktrees,
    worktrees,
    ...(skippedForBudget > 0 && {
      diskUsageNote: `Disk usage was not measured for ${skippedForBudget} of ${worktrees.length} worktree(s): the ${budgetMs}ms budget for this listing ran out. Re-run for the rest, or measure them with "du -sh".`,
    }),
  };
}
