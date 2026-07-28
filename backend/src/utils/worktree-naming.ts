/**
 * Does this path *look* like a worktree Callboard made?
 *
 * ────────────────────────────────────────────────────────────────────────
 *  THIS MODULE MAY ONLY EVER BE USED TO **OFFER**. IT MUST NEVER **ACT**.
 * ────────────────────────────────────────────────────────────────────────
 *
 * It is imported by exactly one place — services/workspace-discovery.ts, which
 * writes nothing — and by the tests that pin that. services/workspace-adoption.ts,
 * the module that writes `owned: true`, does not import it and must not: a path
 * pattern is a claim about the past, and the past has more than one convention
 * in it.
 *
 * Two are known:
 *
 *  - **current** — `<repo-parent>/<repo-name>.<branch, slashes hyphenated>`,
 *    what `ensureWorktreeDetailed` produces today (utils/git.ts).
 *  - **legacy** — `<repo-parent>/<repo-name>-wt-<suffix>`, an older layout still
 *    present on machines that have been running Callboard for a while
 *    (e.g. `callboard-wt-chatcards` beside `callboard`).
 *
 * Neither is evidence. A user can create either by hand in one command; and
 * Callboard's own current convention derives the directory from the branch
 * name, so a branch renamed after the worktree was made no longer matches the
 * worktree Callboard itself created. Both directions of error are live, which
 * is the whole reason ownership is something a human asserts rather than
 * something a regex concludes.
 */
import { basename, dirname, resolve } from "path";
import type { WorktreeNamingGuess } from "shared/types/index.js";

/**
 * The directory `ensureWorktreeDetailed` would create for `branch` in `repoDir`.
 *
 * Kept in step with utils/git.ts by construction: same `basename`/`dirname`
 * split, same slash-to-hyphen substitution. If that function's layout changes,
 * this becomes a guess about an older convention — which is precisely what this
 * module is for, and precisely why nothing may decide on it.
 */
function conventionalWorktreePath(repoDir: string, branch: string): string {
  return `${resolve(dirname(repoDir), basename(repoDir))}.${branch.replace(/\//g, "-")}`;
}

const LEGACY_SUFFIX_RE = /^-wt-.+$/;

/**
 * Compare a worktree path against the known conventions.
 *
 * @param worktreePath absolute path of the worktree
 * @param repoPath     the main checkout it is registered against
 * @param branch       the branch git reports for it, or null when detached
 */
export function guessWorktreeNaming(worktreePath: string, repoPath: string, branch: string | null): WorktreeNamingGuess {
  const path = resolve(worktreePath);
  const repo = resolve(repoPath);
  const repoName = basename(repo);

  if (branch && path === conventionalWorktreePath(repo, branch)) {
    return {
      convention: "current",
      matches: true,
      detail:
        `The path is where Callboard's current worktree layout would put branch "${branch}" of ${repoName} ` +
        `(<repo>.<branch>). A guess about how this directory came to exist, not proof Callboard created it — ` +
        `the same path is one "git worktree add" away by hand.`,
    };
  }

  const name = basename(path);
  if (dirname(path) === dirname(repo) && name.startsWith(repoName) && LEGACY_SUFFIX_RE.test(name.slice(repoName.length))) {
    return {
      convention: "legacy",
      matches: true,
      detail:
        `The path matches Callboard's older "<repo>-wt-<name>" worktree layout beside ${repoName}. A guess, and a ` +
        `weaker one than the current convention: nothing about that name is exclusive to Callboard.`,
    };
  }

  return {
    convention: "unrecognized",
    matches: false,
    detail:
      `The path matches neither Callboard naming convention. That is not evidence either way — Callboard's layout is ` +
      `derived from the branch name, so renaming a branch leaves a worktree Callboard did make looking unfamiliar.`,
  };
}
