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
 * So membership is derived from records first and the filesystem second, and
 * every row says which rule admitted it. The rules, in the order they are
 * tried — the order is strongest-evidence-first, not cheapest-first:
 *
 *  - `exact`            — the folder *is* the repo.
 *  - `descendant`       — the folder is inside the repo (nested worktrees are a
 *                         real Callboard layout, and a chat run in a
 *                         subdirectory is still a chat in this repo).
 *  - `workspace-record` — a workspace record names this folder as its `cwd` and
 *                         this repo as its `repoPath`. Records outlive the
 *                         directories they describe, which is exactly the
 *                         property the live-`.git` gate lacked.
 *  - `live-git`         — the directory is still there and git says it is a
 *                         worktree of this repo. What `find_chats` used, kept.
 *  - `sibling-path`     — the directory is **gone**, and its name is the repo's
 *                         name plus a separator, beside the repo. This is the
 *                         one inferred rule and the one that closes the 51%.
 *
 * `sibling-path` deliberately does NOT apply to a directory that still exists:
 * if it is there, `live-git` already had its chance, and a sibling that exists
 * but does not resolve back to this repo is a *different repo sharing a path
 * prefix* — which `find_chats` rejected and so does this. The inference is only
 * ever used where there is nothing left to check, and it is reported as
 * `repoSource: "sibling-path"` rather than presented as fact.
 *
 * Nothing here parses a `workspaceId`, and nothing keys on one: a repo is a
 * directory question, so it keys on `cwd` (see the `cwd` vs `workspaceId`
 * section of CLAUDE.md). Workspace records are read for the `cwd`/`repoPath`
 * pair they carry, not for identity.
 */
import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Workspace } from "shared/types/workspace.js";
import { getGitInfo, resolveWorktreeToMainRepoCached } from "../utils/git.js";
import { listWorkspaces, samePath } from "./workspace-store.js";

/** Which rule admitted a folder to a repo. Reported on every row. */
export type RepoSource = "exact" | "descendant" | "workspace-record" | "live-git" | "sibling-path";

/** Where a row's branch came from. `unknown` means nothing recorded one. */
export type BranchSource = "record" | "live-git" | "unknown";

/** `<repo-name><sep>…` beside the repo — both Callboard worktree conventions. */
const SIBLING_SEPARATORS = new Set([".", "-", "_"]);

/**
 * Classify folders against one repo root.
 *
 * Memoised per folder: a query over a few thousand rows sees a few hundred
 * distinct directories, and the workspace registry is read once rather than per
 * row. Archived workspace records count — a record is evidence about the past,
 * and a removed worktree is entirely in the past.
 */
export function createRepoScope(repoPath: string, records?: Workspace[]) {
  const repo = resolve(repoPath);
  const repoParent = dirname(repo);
  const repoName = basename(repo);

  const byCwd = new Map<string, Workspace[]>();
  for (const workspace of records ?? listWorkspaces()) {
    const key = resolve(workspace.cwd);
    const bucket = byCwd.get(key);
    if (bucket) bucket.push(workspace);
    else byCwd.set(key, [workspace]);
  }

  const cache = new Map<string, RepoSource | null>();

  function evaluate(folder: string): RepoSource | null {
    const target = resolve(folder);
    if (samePath(target, repo)) return "exact";

    const rel = relative(repo, target);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return "descendant";

    for (const workspace of byCwd.get(target) ?? []) {
      if (workspace.repoPath && samePath(workspace.repoPath, repo)) return "workspace-record";
    }

    const onDisk = existsSync(target);
    if (onDisk) {
      const { isWorktree, mainRepoPath } = resolveWorktreeToMainRepoCached(target);
      if (isWorktree && samePath(mainRepoPath, repo)) return "live-git";
      // It is there and it is not a worktree of this repo. That is an answer,
      // not a gap — do not fall through to the path inference and re-admit a
      // neighbouring repo that merely shares the prefix.
      return null;
    }

    const name = basename(target);
    if (dirname(target) === repoParent && name.length > repoName.length && name.startsWith(repoName) && SIBLING_SEPARATORS.has(name[repoName.length])) {
      return "sibling-path";
    }
    return null;
  }

  return {
    /** The rule that admits `folder` to this repo, or null when none does. */
    classify(folder: string): RepoSource | null {
      if (!folder) return null;
      if (!cache.has(folder)) cache.set(folder, evaluate(folder));
      return cache.get(folder)!;
    },
  };
}

/**
 * Read the branch a directory currently has checked out, once per directory.
 *
 * Only consulted when the record has no branch or records a different one, so
 * the common case costs nothing. `getGitInfo` returns early for a path that is
 * not there, which is the shape most of these calls have.
 */
export function createLiveBranchResolver() {
  const cache = new Map<string, string | null>();
  return (folder: string): string | null => {
    if (!folder) return null;
    if (!cache.has(folder)) {
      let branch: string | null = null;
      try {
        const info = getGitInfo(folder);
        if (info.isGitRepo) branch = info.branch ?? null;
      } catch {
        branch = null;
      }
      cache.set(folder, branch);
    }
    return cache.get(folder)!;
  };
}
