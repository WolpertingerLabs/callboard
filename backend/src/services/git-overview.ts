/**
 * The Git page: every worktree (main checkout included) that an
 * unarchived card is working in, grouped by repository, with those cards
 * attached and, where GitHub knows of one, the branch's pull request. Idle
 * worktrees are not listed — on a long-lived repo they outnumber the active
 * ones by a hundred to a handful.
 *
 * Rows key on the directory (`cwd`), never on a workspace id — this is a
 * listing of directories, and two workspaces on one checkout are one row (see
 * "Workspace keying" in .claude/CLAUDE.md).
 *
 * What the cards' chats themselves did adds to each row: the PRs of branches
 * their folders were on earlier (the git trail) and the PRs their transcripts
 * name (PR links, see chat-pr-links.ts). A branch — a row's or a trail's —
 * whose PR is older than the repository's listing reaches is looked up by
 * name (`resolveBranchPulls` in github-prs.ts), so finding it does not depend
 * on a transcript naming it. A link goes on the row its chat's
 * folder is in, and only when the PR is that row's repository's — a PR the
 * chat made in another repository is on the chat's PRs tab, not here. When
 * the folder is gone, the link goes on the `removed` row a git trail recorded
 * for that directory. When no trail recorded it, a `removed` row is made for
 * the folder only if every link of its chats names the same GitHub repository
 * and exactly one repository looked up in this request is that one; otherwise
 * none of its links are shown. That is a guess at where the folder was: a
 * deleted folder that was never a worktree of that repository, but whose
 * chats only made PRs there, gets the row too.
 *
 * Cost: card membership comes from the stat-gated card rollup, never from a
 * full chat scan. Which repository a folder belongs to is answered from the
 * filesystem (the nearest `.git`), so a folder outside any repository spawns
 * nothing; each repository then costs one async `git worktree list` per
 * request (~3 ms), at most {@link LISTING_CONCURRENCY} at a time, plus its PR
 * lookup: two concurrent `gh api` listings per `PR_CACHE_TTL_MS`, and one
 * batched call for the branches and one for the linked PRs those listings do
 * not hold. All three are cached and refreshed behind the response. A poll
 * waits on GitHub — never longer than `PR_FORCE_WAIT_MS` — only for what it
 * has never been told, for an answer older than `PR_STALE_MAX_MS` (the page
 * opened for the first time in a while), for a linked PR whose every earlier
 * ask failed, and when forced. What one request can spawn is bounded per
 * repository; the count is on `resolveBranchPulls` in github-prs.ts.
 */
import { existsSync } from "fs";
import { homedir } from "os";
import { basename, sep } from "path";
import type { BranchPr, BranchRepo, BranchRow, Chat, ChatPrLink, GitOverviewResponse, GitTrailEntry } from "shared";
import { createCardContext } from "./card-context.js";
import { parsePrLinks, syncPrLinksInBackground } from "./chat-pr-links.js";
import { listChatsSnapshot } from "./chats-snapshot.js";
import { parseGitTrail } from "./git-trail.js";
import { needsBackfill, requestBackfill } from "./git-trail-backfill.js";
import {
  byOpenThenUpdated,
  getRepoPulls,
  isLinkOf,
  matchPull,
  pullsForTrailEntry,
  recordedPullForBranch,
  resolveBranchPulls,
  resolveLinkedPulls,
  toBranchPr,
  type BranchAsk,
  type LinkedPulls,
  type PullSummary,
  type RepoPulls,
} from "./github-prs.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { resolveWorktreeToMainRepoCached, tryGetGitWorktreesAsync, type WorktreeInfo } from "../utils/git.js";
import { findGitRoot, normalizeDir } from "../utils/git-root.js";

/** One git-trail entry of an open card's member chat. */
export interface CardTrailEntry {
  cardId: string;
  entry: GitTrailEntry;
}

/** One PR an open card's member chat names in its history, with the folder that chat works in. */
export interface CardPrLink {
  cardId: string;
  folder: string;
  link: ChatPrLink;
}

/**
 * Card ids by member-chat folder over every open, visible card — and the git
 * trails and PR links of those same member chats, read from the same snapshot.
 */
