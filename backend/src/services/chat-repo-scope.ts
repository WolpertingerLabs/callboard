/**
 * Repo scope and branch provenance for chat search.
 *
 * `search_chats({ repo })` answers "every chat that ran in this repository,
 * including its worktrees". The hard part is that **a worktree's directory is
 * routinely gone by the time anyone searches for it** — `git worktree remove`
 * leaves the transcripts, the chat records and the branch, and takes away the
 * only thing the old `find_chats` would accept as proof of membership: a live
 * `.git` that `resolveWorktreeToMainRepo` could follow back. On the corpus this
 * was measured against that gate hid 129 of 255 claude-code sessions (51%), in
 * 52 removed worktrees.
 *
 * So membership is derived from records first and the filesystem second, every
 * row says which rule admitted it, and — the part that took a review to get
 * right — a rule that can *admit* must also be able to *refuse*. The order is
 * strongest-evidence-first, not cheapest-first:
 *
 *  1. `exact`            — the folder *is* the repo.
 *  2. workspace records at this `cwd`. One naming this repo as its `repoPath`
 *     admits (`workspace-record`); one naming a **different** main checkout
 *     refuses. Records outlive the directories they describe, which is exactly
 *     the property the live-`.git` gate lacked — and it has to cut both ways or
 *     the strongest evidence anyone holds loses to the weakest inference below.
 *  3. the directory **exists**:
 *       - inside the repo → `descendant`. Callboard spawns worktrees inside
 *         checkouts, and a chat run in any subdirectory is a chat in this repo.
 *       - git says worktree-of-this-repo → `live-git`. What `find_chats` used.
 *       - otherwise → **refused**. It is there, git was asked, the answer is no.
 *  4. the directory is **gone**, so nothing can be asked and everything left is
 *     inference: inside the repo → `descendant`; `<repo-name><sep>…` beside the
 *     repo → `sibling-path`, the rule that closes the 51%. Otherwise no answer.
 *
 * Note what step 3 does *not* do: fall through. A neighbour that exists and
 * does not resolve back is a different repo sharing a path prefix —
 * `find_chats` rejected those and so does this — and it must not get a second
 * chance under the lexical rules of step 4. That is why `evaluate` returns
 * {@link RepoVerdict} rather than an optional `RepoSource`: see that type for
 * the concrete way conflating "refused" with "nothing to say" admitted a
 * neighbouring repo and stamped it `descendant`.
 *
 * Nothing here parses a `workspaceId`, and nothing keys on one: a repo is a
 * directory question, so it keys on `cwd` (see the `cwd` vs `workspaceId`
 * section of CLAUDE.md). Workspace records are read for the `cwd`/`repoPath`
 * pair they carry, not for identity.
 */
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Workspace } from "shared/types/workspace.js";
import { getGitInfo, resolveWorktreeToMainRepoCached } from "../utils/git.js";
import { listWorkspaces, samePath } from "./workspace-store.js";

/** Which rule admitted a folder to a repo. Reported on every row. */
export type RepoSource = "exact" | "descendant" | "workspace-record" | "live-git" | "sibling-path";

/**
 * The three answers, and why "refused" is not just `null`.
 *
 * A caller has more than one spelling of a chat's working directory — the
 * record's, which is real, and the browse projection, which for a removed
 * directory is a best-effort decode of a path that may never have existed. If
 * the only two answers were "member" and "not member", a *refusal* on the real
 * spelling would look identical to having nothing to say, and the caller would
 * hand the fabricated spelling a second chance at the same question. It gets
 * one: `callboard-contrast-shots` decodes to `callboard/contrast/shots`, which
 * is lexically inside `callboard`, so a neighbouring repo is admitted and
 * stamped `descendant` — as fact, by the lexical rule, with the evidence that
 * says otherwise already discarded.
 *
 * So: `refused` means something that can actually answer *did* — git was asked
 * about a directory that is there, or a workspace record names a different main
 * checkout. `null` means nothing could be asked. Only `null` earns a second
 * spelling.
 */
export type RepoVerdict = RepoSource | "refused" | null;

/** Where a row's branch came from. `unknown` means nothing recorded one. */
export type BranchSource = "record" | "live-git" | "unknown";

/** `<repo-name><sep>…` beside the repo — both Callboard worktree conventions. */
const SIBLING_SEPARATORS = new Set([".", "-", "_"]);

