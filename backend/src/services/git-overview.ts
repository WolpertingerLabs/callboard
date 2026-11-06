/**
 * The Board's Branches view: every worktree of every repository an unarchived
 * card is working in, with the cards attached to the directory they work in
 * and, where GitHub knows of one, the branch's pull request.
 *
 * Rows key on the directory (`cwd`), never on a workspace id — this is a
 * listing of directories, and two workspaces on one checkout are one row (see
 * "Workspace keying" in .claude/CLAUDE.md).
 *
 * Cost: card membership comes from the stat-gated card rollup, never from a
 * full chat scan; each repository costs one async `git worktree list` per
 * request, plus one cached `gh api` call per {@link PR_CACHE_TTL_MS}.
 */
import { existsSync, realpathSync } from "fs";
import { basename, resolve, sep } from "path";
import type { BranchRepo, BranchRow, GitOverviewResponse } from "shared";
import { createCardContext } from "./card-context.js";
import { getRepoPulls, matchPull, toBranchPr, type RepoPulls } from "./github-prs.js";
import { getGitWorktreesAsync, resolveWorktreeToMainRepoCached, type WorktreeInfo } from "../utils/git.js";

/** Card ids by member-chat folder, over every open, visible card. */
export function activeCardFolders(): Map<string, Set<string>> {
  const byFolder = new Map<string, Set<string>>();
  // Runs carry no folder, so there is no reason to load them.
  for (const card of createCardContext().summaries([], false, undefined, "open")) {
    for (const member of card.memberChats) {
      if (!member.folder) continue;
      const ids = byFolder.get(member.folder) ?? new Set<string>();
      ids.add(card.id);
      byFolder.set(member.folder, ids);
    }
  }
  return byFolder;
}

/** An absolute path with symlinks resolved where possible and no trailing separator. */
export function normalizeDir(dir: string): string {
  let out = resolve(dir);
  try {
    out = realpathSync.native(out);
  } catch {
    // A directory that no longer exists keeps its lexical form.
  }
  return out.length > 1 && out.endsWith(sep) ? out.slice(0, -1) : out;
}

/** True when `dir` is `root` or lies inside it. */
function isWithin(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
}

interface RepoListing {
  repoPath: string;
  worktrees: Array<WorktreeInfo & { normPath: string }>;
}

export interface OverviewDeps {
  folders: () => Map<string, Set<string>>;
  listWorktrees: (dir: string) => Promise<WorktreeInfo[]>;
  mainRepoOf: (dir: string) => string;
  pullsFor: (repoPath: string, force: boolean) => Promise<RepoPulls>;
  normalize: (dir: string) => string;
  exists: (dir: string) => boolean;
}

const DEFAULT_DEPS: OverviewDeps = {
  folders: activeCardFolders,
  listWorktrees: getGitWorktreesAsync,
  mainRepoOf: (dir) => resolveWorktreeToMainRepoCached(dir).mainRepoPath,
  pullsFor: getRepoPulls,
  normalize: normalizeDir,
  exists: existsSync,
};

/** The worktree with the longest path containing `dir`, if any. */
function owningWorktree(dir: string, repos: Iterable<RepoListing>): { repo: RepoListing; wt: RepoListing["worktrees"][number] } | undefined {
  let best: { repo: RepoListing; wt: RepoListing["worktrees"][number] } | undefined;
  for (const repo of repos) {
    for (const wt of repo.worktrees) {
      if (isWithin(dir, wt.normPath) && (!best || wt.normPath.length > best.wt.normPath.length)) best = { repo, wt };
    }
  }
  return best;
}

/**
 * Assemble the overview. `force` (the refresh button) refetches PR data that
 * the cache would otherwise have served.
 */
export async function buildGitOverview(opts: { force?: boolean } = {}, deps: OverviewDeps = DEFAULT_DEPS): Promise<GitOverviewResponse> {
  const folders = deps.folders();
  const repos = new Map<string, RepoListing>();
  const cardsByCwd = new Map<string, Set<string>>();
  // Folders already shown not to be in any repository, so a second chat in
  // the same non-git directory does not spawn git again.
  const notRepos = new Set<string>();

  // Shortest first: a repository root is listed before its subdirectories,
  // which then resolve against that listing without spawning.
  const ordered = [...folders.keys()].map((folder) => ({ folder, norm: deps.normalize(folder) })).sort((a, b) => a.norm.length - b.norm.length);

  for (const { folder, norm } of ordered) {
    let owner = owningWorktree(norm, repos.values());
    if (!owner) {
      if (notRepos.has(norm) || !deps.exists(norm)) continue;
      const candidate = deps.normalize(deps.mainRepoOf(norm));
      const worktrees = repos.has(candidate) ? [] : await deps.listWorktrees(candidate);
      const usable = worktrees.filter((wt) => !wt.isBare);
      if (usable.length === 0) {
        notRepos.add(norm);
        continue;
      }
      // The main worktree is git's answer for the repository, whichever
      // directory we asked from.
      const repoPath = deps.normalize(usable.find((wt) => wt.isMainWorktree)?.path ?? usable[0].path);
      if (!repos.has(repoPath)) {
        repos.set(repoPath, {
          repoPath,
          worktrees: usable.map((wt) => ({ ...wt, normPath: deps.normalize(wt.path) })).filter((wt) => wt.isMainWorktree || deps.exists(wt.normPath)),
        });
      }
      owner = owningWorktree(norm, repos.values());
      if (!owner) {
        // In the repository's directory tree but not inside any listed
        // worktree — nothing to attach to.
        notRepos.add(norm);
        continue;
      }
    }
    const ids = cardsByCwd.get(owner.wt.normPath) ?? new Set<string>();
    for (const id of folders.get(folder) ?? []) ids.add(id);
    cardsByCwd.set(owner.wt.normPath, ids);
  }

  const listings = [...repos.values()];
  const pulls = await Promise.all(listings.map((repo) => deps.pullsFor(repo.repoPath, opts.force === true)));

  const out: BranchRepo[] = listings.map((repo, i) => {
    const repoPulls = pulls[i];
    const rows: BranchRow[] = repo.worktrees.map((wt) => {
      const pr = wt.branch ? matchPull(repoPulls.byBranch.get(wt.branch), wt.head) : undefined;
      return {
        cwd: wt.normPath,
        branch: wt.branch,
        isMain: wt.isMainWorktree,
        ...(pr && { pr: toBranchPr(pr) }),
        cardIds: [...(cardsByCwd.get(wt.normPath) ?? [])].sort(),
      };
    });
    rows.sort((a, b) => Number(b.isMain) - Number(a.isMain) || (a.branch ?? "￿").localeCompare(b.branch ?? "￿") || a.cwd.localeCompare(b.cwd));
    return { repoPath: repo.repoPath, name: basename(repo.repoPath), rows, ...(repoPulls.error && { prError: repoPulls.error }) };
  });
  out.sort((a, b) => a.name.localeCompare(b.name) || a.repoPath.localeCompare(b.repoPath));

  return { repos: out, generatedAt: new Date().toISOString() };
}