export function activeCardData(): {
  folders: Map<string, Set<string>>;
  trails: CardTrailEntry[];
  links: CardPrLink[];
  unbackfilled: Chat[];
  members: Chat[];
} {
  const stored = listChatsSnapshot();
  const byId = new Map(stored.map((chat) => [chat.id, chat]));
  const folders = new Map<string, Set<string>>();
  const trails: CardTrailEntry[] = [];
  const links: CardPrLink[] = [];
  const unbackfilled: Chat[] = [];
  const members: Chat[] = [];
  // Runs carry no folder, so there is no reason to load them.
  for (const card of createCardContext(stored).summaries([], false, undefined, "open")) {
    for (const member of card.memberChats) {
      const record = byId.get(member.chatId);
      const meta = parseChatMetadata(record?.metadata);
      for (const entry of parseGitTrail(meta.gitTrail)) trails.push({ cardId: card.id, entry });
      if (record) members.push(record);
      if (record && needsBackfill(meta)) unbackfilled.push(record);
      if (!member.folder) continue;
      for (const link of parsePrLinks(meta.prLinks)) links.push({ cardId: card.id, folder: member.folder, link });
      const ids = folders.get(member.folder) ?? new Set<string>();
      ids.add(card.id);
      folders.set(member.folder, ids);
    }
  }
  return { folders, trails, links, unbackfilled, members };
}

// Re-exported from their new home beside the other filesystem-only git
// helpers, so the per-turn git trail can use them without importing this
// module (and the card context it pulls in).
export { findGitRoot, normalizeDir };

/** True when `dir` is `root` or lies inside it. */
function isWithin(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * `git worktree list` processes alive at once. Starting a process blocks the
 * event loop, for longer the more memory the daemon holds: measured ~1 ms per
 * `git` in a 100 MB process, ~11 ms at 400 MB (a running daemon), ~34 ms at
 * 900 MB. Started back to back the stalls add up — 24 listings at 400 MB:
 * longest stall 21 ms at 2 at a time, 40 ms at 4, 77–92 ms at 8, for a total
 * that only fell from 0.36 s to 0.30 s. So this stays small: the listings are
 * 3 ms each, and nothing is waiting on them the way it waits on GitHub.
 */
export const LISTING_CONCURRENCY = 2;

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
  /**
   * `[]` when git refused the directory, `null` when no verdict came (timeout,
   * spawn failure). Asked on every request: neither answer is remembered, so
   * neither can outlive the condition that caused it.
   */
  listWorktrees: (dir: string) => Promise<WorktreeInfo[] | null>;
  mainRepoOf: (dir: string) => string;
  normalize: (dir: string) => string;
  exists: (dir: string) => boolean;
  /** Defaults to {@link findGitRoot} over `exists`. */
  gitRootOf?: (dir: string) => string | null;
}

export interface OverviewDeps extends PlacementDeps {
  folders: () => Map<string, Set<string>>;
  /** The open cards' member chats' git trails. Absent = none, which is the overview without trails. */
  trails?: () => CardTrailEntry[];
  /** The PRs the open cards' member chats' histories name. Absent = none. */
  links?: () => CardPrLink[];
  pullsFor: (repoPath: string, force: boolean) => Promise<RepoPulls>;
  /** The PR behind each link, in order; see {@link resolveLinkedPulls}. */
  linkedPulls?: (links: ChatPrLink[], known: RepoPulls[], force: boolean) => Promise<LinkedPulls>;
  /**
   * `pulls` with the PRs of `branches` its listing is too short to hold; see
   * {@link resolveBranchPulls}. Absent = the listing alone.
   */
  branchPulls?: (repoPath: string, pulls: RepoPulls, branches: BranchAsk, force: boolean) => Promise<RepoPulls>;
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
      // the background; a later poll of the Git page shows what it found.
      for (const chat of active.unbackfilled) requestBackfill({ chatId: chat.id, chat });
      // Their PR links are read from the transcripts once, in the background;
      // from then on each turn's end keeps them current.
      syncPrLinksInBackground(active.members);
    }
    return active;
  };
  return {
    ...DEFAULT_PLACEMENT_DEPS,
    folders: () => load().folders,
    trails: () => load().trails,
    links: () => load().links,
    pullsFor: getRepoPulls,
    linkedPulls: (links, known, force) => resolveLinkedPulls(links, known, { cwd: homedir(), force }),
    branchPulls: (repoPath, pulls, branches, force) => resolveBranchPulls(pulls, branches, { cwd: repoPath, force }),
  };
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
 * - `not_git` — gone, outside every repository, under a `.git` that git
 *   refused or that lists no checkout, or inside a repository's tree but in
 *   none of its worktrees (a pruned one).
 * - `no_verdict` — git did not answer for its repository this time.
 */
