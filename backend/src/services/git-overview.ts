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
 * full chat scan. Which repository a folder belongs to is answered from the
 * filesystem (the nearest `.git`), so a folder outside any repository spawns
 * nothing; each repository then costs one async `git worktree list` per
 * request, at most {@link LISTING_CONCURRENCY} at a time, plus its PR lookup
 * (two `gh api` calls per {@link PR_CACHE_TTL_MS}, refreshed in the
 * background — see github-prs.ts).
 */
import { existsSync, realpathSync } from "fs";
import { basename, dirname, join, resolve, sep } from "path";
import type { BranchRepo, BranchRow, GitOverviewResponse } from "shared";
import { createCardContext } from "./card-context.js";
import { getRepoPulls, matchPull, toBranchPr, type RepoPulls } from "./github-prs.js";
import { resolveWorktreeToMainRepoCached, tryGetGitWorktreesAsync, type WorktreeInfo } from "../utils/git.js";

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

/**
 * The nearest directory at or above `dir` holding a `.git` (directory, or the
 * file a linked worktree or submodule has), or null when there is none. A
 * filesystem walk, not a spawn — it is what lets a folder in a nested repo or
 * submodule count as its own repository rather than a subdirectory of the
 * worktree around it.
 */
export function findGitRoot(dir: string, exists: (path: string) => boolean = existsSync): string | null {
  for (let current = dir; ; current = dirname(current)) {
    if (exists(join(current, ".git"))) return current;
    if (dirname(current) === current) return null;
  }
}

/** True when `dir` is `root` or lies inside it. */
function isWithin(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Spawning more git processes than this at once measurably stalls the daemon's event loop. */
export const LISTING_CONCURRENCY = 2;

/**
 * How long a directory whose worktree listing came back empty (git refused it,
 * or a `.git` that is not a repository) is skipped without spawning again.
 * Matches the worktree-resolution cache it sits beside.
 */
export const NOT_A_REPO_TTL_MS = 300_000;

/** Repository candidates known not to list, by normalised path → expiry (epoch ms). */
const notRepoCache = new Map<string, number>();

/** `fn` over `items`, at most `limit` in flight, results in input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type ListedWorktree = WorktreeInfo & { normPath: string };

interface RepoListing {
  repoPath: string;
  worktrees: ListedWorktree[];
}

export interface OverviewDeps {
  folders: () => Map<string, Set<string>>;
  /** `[]` when git refused the directory, `null` when no verdict came (timeout, spawn failure). */
  listWorktrees: (dir: string) => Promise<WorktreeInfo[] | null>;
  mainRepoOf: (dir: string) => string;
  pullsFor: (repoPath: string, force: boolean) => Promise<RepoPulls>;
  normalize: (dir: string) => string;
  exists: (dir: string) => boolean;
  /** Defaults to {@link findGitRoot} over `exists`. */
  gitRootOf?: (dir: string) => string | null;
  /** The negative cache — module-wide by default, so it outlives the request. */
  notRepos?: Map<string, number>;
  now?: () => number;
}

const DEFAULT_DEPS: OverviewDeps = {
  folders: activeCardFolders,
  listWorktrees: tryGetGitWorktreesAsync,
  mainRepoOf: (dir) => resolveWorktreeToMainRepoCached(dir).mainRepoPath,
  pullsFor: getRepoPulls,
  normalize: normalizeDir,
  exists: existsSync,
};

/** The worktree with the longest path containing `dir`, if any. */
function owningWorktree(dir: string, repo: RepoListing): ListedWorktree | undefined {
  let best: ListedWorktree | undefined;
  for (const wt of repo.worktrees) {
    if (isWithin(dir, wt.normPath) && (!best || wt.normPath.length > best.normPath.length)) best = wt;
  }
  return best;
}

/**
 * Assemble the overview. `force` (the refresh button) refetches PR data that
 * the cache would otherwise have served.
 */
export async function buildGitOverview(opts: { force?: boolean } = {}, deps: OverviewDeps = DEFAULT_DEPS): Promise<GitOverviewResponse> {
  const gitRootOf = deps.gitRootOf ?? ((dir: string) => findGitRoot(dir, deps.exists));
  const notRepos = deps.notRepos ?? notRepoCache;
  const now = (deps.now ?? Date.now)();
  const folders = deps.folders();

  // 1. Folder → repository candidate, from the filesystem alone. The
  //    candidate is the main checkout of the nearest enclosing `.git`, so every
  //    folder of one repository — worktree roots and subdirectories alike —
  //    lands on one candidate and one listing.
  const foldersByCandidate = new Map<string, Array<{ folder: string; norm: string }>>();
  for (const folder of folders.keys()) {
    const norm = deps.normalize(folder);
    if (!deps.exists(norm)) continue;
    const root = gitRootOf(norm);
    if (root === null) continue;
    const candidate = deps.normalize(deps.mainRepoOf(root));
    const expiry = notRepos.get(candidate);
    if (expiry !== undefined && expiry > now) continue;
    const list = foldersByCandidate.get(candidate) ?? [];
    list.push({ folder, norm });
    foldersByCandidate.set(candidate, list);
  }

  // 2. One listing per candidate, a bounded number at a time.
  const candidates = [...foldersByCandidate.keys()];
  const listed = await mapLimit(candidates, LISTING_CONCURRENCY, (candidate) => deps.listWorktrees(candidate));

  // 3. Merge listings into repositories and attach each folder to the deepest
  //    worktree of ITS repository containing it.
  const repos = new Map<string, RepoListing>();
  const cardsByCwd = new Map<string, Set<string>>();
  candidates.forEach((candidate, i) => {
    const worktrees = listed[i];
    // No verdict (a timeout on a slow disk, say): this response goes without
    // the repo, but it is not remembered as a non-repo — the next poll asks again.
    if (worktrees === null) return;
    const usable = worktrees.filter((wt) => !wt.isBare);
    if (usable.length === 0) {
      notRepos.set(candidate, now + NOT_A_REPO_TTL_MS);
      return;
    }
    notRepos.delete(candidate);
    // The main worktree is git's answer for the repository, whichever
    // directory we asked from. A repository whose main entry is bare has no
    // main checkout to name it, so its first linked worktree stands in.
    const repoPath = deps.normalize(usable.find((wt) => wt.isMainWorktree)?.path ?? usable[0].path);
    let repo = repos.get(repoPath);
    if (!repo) {
      repo = {
        repoPath,
        worktrees: usable.map((wt) => ({ ...wt, normPath: deps.normalize(wt.path) })).filter((wt) => wt.isMainWorktree || deps.exists(wt.normPath)),
      };
      repos.set(repoPath, repo);
    }
    for (const { folder, norm } of foldersByCandidate.get(candidate)!) {
      // In the repository's directory tree but not inside any listed worktree
      // (a pruned one, say) — nothing to attach to.
      const wt = owningWorktree(norm, repo);
      if (!wt) continue;
      const ids = cardsByCwd.get(wt.normPath) ?? new Set<string>();
      for (const id of folders.get(folder) ?? []) ids.add(id);
      cardsByCwd.set(wt.normPath, ids);
    }
  });

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
