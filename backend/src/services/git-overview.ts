/**
 * The Board's Branches view: every worktree (main checkout included) that an
 * unarchived card is working in, grouped by repository, with those cards
 * attached and, where GitHub knows of one, the branch's pull request. Idle
 * worktrees are not listed — on a long-lived repo they outnumber the active
 * ones by a hundred to a handful.
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
import { existsSync } from "fs";
import { basename, sep } from "path";
import type { BranchPr, BranchRepo, BranchRow, Chat, GitOverviewResponse, GitTrailEntry } from "shared";
import { createCardContext } from "./card-context.js";
import { listChatsSnapshot } from "./chats-snapshot.js";
import { parseGitTrail } from "./git-trail.js";
import { needsBackfill, requestBackfill } from "./git-trail-backfill.js";
import { byOpenThenUpdated, getRepoPulls, matchPull, pullForTrailBranch, toBranchPr, type PullSummary, type RepoPulls } from "./github-prs.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { resolveWorktreeToMainRepoCached, tryGetGitWorktreesAsync, type WorktreeInfo } from "../utils/git.js";
import { findGitRoot, normalizeDir } from "../utils/git-root.js";

/** One git-trail entry of an open card's member chat. */
export interface CardTrailEntry {
  cardId: string;
  entry: GitTrailEntry;
}

/**
 * Card ids by member-chat folder over every open, visible card — and the git
 * trails of those same member chats, read from the same snapshot.
 */
export function activeCardData(): { folders: Map<string, Set<string>>; trails: CardTrailEntry[]; unbackfilled: Chat[] } {
  const stored = listChatsSnapshot();
  const byId = new Map(stored.map((chat) => [chat.id, chat]));
  const folders = new Map<string, Set<string>>();
  const trails: CardTrailEntry[] = [];
  const unbackfilled: Chat[] = [];
  // Runs carry no folder, so there is no reason to load them.
  for (const card of createCardContext(stored).summaries([], false, undefined, "open")) {
    for (const member of card.memberChats) {
      const record = byId.get(member.chatId);
      const meta = parseChatMetadata(record?.metadata);
      for (const entry of parseGitTrail(meta.gitTrail)) trails.push({ cardId: card.id, entry });
      if (record && needsBackfill(meta)) unbackfilled.push(record);
      if (!member.folder) continue;
      const ids = folders.get(member.folder) ?? new Set<string>();
      ids.add(card.id);
      folders.set(member.folder, ids);
    }
  }
  return { folders, trails, unbackfilled };
}

/** Card ids by member-chat folder, over every open, visible card. */
export function activeCardFolders(): Map<string, Set<string>> {
  return activeCardData().folders;
}

// Re-exported from their new home beside the other filesystem-only git
// helpers, so the per-turn git trail can use them without importing this
// module (and the card context it pulls in).
export { findGitRoot, normalizeDir };

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

export type ListedWorktree = WorktreeInfo & { normPath: string };

export interface RepoListing {
  repoPath: string;
  worktrees: ListedWorktree[];
}

/** How the overview — and the chat's PRs tab — reach git and the filesystem. */
export interface PlacementDeps {
  /** `[]` when git refused the directory, `null` when no verdict came (timeout, spawn failure). */
  listWorktrees: (dir: string) => Promise<WorktreeInfo[] | null>;
  mainRepoOf: (dir: string) => string;
  normalize: (dir: string) => string;
  exists: (dir: string) => boolean;
  /** Defaults to {@link findGitRoot} over `exists`. */
  gitRootOf?: (dir: string) => string | null;
  /** The negative cache — module-wide by default, so it outlives the request. */
  notRepos?: Map<string, number>;
  now?: () => number;
}

export interface OverviewDeps extends PlacementDeps {
  folders: () => Map<string, Set<string>>;
  /** The open cards' member chats' git trails. Absent = none, which is the overview without trails. */
  trails?: () => CardTrailEntry[];
  pullsFor: (repoPath: string, force: boolean) => Promise<RepoPulls>;
}

export const DEFAULT_PLACEMENT_DEPS: PlacementDeps = {
  listWorktrees: tryGetGitWorktreesAsync,
  mainRepoOf: (dir) => resolveWorktreeToMainRepoCached(dir).mainRepoPath,
  normalize: normalizeDir,
  exists: existsSync,
};