export type FolderPlacement = { kind: "placed"; repo: RepoListing; worktree: ListedWorktree } | { kind: "not_git" } | { kind: "no_verdict" };

/**
 * Place each folder in its repository's worktree: the repository from the
 * filesystem (nearest `.git`, then its main checkout), the worktree from one
 * `git worktree list` per repository, at most {@link LISTING_CONCURRENCY} at
 * a time. A folder in a nested repository or submodule is placed in that
 * repository, not the worktree around it.
 *
 * Nothing is remembered between requests. A listing costs ~3 ms, and a
 * remembered refusal once hid a whole repository for five minutes after a
 * single failed `git worktree list`; now the next request simply asks again.
 */
export async function placeFolders(folders: Iterable<string>, deps: PlacementDeps = DEFAULT_PLACEMENT_DEPS): Promise<Map<string, FolderPlacement>> {
  const gitRootOf = deps.gitRootOf ?? ((dir: string) => findGitRoot(dir, deps.exists));
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
    // the repo, and says so — unlike a refusal, which reads as "not git".
    if (worktrees === null) {
      for (const { folder } of foldersByCandidate.get(candidate)!) placements.set(folder, { kind: "no_verdict" });
      return;
    }
    const usable = worktrees.filter((wt) => !wt.isBare);
    if (usable.length === 0) return;
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
  //    live row's directory, from one of that row's cards, adds its branch's
  //    PRs to it. An entry whose directory is gone — while its repository
  //    is not — is a removed worktree. Anything else (a directory that still
  //    exists but no open card works in) is not active work, and not a row.
  const trailByCwd = new Map<string, GitTrailEntry[]>();
  const removedByRepo = new Map<string, Map<string, { entries: GitTrailEntry[]; cardIds: Set<string> }>>();
  const removedCwds = new Set<string>();
  for (const { cardId, entry } of deps.trails?.() ?? []) {
    const cwd = deps.normalize(entry.cwd);
    const repoPath = deps.normalize(entry.repoPath);
    if (cardsByCwd.has(cwd)) {
      if (!cardsByCwd.get(cwd)!.has(cardId)) continue;
      trailByCwd.set(cwd, [...(trailByCwd.get(cwd) ?? []), entry]);
    } else if (!deps.exists(cwd) && deps.exists(repoPath)) {
      const byCwd = removedByRepo.get(repoPath) ?? new Map();
      const removed = byCwd.get(cwd) ?? { entries: [], cardIds: new Set<string>() };
      removed.entries.push(entry);
      removed.cardIds.add(cardId);
      byCwd.set(cwd, removed);
      removedByRepo.set(repoPath, byCwd);
      removedCwds.add(cwd);
    }
  }

  // One lookup per repository — live or reachable only through a trail.
  const repoPaths = [...new Set([...listings.map((repo) => repo.repoPath), ...removedByRepo.keys()])];
  const pulls = new Map<string, RepoPulls>();
  await Promise.all(repoPaths.map(async (repoPath) => pulls.set(repoPath, await deps.pullsFor(repoPath, opts.force === true))));

  // The branches each repository's rows will ask about — live rows' own, and
  // their and the removed rows' trail entries' — for the PRs older than its
  // listing reaches. Started here and joined below, beside the linked PRs:
  // both are GitHub, and neither needs the other's answer.
  const branchesByRepo = new Map<string, { live: Set<string>; trail: Set<string> }>();
  const wantBranch = (repoPath: string, kind: "live" | "trail", branch: string | null) => {
    if (!branch) return;
    const asked = branchesByRepo.get(repoPath) ?? { live: new Set<string>(), trail: new Set<string>() };
    asked[kind].add(branch);
    branchesByRepo.set(repoPath, asked);
  };
  for (const repo of listings) {
    for (const wt of repo.worktrees) {
      wantBranch(repo.repoPath, "live", wt.branch);
      for (const entry of trailByCwd.get(wt.normPath) ?? []) wantBranch(repo.repoPath, "trail", entry.branch);
    }
  }
  for (const [repoPath, byCwd] of removedByRepo) {
    for (const removed of byCwd.values()) for (const entry of removed.entries) wantBranch(repoPath, "trail", entry.branch);
  }
  const branchLookups = Promise.all(
    [...branchesByRepo].map(async ([repoPath, branches]) => {
      const listed = pulls.get(repoPath)!;
      // Never fatal: a lookup that throws leaves the listing as it was.
      try {
        const asked = { live: [...branches.live], trail: [...branches.trail] };
        return [repoPath, (await deps.branchPulls?.(repoPath, listed, asked, opts.force === true)) ?? listed] as const;
      } catch {
        return [repoPath, listed] as const;
      }
    }),
  );

  // 6. The PRs the chats' histories name, onto the row their chat's folder is
  //    in: the worktree it was placed in, else the removed worktree it was.
  //    A folder that is gone with no trail to say which repository it was in
  //    is taken to have been a worktree of the one repository here that all
  //    of its links name. Decided per folder, not per link: links to two
  //    repositories, or to one that is not here (or is here twice), and the
  //    folder has no row and none of its links are shown.
  const repoByRef = new Map<string, string | null>();
  for (const [repoPath, repoPulls] of pulls) {
    if (!repoPulls.github) continue;
    const ref = `${repoPulls.github.owner}/${repoPulls.github.repo}`.toLowerCase();
    repoByRef.set(ref, repoByRef.has(ref) ? null : repoPath);
  }
  const allLinks = deps.links?.() ?? [];
  const cwdOf = (folder: string) => {
    const placement = placements.get(folder);
    return placement?.kind === "placed" ? placement.worktree.normPath : deps.normalize(folder);
  };
  const namedBy = new Map<string, Set<string>>();
  for (const { folder, link } of allLinks) {
    if (placements.get(folder)?.kind === "placed") continue;
    const cwd = cwdOf(folder);
    if (removedCwds.has(cwd) || deps.exists(cwd)) continue;
    namedBy.set(cwd, (namedBy.get(cwd) ?? new Set<string>()).add(link.repo.toLowerCase()));
  }
  for (const [cwd, refs] of namedBy) {
    const repoPath = refs.size === 1 ? repoByRef.get([...refs][0]) : null;
    if (!repoPath) continue;
    const byCwd = removedByRepo.get(repoPath) ?? new Map();
    byCwd.set(cwd, { entries: [], cardIds: new Set<string>() });
    removedByRepo.set(repoPath, byCwd);
    removedCwds.add(cwd);
  }
  const rowLinks = allLinks.flatMap(({ cardId, folder, link }) => {
    const cwd = cwdOf(folder);
    return placements.get(folder)?.kind === "placed" || removedCwds.has(cwd) ? [{ cwd, cardId, link }] : [];
  });
  const linkedByCwd = new Map<string, Array<{ pr: PullSummary; cardId: string; link: ChatPrLink }>>();
  let linkErrors: Record<string, string> = {};
  const linkLookup =
    rowLinks.length > 0 && deps.linkedPulls
      ? deps.linkedPulls(
          rowLinks.map(({ link }) => link),
          [...pulls.values()],
          opts.force === true,
        )
      : undefined;
  const [branchFound, resolved] = await Promise.all([branchLookups, linkLookup]);
  for (const [repoPath, found] of branchFound) pulls.set(repoPath, found);
  if (resolved) {
    linkErrors = resolved.errors ?? {};
    rowLinks.forEach(({ cwd, cardId, link }, i) => {
      const pr = resolved.pulls[i];
      if (pr) linkedByCwd.set(cwd, [...(linkedByCwd.get(cwd) ?? []), { pr, cardId, link }]);
    });
  }

  // One per URL, compared in lower case: an `unknown` PR's URL is spelled as
  // the transcript spelled the repository, a listed one's as GitHub does.
  const urlKey = (pr: PullSummary) => pr.url.toLowerCase();
  /** `first` (when there is one), then `others` — open first, most recently updated — one per URL. */
  const badges = (first: PullSummary | undefined, others: PullSummary[]): BranchPr[] => {
    const seen = new Set(first ? [urlKey(first)] : []);
    const rest = others.filter((pr) => !seen.has(urlKey(pr)) && seen.add(urlKey(pr))).sort(byOpenThenUpdated);
    return [...(first ? [first] : []), ...rest].map(toBranchPr);
  };
  const listingByPath = new Map(listings.map((repo) => [repo.repoPath, repo]));

  const out: BranchRepo[] = [];
  for (const repoPath of repoPaths) {
    const repoPulls = pulls.get(repoPath)!;
    // A row shows its own repository's PRs: a link to another repository's
    // `#12` would read as this one's.
    const linkedOn = (cwd: string) => (linkedByCwd.get(cwd) ?? []).filter(({ link, pr }) => isLinkOf(link, pr, repoPulls.github));
    // Why a link shown on a row here could not be asked about — the
    // repository then says so, as it does for a failed listing. The failure
    // of the repository that link names, never another's.
    let linkError: string | undefined;
    const noteFailures = (shown: Array<{ pr: PullSummary; link: ChatPrLink }>) => {
      for (const { pr, link } of shown) if (pr.state === "unknown") linkError ??= linkErrors[link.repo.toLowerCase()];
    };
    const rows: BranchRow[] = (listingByPath.get(repoPath)?.worktrees ?? []).map((wt) => {
      noteFailures(linkedOn(wt.normPath));
      const linked = linkedOn(wt.normPath).map(({ pr }) => pr);
      // What this row's chats recorded: their trail's branches (by name and
      // time) and the PRs their histories name.
      const recorded = [...(trailByCwd.get(wt.normPath) ?? []).flatMap((entry) => pullsForTrailEntry(repoPulls, entry)), ...linked];
      // The live branch's PR: the SHA rule, else the one the chats recorded for it.
      const pr = (wt.branch ? matchPull(repoPulls.byBranch.get(wt.branch), wt.head) : undefined) ?? recordedPullForBranch(recorded, wt.branch, repoPulls);
      const others = recorded.filter((found) => !pr || urlKey(found) !== urlKey(pr));
      return {
        cwd: wt.normPath,
        branch: wt.branch,
        isMain: wt.isMainWorktree,
        ...(pr && { pr: toBranchPr(pr) }),
        ...(others.length > 0 && { prs: badges(pr, others) }),
        cardIds: [...cardsByCwd.get(wt.normPath)!].sort(),
      };
    });
    // Removed worktrees: one row per directory, its entries' and links' PRs
    // as badges. Only those with a PR are shown — a deleted worktree with
    // nothing to link to is history, and a long-lived repo has dozens of them.
    for (const [cwd, removed] of removedByRepo.get(repoPath) ?? []) {
      const linked = linkedOn(cwd);
      const found = [...removed.entries.flatMap((entry) => pullsForTrailEntry(repoPulls, entry)), ...linked.map(({ pr }) => pr)];
      if (found.length === 0) continue;
      noteFailures(linked);
      // The card whose chat made a PR shown here belongs on the row, whether
      // or not its trail recorded the directory.
      const cardIds = new Set([...removed.cardIds, ...linked.map(({ cardId }) => cardId)]);
      const last = removed.entries.reduce<GitTrailEntry | undefined>((a, b) => (!a || b.lastSeen > a.lastSeen ? b : a), undefined);
      rows.push({ cwd, branch: last?.branch ?? null, isMain: false, removed: true, prs: badges(undefined, found), cardIds: [...cardIds].sort() });
    }
    const prError = repoPulls.error ?? repoPulls.branchError ?? linkError;
    if (rows.length === 0) continue;
    rows.sort(
      (a, b) =>
        Number(b.isMain) - Number(a.isMain) ||
        Number(!!a.removed) - Number(!!b.removed) ||
        (a.branch ?? "\uffff").localeCompare(b.branch ?? "\uffff") ||
        a.cwd.localeCompare(b.cwd),
    );
    // Partial: PR data is shown all the same — a listing that half arrived
    // or is kept from before a failed refresh, or a whole one beside a
    // by-branch or by-number lookup that failed. Not partial: there is none.
    const partial = repoPulls.error === undefined || repoPulls.errorPartial === true;
    out.push({ repoPath, name: basename(repoPath), rows, ...(prError && { prError }), ...(prError && partial && { prErrorPartial: true as const }) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.repoPath.localeCompare(b.repoPath));

  return { repos: out, generatedAt: new Date().toISOString() };
}