/** Is `target` lexically inside `repo`? Says nothing about either existing. */
function isInside(repo: string, target: string): boolean {
  const rel = relative(repo, target);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Classify folders against one repo root.
 *
 * Memoised per folder: a query over a few thousand rows sees a few hundred
 * distinct directories, and the workspace registry is read once rather than per
 * row. Archived workspace records count — a record is evidence about the past,
 * and a removed worktree is entirely in the past.
 *
 * `repoPath` is **normalised to the main checkout** before anything is compared
 * against it. Callboard's normal mode is an agent running inside a worktree, so
 * `repo: process.cwd()` is both the natural value to pass and, taken verbatim,
 * the wrong one: `live-git` compares candidates' `mainRepoPath` against it, so
 * sibling worktrees would not match, the main checkout would not match (it is
 * not a worktree of anything), and `sibling-path` could not fire. The result
 * would be one worktree's chats reported with a confident total. The
 * normalisation is reported back as `repoRoot` rather than applied silently.
 */
export function createRepoScope(repoPath: string, records?: Workspace[]) {
  const given = resolve(repoPath);

  const workspaces = records ?? listWorkspaces();
  const byCwd = new Map<string, Workspace[]>();
  for (const workspace of workspaces) {
    const key = resolve(workspace.cwd);
    const bucket = byCwd.get(key);
    if (bucket) bucket.push(workspace);
    else byCwd.set(key, [workspace]);
  }

  // Live git first; a workspace record covers the case where the directory the
  // caller named has itself been removed, which `resolveWorktreeToMainRepo`
  // cannot answer.
  const live = resolveWorktreeToMainRepoCached(given);
  const recorded = (byCwd.get(given) ?? []).find((w) => w.repoPath && !samePath(w.repoPath, given));
  const repo = live.isWorktree ? resolve(live.mainRepoPath) : recorded?.repoPath ? resolve(recorded.repoPath) : given;

  const repoParent = dirname(repo);
  const repoName = basename(repo);
  const cache = new Map<string, RepoVerdict>();

  function evaluate(folder: string): RepoVerdict {
    const target = resolve(folder);
    if (samePath(target, repo)) return "exact";

    // Records outlive the directories they describe — and that has to run in
    // both directions or the premise is decorative. A record naming a
    // *different* main checkout is the strongest thing anyone holds about this
    // directory, and it must not lose to the path inference below.
    for (const workspace of byCwd.get(target) ?? []) {
      if (!workspace.repoPath) continue;
      if (samePath(workspace.repoPath, repo)) return "workspace-record";
      if (!samePath(workspace.repoPath, target)) return "refused";
    }

    if (existsSync(target)) {
      // It is on disk, so the lexical relation is a fact about a real tree
      // rather than a guess about a decoded name. Callboard spawns worktrees
      // inside checkouts, and a chat run in any subdirectory is a chat in this
      // repo.
      if (isInside(repo, target)) return "descendant";
      const { isWorktree, mainRepoPath } = resolveWorktreeToMainRepoCached(target);
      if (isWorktree && samePath(mainRepoPath, repo)) return "live-git";
      // Asked and answered: a neighbour that shares the prefix is its own repo.
      return "refused";
    }

    // Gone. Nothing can be asked, so what is left is inference, and every
    // branch from here is reported as such rather than presented as fact.
    if (isInside(repo, target)) return "descendant";
    const name = basename(target);
    if (dirname(target) === repoParent && name.length > repoName.length && name.startsWith(repoName) && SIBLING_SEPARATORS.has(name[repoName.length])) {
      return "sibling-path";
    }
    return null;
  }

  return {
    /** The main checkout every classification is made against. */
    repoRoot: repo,
    /** Set when the caller named a worktree and this scope widened to its repo. */
    normalisedFrom: samePath(given, repo) ? null : given,
    /** How `folder` relates to this repo: admitted, refused, or unanswerable. */
    classify(folder: string): RepoVerdict {
      if (!folder) return null;
      if (!cache.has(folder)) cache.set(folder, evaluate(folder));
      return cache.get(folder)!;
    },
  };
}

/** Deep enough for a monorepo package path; short enough to stay a bounded walk. */
const GIT_DIR_SEARCH_DEPTH = 40;

/**
 * The nearest ancestor of `folder` (itself included) holding a `.git`, or null.
 *
 * Pure `existsSync`, deliberately. `getGitInfo` answers "am I in a repository?"
 * for a directory without its own `.git` by spawning `git rev-parse --git-dir`
 * with a five-second timeout — measured at **2.73 ms** per call against 0.03 ms
 * for a directory that has one. That is the shape a monorepo-style install is
 * made of (chats started in subdirectories), and at a few hundred distinct
 * folders per `branch=` query it is ~550 ms of blocked event loop, with a
 * worst case of one 5 s timeout per folder if git stalls on an index lock.
 * Unlike `grep` and `matchAdvanced` this path has no worker, no deadline and no
 * cap, so the fix is to not spawn: walking up for a `.git` answers the same
 * question with stat calls, and hands `getGitInfo` a directory it can serve
 * from its fast path.
 *
 * A worktree's `.git` is a file rather than a directory, which `existsSync`
 * covers either way.
 */
function nearestGitDir(folder: string): string | null {
  let current = resolve(folder);
  for (let depth = 0; depth < GIT_DIR_SEARCH_DEPTH; depth++) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * Read the branch a directory currently has checked out, once per directory.
 *
 * Only consulted when the record has no branch or records a different one, so
 * the common case costs nothing.
 */
export function createLiveBranchResolver() {
  const cache = new Map<string, string | null>();
  return (folder: string): string | null => {
    if (!folder) return null;
    if (!cache.has(folder)) {
      let branch: string | null = null;
      try {
        const root = nearestGitDir(folder);
        // No `.git` anywhere above it: there is no branch to read, and asking
        // git would only spend a subprocess arriving at the same answer.
        if (root) {
          const info = getGitInfo(root);
          if (info.isGitRepo) branch = info.branch ?? null;
        }
      } catch {
        branch = null;
      }
      cache.set(folder, branch);
    }
    return cache.get(folder)!;
  };
}