/** Production deps, reading folders and trails from one card snapshot per request. */
function defaultDeps(): OverviewDeps {
  let active: ReturnType<typeof activeCardData> | undefined;
  const load = () => {
    if (!active) {
      active = activeCardData();
      // Open cards' chats that predate the live trail: backfill from history in
      // the background; a later poll of the Board shows what it found.
      for (const chat of active.unbackfilled) requestBackfill({ chatId: chat.id, chat });
    }
    return active;
  };
  return { ...DEFAULT_PLACEMENT_DEPS, folders: () => load().folders, trails: () => load().trails, pullsFor: getRepoPulls };
}

/** The worktree with the longest path containing `dir`, if any. */
function owningWorktree(dir: string, repo: RepoListing): ListedWorktree | undefined {
  let best: ListedWorktree | undefined;
  for (const wt of repo.worktrees) {
    if (isWithin(dir, wt.normPath) && (!best || wt.normPath.length > best.normPath.length)) best = wt;
  }
  return best;
}

/**
 * Where one folder sits:
 * - `placed` — in `worktree` of `repo`.
 * - `not_git` — gone, outside every repository, known not to list, or inside a
 *   repository's tree but in none of its worktrees (a pruned one).
 * - `no_verdict` — git did not answer for its repository this time.
 */
export type FolderPlacement = { kind: "placed"; repo: RepoListing; worktree: ListedWorktree } | { kind: "not_git" } | { kind: "no_verdict" };

/**
 * Place each folder in its repository's worktree: the repository from the
 * filesystem (nearest `.git`, then its main checkout), the worktree from one
 * `git worktree list` per repository, at most {@link LISTING_CONCURRENCY} at
 * a time. A folder in a nested repository or submodule is placed in that
 * repository, not the worktree around it.
 */
export async function placeFolders(folders: Iterable<string>, deps: PlacementDeps = DEFAULT_PLACEMENT_DEPS): Promise<Map<string, FolderPlacement>> {
  const gitRootOf = deps.gitRootOf ?? ((dir: string) => findGitRoot(dir, deps.exists));
  const notRepos = deps.notRepos ?? notRepoCache;
  const now = (deps.now ?? Date.now)();
  const placements = new Map<string, FolderPlacement>();

  // 1. Folder → repository candidate, from the filesystem alone. The
  //    candidate is the main checkout of the nearest enclosing `.git`, so every
  //    folder of one repository — worktree roots and subdirectories alike —
  //    lands on one candidate and one listing.
  const foldersByCandidate = new Map<string, Array<{ folder: string; norm: string }>>();
  for (const folder of folders) {
    placements.set(folder, { kind: "not_git" });
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

  // 3. Merge listings into repositories and place each folder in the deepest
  //    worktree of ITS repository containing it.
  const repos = new Map<string, RepoListing>();
  candidates.forEach((candidate, i) => {
    const worktrees = listed[i];
    // No verdict (a timeout on a slow disk, say): this request goes without
    // the repo, but it is not remembered as a non-repo — the next asks again.
    if (worktrees === null) {
      for (const { folder } of foldersByCandidate.get(candidate)!) placements.set(folder, { kind: "no_verdict" });
      return;
    }
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
      // (a pruned one, say) — nothing to place it in.
      const worktree = owningWorktree(norm, repo);
      if (worktree) placements.set(folder, { kind: "placed", repo, worktree });
    }
  });
  return placements;
}

/**
 * Assemble the overview. `force` (the refresh button) refetches PR data that
 * the cache would otherwise have served.
 */
export async function buildGitOverview(opts: { force?: boolean } = {}, deps: OverviewDeps = defaultDeps()): Promise<GitOverviewResponse> {
  const folders = deps.folders();
  const placements = await placeFolders(folders.keys(), deps);

  const repos = new Map<string, RepoListing>();
  const cardsByCwd = new Map<string, Set<string>>();
  for (const [folder, placement] of placements) {
    if (placement.kind !== "placed") continue;
    repos.set(placement.repo.repoPath, placement.repo);
    const ids = cardsByCwd.get(placement.worktree.normPath) ?? new Set<string>();
    for (const id of folders.get(folder) ?? []) ids.add(id);
    cardsByCwd.set(placement.worktree.normPath, ids);
  }

  // 4. Only worktrees an open card is working in are rows; a repository left
  //    with none (its folders all sat in pruned worktrees, say) is dropped
  //    BEFORE the PR lookup, so it costs no `gh` call.
  const listings = [...repos.values()]
    .map((repo) => ({ ...repo, worktrees: repo.worktrees.filter((wt) => cardsByCwd.has(wt.normPath)) }))
    .filter((repo) => repo.worktrees.length > 0);

  // 5. The git trails, sorted onto the rows they belong to. An entry on a
  //    live row's directory, from one of that row's cards, adds an earlier
  //    branch to it. An entry whose directory is gone — while its repository
  //    is not — is a removed worktree. Anything else (a directory that still
  //    exists but no open card works in) is not active work, and not a row.
  const earlierByCwd = new Map<string, Set<string>>();
  const removedByRepo = new Map<string, Map<string, { entries: GitTrailEntry[]; cardIds: Set<string> }>>();
  for (const { cardId, entry } of deps.trails?.() ?? []) {
    const cwd = deps.normalize(entry.cwd);
    const repoPath = deps.normalize(entry.repoPath);
    if (cardsByCwd.has(cwd)) {
      if (!cardsByCwd.get(cwd)!.has(cardId)) continue;
      const branches = earlierByCwd.get(cwd) ?? new Set<string>();
      branches.add(entry.branch);
      earlierByCwd.set(cwd, branches);
    } else if (!deps.exists(cwd) && deps.exists(repoPath)) {
      const byCwd = removedByRepo.get(repoPath) ?? new Map();
      const removed = byCwd.get(cwd) ?? { entries: [], cardIds: new Set<string>() };
      removed.entries.push(entry);
      removed.cardIds.add(cardId);
      byCwd.set(cwd, removed);
      removedByRepo.set(repoPath, byCwd);
    }
  }

  // One lookup per repository — live or reachable only through a trail.
  const repoPaths = [...new Set([...listings.map((repo) => repo.repoPath), ...removedByRepo.keys()])];
  const pulls = new Map<string, RepoPulls>();
  await Promise.all(repoPaths.map(async (repoPath) => pulls.set(repoPath, await deps.pullsFor(repoPath, opts.force === true))));

  /** `first` (when there is one), then `others` — open first, most recently updated — one per URL. */
  const badges = (first: PullSummary | undefined, others: PullSummary[]): BranchPr[] => {
    const seen = new Set(first ? [first.url] : []);
    const rest = others.filter((pr) => !seen.has(pr.url) && seen.add(pr.url)).sort(byOpenThenUpdated);
    return [...(first ? [first] : []), ...rest].map(toBranchPr);
  };
  const listingByPath = new Map(listings.map((repo) => [repo.repoPath, repo]));

  const out: BranchRepo[] = [];
  for (const repoPath of repoPaths) {
    const repoPulls = pulls.get(repoPath)!;
    const rows: BranchRow[] = (listingByPath.get(repoPath)?.worktrees ?? []).map((wt) => {
      const pr = wt.branch ? matchPull(repoPulls.byBranch.get(wt.branch), wt.head) : undefined;
      // Earlier branches by name alone; the live branch keeps its SHA rule above.
      const earlier = [...(earlierByCwd.get(wt.normPath) ?? [])]
        .filter((branch) => branch !== wt.branch)
        .map((branch) => pullForTrailBranch(repoPulls, branch))
        .filter((found): found is PullSummary => found !== undefined && found.url !== pr?.url);
      return {
        cwd: wt.normPath,
        branch: wt.branch,
        isMain: wt.isMainWorktree,
        ...(pr && { pr: toBranchPr(pr) }),
        ...(earlier.length > 0 && { prs: badges(pr, earlier) }),
        cardIds: [...cardsByCwd.get(wt.normPath)!].sort(),
      };
    });
    // Removed worktrees: one row per directory, its entries' PRs as badges.
    // Only those with a PR are shown — a deleted worktree with nothing to
    // link to is history, and a long-lived repo has dozens of them.
    for (const [cwd, removed] of removedByRepo.get(repoPath) ?? []) {
      const found = removed.entries.map((entry) => pullForTrailBranch(repoPulls, entry.branch)).filter((pr): pr is PullSummary => pr !== undefined);
      if (found.length === 0) continue;
      const last = removed.entries.reduce((a, b) => (b.lastSeen > a.lastSeen ? b : a));
      rows.push({ cwd, branch: last.branch, isMain: false, removed: true, prs: badges(undefined, found), cardIds: [...removed.cardIds].sort() });
    }
    if (rows.length === 0) continue;
    rows.sort(
      (a, b) =>
        Number(b.isMain) - Number(a.isMain) ||
        Number(!!a.removed) - Number(!!b.removed) ||
        (a.branch ?? "\uffff").localeCompare(b.branch ?? "\uffff") ||
        a.cwd.localeCompare(b.cwd),
    );
    out.push({ repoPath, name: basename(repoPath), rows, ...(repoPulls.error && { prError: repoPulls.error }) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.repoPath.localeCompare(b.repoPath));

  return { repos: out, generatedAt: new Date().toISOString() };
}
