/**
 * Pull requests, for the Git page and the chat's PRs tab.
 *
 * Two `gh api` REST calls per repository — every open PR, and the most
 * recently updated closed ones, asked for at the same time — make one cache
 * entry, kept per repo for {@link PR_CACHE_TTL_MS} and matched against local
 * branches on every request (the match needs the branch tips, which move more
 * often than the PR list is refetched). An expired entry is served while it
 * refreshes in the background, until it is older than {@link PR_STALE_MAX_MS}.
 *
 * REST, not `gh pr list`: gh's GraphQL-backed commands fail on some repos, and
 * the REST listing carries everything the match needs (head owner, head sha,
 * the base repo's default branch) in one response. gh's `--jq` cuts each
 * response down to the fields read here before it reaches the daemon.
 *
 * PRs a chat's history names by number (`ChatPrLink`) are answered from that
 * listing when it holds them; the rest — older than the listing reaches, or
 * in another repository — cost one batched GraphQL call per repository, and
 * a merged PR is never asked about again. See {@link resolveLinkedPulls}.
 *
 * The closed listing reaches back only {@link CLOSED_PAGE} PRs — a few weeks
 * on a busy repository. A branch the callers need (a live row's, a git
 * trail's) that the listing holds no PR for is therefore asked about by head
 * branch, again one batched GraphQL call per repository, "no PR" cached like
 * an answer. See {@link resolveBranchPulls}. What it finds joins the listing's
 * index and is matched by the same rules ({@link matchPull},
 * {@link pullsForTrailEntry}) — it widens what is known, not what counts.
 *
 * Both by-key caches follow the listing's discipline ({@link lookupNeed}):
 * fresh for the TTL, then served stale while one shared background fetch
 * replaces it; only a key never answered, an entry older than
 * {@link PR_STALE_MAX_MS}, and a forced request wait, and never for longer
 * than {@link PR_FORCE_WAIT_MS}.
 *
 * Every failure — no `gh`, not authenticated, offline, rate limited, a remote
 * that is not GitHub — degrades to "no PR data" for that repo. Nothing here may
 * fail the overview it feeds.
 */
import { execFile } from "child_process";
import type { BranchPr, BranchPrState, ChatPr, ChatPrLink, GitTrailEntry } from "shared";
import { getDefaultBranchAsync, getRemoteUrlAsync } from "../utils/git.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("github-prs");

export const PR_CACHE_TTL_MS = 90_000;
/**
 * The oldest entry served without waiting. Past this — a view opened for the
 * first time in hours — the cache says nothing about today, so the caller
 * waits for the refresh as a forced one would.
 */
export const PR_STALE_MAX_MS = 10 * 60_000;
/** The youngest entry a forced refresh will refetch. */
export const PR_FORCE_MIN_AGE_MS = 10_000;
/** How long a forced refresh waits for `gh` before serving the stale entry. */
export const PR_FORCE_WAIT_MS = 5_000;
/**
 * `gh` processes alive at once, over every repository and every kind of
 * lookup — a repository's two listings are two.
 *
 * Not there to protect the event loop: these are async `execFile`s, and with
 * 1 to 12 listings in flight its delay stayed at the timer's own resolution
 * (max 2.3 ms, `monitorEventLoopDelay` in a 400 MB process). It bounds what
 * one cold request with many repositories asks of GitHub at once: each
 * listing is itself slower the more run beside it (0.45 s alone, ~1.1 s among
 * four, ~1.7 s among eight), and GitHub's secondary rate limits count
 * concurrent requests. Measured on a cold three-repository overview: 2.3 s at
 * 2 (no better than one repository after another), 1.5 s at 4, 1.45 s at 6,
 * 1.45 s at 12 — past a handful, more processes buy nothing.
 */
export const PR_FETCH_CONCURRENCY = 6;
const GH_TIMEOUT_MS = 15_000;
const GH_MAX_BUFFER = 8 * 1024 * 1024;

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

/**
 * Owner and repo from a GitHub remote URL, or null for anything that is not
 * github.com. Accepts the https form (with or without credentials or `.git`),
 * the scp-like ssh form `git@github.com:o/r.git`, and `ssh://` / `git://` URLs.
 */
export function parseGitHubRemote(url: string): GitHubRepoRef | null {
  // Deliberately unsupported, and answered as "not GitHub": ssh host aliases
  // (`git@github-work:o/r` — the real host lives in ~/.ssh/config), the
  // ssh-over-443 host (`ssh://git@ssh.github.com:443/o/r`), and forks whose PRs
  // are opened against an `upstream` remote — only `origin` is ever read.
  const trimmed = url.trim();
  const match =
    /^[\w.-]+@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed) ??
    /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (!match) return null;
  const [, owner, repo] = match;
  return isGitHubRepoName(owner, repo) ? { owner, repo } : null;
}

/**
 * Whether `owner` and `repo` are names GitHub would accept. Both are spliced
 * into a `gh api` path and into URLs, so anything else — `?`, `#`, `&`, `..`
 * — is refused rather than escaped.
 */
export function isGitHubRepoName(owner: string, repo: string): boolean {
  return /^[A-Za-z0-9-]{1,39}$/.test(owner) && /^[A-Za-z0-9._-]+$/.test(repo) && repo !== "." && repo !== "..";
}

/** The subset of a REST pull object this module reads. */
export interface PullSummary {
  number: number;
  url: string;
  title: string;
  state: BranchPrState;
  headRef: string;
  headSha: string;
  /** Null when the head repository has been deleted. */
  headOwner: string | null;
  updatedAt: string;
  /** Display-only fields for the chat's PRs tab, cut from the same listing. */
  baseRef: string;
  author: string | null;
  createdAt: string;
  mergedAt?: string;
  closedAt?: string;
}

/** Narrow one REST pull object, or null when it is missing a field the match needs. */
export function toPullSummary(raw: any): PullSummary | null {
  if (!raw || typeof raw.number !== "number" || typeof raw.html_url !== "string") return null;
  const headRef = raw.head?.ref;
  const headSha = raw.head?.sha;
  if (typeof headRef !== "string" || typeof headSha !== "string") return null;
  const state: BranchPrState = raw.state === "open" ? (raw.draft ? "draft" : "open") : raw.merged_at ? "merged" : "closed";
  const headOwner = raw.head?.repo?.owner?.login;
  const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
  const mergedAt = str(raw.merged_at);
  const closedAt = str(raw.closed_at);
  return {
    number: raw.number,
    url: raw.html_url,
    title: typeof raw.title === "string" ? raw.title : "",
    state,
    headRef,
    headSha,
    headOwner: typeof headOwner === "string" ? headOwner : null,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : "",
    baseRef: str(raw.base?.ref) ?? "",
    author: str(raw.user?.login) ?? null,
    createdAt: str(raw.created_at) ?? "",
    ...(mergedAt && { mergedAt }),
    ...(closedAt && { closedAt }),
  };
}

const isOpen = (pr: Pick<PullSummary, "state">) => pr.state === "open" || pr.state === "draft";

/**
 * Index PRs by head branch: same-owner heads only (a fork's `main` or
 * `fix/typo` is not this repo's branch), never the default branch, and each
 * branch's candidates ordered open-first then most recently updated.
 */
export function indexPullsByBranch(pulls: PullSummary[], owner: string, defaultBranch: string | null): Map<string, PullSummary[]> {
  const byBranch = new Map<string, PullSummary[]>();
  const lowerOwner = owner.toLowerCase();
  for (const pr of pulls) {
    if (pr.headOwner?.toLowerCase() !== lowerOwner) continue;
    if (defaultBranch !== null && pr.headRef === defaultBranch) continue;
    const list = byBranch.get(pr.headRef) ?? [];
    list.push(pr);
    byBranch.set(pr.headRef, list);
  }
  for (const list of byBranch.values()) {
    list.sort(byOpenThenUpdated);
  }
  return byBranch;
}

/**
 * The PR for a local branch whose tip is `localSha`.
 *
 * An open PR from this owner for this branch name is taken as ours without
 * looking at the sha — local commits not yet pushed are the normal state of a
 * branch under review. A closed or merged PR has to *be* this branch: branch
 * names get reused, and an old merged PR on `fix/scroll` says nothing about
 * today's `fix/scroll` unless its head is exactly the commit checked out here.
 * Checking ancestry instead would cost a spawn per row.
 */
export function matchPull(candidates: PullSummary[] | undefined, localSha: string | undefined): PullSummary | undefined {
  if (!candidates) return undefined;
  const open = candidates.find(isOpen);
  if (open) return open;
  if (!localSha) return undefined;
  return candidates.find((pr) => pr.headSha === localSha);
}

/**
 * The PRs of a branch a chat's git trail recorded it on, by branch name — no
 * SHA check: the chat worked on that branch, so the PRs it carried are the
 * chat's, whatever the checkout has moved to since (a squash merge followed
 * by a pull, a later commit, a deleted worktree). What keeps a reused branch
 * name honest is time instead: a PR closed before the chat first saw the
 * branch was finished without it. Open first, then most recently updated (the
 * order {@link indexPullsByBranch} keeps). Never the default branch, and
 * nothing for a repository that is not on GitHub.
 */
export function pullsForTrailEntry(pulls: RepoPulls | undefined, entry: Pick<GitTrailEntry, "branch" | "firstSeen">): PullSummary[] {
  if (!pulls?.github || entry.branch === pulls.defaultBranch) return [];
  // Compared as instants: GitHub's `…:00Z` and a trail's `…:00.500Z` do not
  // sort as strings. An unreadable date disowns nothing.
  const firstSeen = Date.parse(entry.firstSeen);
  return (pulls.byBranch.get(entry.branch) ?? []).filter((pr) => isOpen(pr) || !pr.closedAt || !(Date.parse(pr.closedAt) < firstSeen));
}

/** Open work first, then most recently updated. For a {@link PullSummary} and a `ChatPr` alike. */
export function byOpenThenUpdated(a: Pick<PullSummary, "state" | "updatedAt">, b: Pick<PullSummary, "state" | "updatedAt">): number {
  return Number(isOpen(b)) - Number(isOpen(a)) || b.updatedAt.localeCompare(a.updatedAt);
}

const refKey = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

/** Whether `pr` is a pull request of repository `ref`, by its URL — which an `unknown` PR has too, from its link. */
export function isPullOf(pr: Pick<PullSummary, "url">, ref: GitHubRepoRef | undefined): boolean {
  return ref !== undefined && pr.url.toLowerCase().startsWith(`https://github.com/${ref.owner}/${ref.repo}/pull/`.toLowerCase());
}

/**
 * Whether `pr`, the PR behind `link`, is one of repository `ref`'s: the link
 * names `ref`, or the PR's URL does. Either is enough — after a rename with
 * `origin` left on the old name, the transcript and `origin` agree with each
 * other while GitHub's URL carries the new one.
 */
export function isLinkOf(link: Pick<ChatPrLink, "repo">, pr: Pick<PullSummary, "url">, ref: GitHubRepoRef | undefined): boolean {
  return ref !== undefined && (link.repo.toLowerCase() === refKey(ref.owner, ref.repo) || isPullOf(pr, ref));
}

/**
 * The live `branch`'s PR among those a chat's own records name for this
 * repository — its trail's (from this repository's listing) and its links'
 * (those {@link isLinkOf} it) — for when the SHA rule ({@link matchPull})
 * found none. Held to what {@link indexPullsByBranch} holds a listed PR to —
 * headed by this owner's branch of that name, never the default branch — so
 * a fork's `feat/x` is not promoted onto ours. Open first, then most recently
 * updated: the one answer for the Git page and the PRs tab alike.
 */
export function recordedPullForBranch(recorded: PullSummary[], branch: string | null, pulls: RepoPulls | undefined): PullSummary | undefined {
  const here = pulls?.github;
  if (!here || branch === null || branch === pulls.defaultBranch) return undefined;
  const owner = here.owner.toLowerCase();
  return [...recorded].sort(byOpenThenUpdated).find((pr) => pr.headRef === branch && pr.headOwner?.toLowerCase() === owner);
}

export function toBranchPr(pr: PullSummary): BranchPr {
  return { number: pr.number, url: pr.url, state: pr.state, title: pr.title };
}

export function toChatPr(pr: PullSummary): ChatPr {
  return {
    ...toBranchPr(pr),
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    author: pr.author,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    ...(pr.mergedAt && { mergedAt: pr.mergedAt }),
    ...(pr.closedAt && { closedAt: pr.closedAt }),
  };
}

/** What one repo's lookup produced: its PRs by branch, or why there are none. */
export interface RepoPulls {
  byBranch: Map<string, PullSummary[]>;
  /** Every listed PR by number — fork-headed and default-branch-headed ones included. Absent when nothing was listed. */
  byNumber?: Map<number, PullSummary>;
  /** The GitHub repository `origin` names. Absent when it is not on GitHub — nothing was looked up. */
  github?: GitHubRepoRef;
  /**
   * The repository's default branch, which never has a PR of its own: from
   * the listing when it carried any PR, else from the local
   * `refs/remotes/origin/HEAD`. Absent when neither knew.
   */
  defaultBranch?: string;
  /**
   * Set when the lookup failed. `byBranch` then holds whatever did arrive:
   * the open PRs when only the closed listing failed, the closed ones when
   * only the open listing did, nothing when both did, or — for a failed
   * background refresh — the entry it was meant to replace.
   */
  error?: string;
  /**
   * Set by {@link resolveBranchPulls} when a branch the listing has no PR for
   * could not be asked about: the listing itself is whole, but a PR older
   * than it reaches may be missing.
   */
  branchError?: string;
}

const EMPTY: RepoPulls = { byBranch: new Map() };

/**
 * Run `gh` and resolve its stdout; rejects with stderr's first line on
 * failure. With `partial`, a non-zero exit that still printed something
 * resolves — `gh api graphql` exits 1 when any one aliased field errors (a
 * PR number that does not exist), with the rest of the answer on stdout.
 */
export function runGh(args: string[], cwd: string, partial = false): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile("gh", args, { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER }, (err, stdout, stderr) => {
      if (!err) return resolvePromise(stdout);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return reject(new Error("gh is not installed"));
      if ((err as { killed?: boolean }).killed) return reject(new Error("gh timed out"));
      if (partial && typeof code === "number" && String(stdout ?? "").trim()) return resolvePromise(stdout);
      const firstLine =
        String(stderr ?? "")
          .trim()
          .split("\n")[0] || err.message;
      reject(new Error(firstLine.slice(0, 200)));
    });
    child.stdin?.end();
  });
}

/** Open PRs fetched per repo: every one, short of a repo with more than this many open. */
const OPEN_PAGE = 100;
/** Closed PRs fetched per repo: the most recently updated page, as large as one call allows. */
const CLOSED_PAGE = 100;

/**
 * A REST pull object is ~25 KB, nearly all of it the two embedded repository
 * objects. This keeps exactly what {@link toPullSummary} reads, in the shape
 * it reads it, so a full page is a few KB to buffer and parse instead of MBs.
 */
const PULL_FIELDS =
  "[.[] | {number, html_url, title, state, draft, merged_at, closed_at, created_at, updated_at, user: {login: .user.login}, " +
  "head: {ref: .head.ref, sha: .head.sha, repo: {owner: {login: .head.repo.owner.login}}}, base: {ref: .base.ref, repo: {default_branch: .base.repo.default_branch}}}]";

/** One REST listing of a repo's pulls, narrowed. */
async function listPulls(ref: GitHubRepoRef, repoPath: string, query: string): Promise<{ pulls: PullSummary[]; defaultBranch: string | null }> {
  const raw = JSON.parse(await runGh(["api", `repos/${ref.owner}/${ref.repo}/pulls?${query}`, "--jq", PULL_FIELDS], repoPath));
  if (!Array.isArray(raw)) throw new Error("Unexpected response from GitHub");
  const defaultBranch = raw.map((pr: any) => pr?.base?.repo?.default_branch).find((b: unknown): b is string => typeof b === "string") ?? null;
  return { pulls: raw.map(toPullSummary).filter((pr): pr is PullSummary => pr !== null), defaultBranch };
}

const OPEN_QUERY = `state=open&per_page=${OPEN_PAGE}`;
const CLOSED_QUERY = `state=closed&sort=updated&direction=desc&per_page=${CLOSED_PAGE}`;

const queue: Array<() => void> = [];
let running = 0;

/** Admit `task` — one `gh` process — once fewer than {@link PR_FETCH_CONCURRENCY} are running. */
function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const start = () => {
      running++;
      // Called inside the chain, so a task that throws before returning a
      // promise still releases its slot.
      Promise.resolve()
        .then(task)
        .then(resolvePromise, reject)
        .finally(() => {
          running--;
          queue.shift()?.();
        });
    };
    if (running < PR_FETCH_CONCURRENCY) start();
    else queue.push(start);
  });
}

/**
 * Fetch and index one repo's PRs. Never rejects.
 *
 * Open and closed PRs are two listings, not one `state=all` page: sorted by
 * update time, a page of everything lets a burst of recently closed PRs push
 * an old open one off the end — and the open one is the PR a live worktree
 * most needs.
 *
 * The two run at the same time, each its own {@link PR_FETCH_CONCURRENCY}
 * slot, which halves the wait: one is not a precondition of the other, and
 * whichever arrives is kept when the other fails. What the same failure
 * would cost twice (no `gh`, no auth, offline) is still not paid twice where
 * it can be told in advance: a closed listing still queued when the open one
 * fails is dropped, and with `probe` — set by the cache for a repo whose last
 * lookup failed — the open listing goes first and alone, the closed one
 * following only if it worked.
 */
export async function fetchRepoPulls(repoPath: string, opts: { probe?: boolean } = {}): Promise<RepoPulls> {
  const remote = await getRemoteUrlAsync(repoPath);
  const ref = remote ? parseGitHubRemote(remote) : null;
  // Not on GitHub is not an error — there is simply nothing to look up.
  if (!ref) return EMPTY;
  type Listed = Awaited<ReturnType<typeof listPulls>>;
  const failure = (query: string) => (err: unknown) => {
    const error = err instanceof Error ? err.message : String(err);
    log.debug(`PR lookup failed for ${repoPath} (${query}): ${error}`);
    return { error };
  };
  let openFailed = false;
  const open = limited(() => listPulls(ref, repoPath, OPEN_QUERY)).catch((err) => {
    openFailed = true;
    return failure(OPEN_QUERY)(err);
  });
  if (opts.probe) await open;
  // Null: not asked, because whatever broke the open listing breaks this one.
  const closed = limited<Listed | null>(() => (openFailed ? Promise.resolve(null) : listPulls(ref, repoPath, CLOSED_QUERY))).catch(failure(CLOSED_QUERY));
  const pulls: PullSummary[] = [];
  let defaultBranch: string | null = null;
  let error: string | undefined;
  for (const listed of await Promise.all([open, closed])) {
    if (listed === null) continue;
    if ("error" in listed) {
      error ??= listed.error;
      continue;
    }
    pulls.push(...listed.pulls);
    defaultBranch ??= listed.defaultBranch;
  }
  // A repo with no PRs at all says nothing about its default branch; the
  // remote-tracking HEAD is the cheap local answer, and it is cached with the
  // rest of the entry.
  defaultBranch ??= await getDefaultBranchAsync(repoPath);
  return {
    byBranch: indexPullsByBranch(pulls, ref.owner, defaultBranch),
    byNumber: new Map(pulls.map((pr) => [pr.number, pr])),
    github: ref,
    ...(defaultBranch !== null && { defaultBranch }),
    ...(error !== undefined && { error }),
  };
}

interface CacheEntry {
  /** When `value` was asked for. Absent until the first fetch lands. */
  at?: number;
  value?: RepoPulls;
  /** The fetch in flight, shared by every caller that arrives while it runs. */
  pending?: Promise<RepoPulls>;
}

const cache = new Map<string, CacheEntry>();

/** Start a fetch for `repoPath` unless one is already running; resolves to its result. */
function refresh(repoPath: string, entry: CacheEntry, now: number): Promise<RepoPulls> {
  if (entry.pending) return entry.pending;
  // A repo whose last lookup failed is probed with one call before the second.
  const pending = fetchRepoPulls(repoPath, { probe: entry.value?.error !== undefined })
    .then((value) => {
      // A failed refresh (gh logged out, offline, rate limited) must not wipe
      // badges that were right a minute ago: keep the last good PRs and carry
      // the error alongside them. Stamped either way, so the failure is not
      // retried before the TTL.
      const previous = entry.value;
      entry.at = now;
      entry.value = value.error !== undefined && previous ? { ...previous, error: value.error } : value;
      return entry.value;
    })
    // In a finally, so even a throw cannot leave the entry holding a rejected
    // promise that every later caller would be handed.
    .finally(() => {
      entry.pending = undefined;
    });
  entry.pending = pending;
  return pending;
}

/**
 * One repo's PRs. Stale-while-revalidate: an entry younger than the TTL is
 * served as is; an older one is served too, while a background fetch replaces
 * it — so a poll never waits on `gh` once the repo has been seen. Only a repo
 * with no entry at all waits (bounded by gh's own timeout), and one whose
 * entry is older than {@link PR_STALE_MAX_MS}, which is treated as a forced
 * refresh: an answer from hours ago would otherwise be shown as today's to
 * whoever opens the view first. Concurrent callers
 * share one in-flight fetch, and failures are cached like successes, so a
 * missing `gh` is not re-spawned on every poll.
 *
 * `force` (the refresh button) waits for a fresh fetch of an entry older than
 * {@link PR_FORCE_MIN_AGE_MS} — enough to make the button mean something
 * without letting repeated clicks spend the GitHub rate limit — but for no
 * longer than {@link PR_FORCE_WAIT_MS}: past that the stale entry is served
 * and the fetch lands in the cache for the next poll, so a hung `gh` cannot
 * hold the response.
 */
export async function getRepoPulls(repoPath: string, force = false, now = Date.now()): Promise<RepoPulls> {
  let entry = cache.get(repoPath);
  if (!entry) {
    entry = {};
    cache.set(repoPath, entry);
  }
  const stale = entry.value;
  if (!stale) return refresh(repoPath, entry, now);
  const age = now - (entry.at ?? 0);
  if ((force && age >= PR_FORCE_MIN_AGE_MS) || age >= PR_STALE_MAX_MS) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const capped = new Promise<RepoPulls>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(stale), PR_FORCE_WAIT_MS);
    });
    try {
      return await Promise.race([refresh(repoPath, entry, now), capped]);
    } finally {
      clearTimeout(timer);
    }
  }
  if (age >= PR_CACHE_TTL_MS) void refresh(repoPath, entry, now);
  return stale;
}

// ── Lookups by key: PRs by number, PRs by head branch ────────────────

/** One key's cached answer. */
interface Answered<V> {
  /** When it was last asked about, answered or not. */
  at: number;
  /** The last answer. Absent while no ask has succeeded. */
  value?: V;
  /** Why the last ask failed. Kept beside the last good `value`, like a failed listing refresh. */
  error?: string;
}

interface KeyedCache<V> {
  entries: Map<string, Answered<V>>;
  /** Lookups in flight, by the same key — shared by every caller that arrives while they run. */
  pending: Map<string, Promise<void>>;
}

/** PRs asked about by number, by `owner/repo#number`: null for one GitHub does not have. */
const numberCache: KeyedCache<PullSummary | null> = { entries: new Map(), pending: new Map() };
/** PRs asked about by head branch, by `owner/repo#branch`: every PR GitHub has with that head, `[]` for none. */
const branchCache: KeyedCache<PullSummary[]> = { entries: new Map(), pending: new Map() };

/** What a request has to do about one key: nothing, refetch behind the response, or refetch and wait. */
type LookupNeed = "none" | "background" | "wait";

/**
 * {@link getRepoPulls}' rules, for one cached key. Within the TTL the entry
 * is the answer — a failure included, so what cannot be resolved is not a
 * `gh` spawn on every poll. Past it, the entry is served and refreshed behind
 * the response. Waited for: a key never asked about, an entry too old to
 * pass off as today's ({@link PR_STALE_MAX_MS}), `force` past
 * {@link PR_FORCE_MIN_AGE_MS}, and — unless `staleFailures` — an expired
 * entry that never held an answer, since there is nothing to serve meanwhile.
 * `final` marks an answer that cannot change, which is never asked for again.
 */
function lookupNeed(hit: Answered<unknown> | undefined, now: number, force: boolean, opts: { final?: boolean; staleFailures?: boolean } = {}): LookupNeed {
  if (!hit) return "wait";
  if (opts.final) return "none";
  const age = now - hit.at;
  if (age < PR_CACHE_TTL_MS) return force && age >= PR_FORCE_MIN_AGE_MS ? "wait" : "none";
  if (force || age >= PR_STALE_MAX_MS) return "wait";
  return hit.value === undefined && !opts.staleFailures ? "wait" : "background";
}

/**
 * Start the fetches `items` need — one per group, less whatever is already in
 * flight — and wait, for at most {@link PR_FORCE_WAIT_MS}, for those a
 * response cannot be given without. Resolves true when the cap passed first;
 * the fetches land in the cache for the next poll either way.
 */
async function awaitLookups<T, V>(
  cache: KeyedCache<V>,
  items: Iterable<T>,
  on: { key: (item: T) => string; group: (item: T) => string; need: (hit: Answered<V> | undefined) => LookupNeed; fetch: (group: T[]) => Promise<void> },
): Promise<boolean> {
  const groups = new Map<string, { items: Map<string, T>; wait: boolean }>();
  const waits = new Set<Promise<void>>();
  for (const item of items) {
    const key = on.key(item);
    const need = on.need(cache.entries.get(key));
    if (need === "none") continue;
    const pending = cache.pending.get(key);
    if (pending) {
      if (need === "wait") waits.add(pending);
      continue;
    }
    const group = groups.get(on.group(item)) ?? { items: new Map<string, T>(), wait: false };
    group.items.set(key, item);
    group.wait ||= need === "wait";
    groups.set(on.group(item), group);
  }
  for (const group of groups.values()) {
    const keys = [...group.items.keys()];
    const run = on.fetch([...group.items.values()]).finally(() => {
      for (const key of keys) cache.pending.delete(key);
    });
    for (const key of keys) cache.pending.set(key, run);
    if (group.wait) waits.add(run);
  }
  if (waits.size === 0) return false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<void>((resolvePromise) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolvePromise();
    }, PR_FORCE_WAIT_MS);
  });
  try {
    await Promise.race([Promise.all(waits), capped]);
  } finally {
    clearTimeout(timer);
  }
  return timedOut;
}

/**
 * Ask about `keys` of one repository, a batch (one `gh` process) at a time,
 * into `cache`. Never rejects: a failure is stamped like an answer, so it is
 * not re-asked before the TTL, and the last good answer stays beside it.
 */
async function fetchIntoCache<K, V>(
  cache: KeyedCache<V>,
  ref: GitHubRepoRef,
  keys: K[],
  batchSize: number,
  fetch: (batch: K[]) => Promise<Map<K, V | { error: string }>>,
  now: number,
): Promise<void> {
  const keyOf = (k: K) => `${refKey(ref.owner, ref.repo)}#${k}`;
  const failed = (k: K, error: string) => cache.entries.set(keyOf(k), { ...cache.entries.get(keyOf(k)), at: now, error });
  const isFailure = (answer: V | { error: string }): answer is { error: string } =>
    typeof answer === "object" && answer !== null && !Array.isArray(answer) && "error" in answer;
  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);
    try {
      const fetched = await limited(() => fetch(batch));
      for (const k of batch) {
        const answer = fetched.get(k);
        if (answer === undefined) failed(k, "Unexpected response from GitHub");
        else if (isFailure(answer)) failed(k, answer.error);
        else cache.entries.set(keyOf(k), { at: now, value: answer });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.debug(`PR lookup failed for ${ref.owner}/${ref.repo}: ${error}`);
      // Whatever broke this batch (no gh, offline, a repository this account
      // cannot see) breaks the rest.
      for (const k of keys.slice(i)) failed(k, error);
      return;
    }
  }
}

// ── PRs by number ────────────────────────────────────────────────────

/** PRs asked about per GraphQL call. */
const NUMBER_BATCH = 50;

const GRAPHQL_PULL_FIELDS =
  "number url title state isDraft headRefName headRefOid baseRefName createdAt updatedAt mergedAt closedAt author{login} headRepositoryOwner{login}";

/** Narrow one GraphQL `pullRequest` node into the REST-shaped summary. */
function fromGraphql(node: any): PullSummary | null {
  if (!node || typeof node.number !== "number") return null;
  return toPullSummary({
    number: node.number,
    html_url: node.url,
    title: node.title,
    state: node.state === "OPEN" ? "open" : "closed",
    draft: node.isDraft === true,
    merged_at: node.mergedAt,
    closed_at: node.closedAt,
    created_at: node.createdAt,
    updated_at: node.updatedAt,
    user: { login: node.author?.login },
    head: { ref: node.headRefName, sha: node.headRefOid, repo: { owner: { login: node.headRepositoryOwner?.login } } },
    base: { ref: node.baseRefName },
  });
}

/** One PR number's answer: the PR, null when GitHub says there is none, or why it could not say. */
export type PullAnswer = PullSummary | null | { error: string };

/**
 * One GraphQL call for up to {@link NUMBER_BATCH} PRs of one repository.
 * Only GitHub's own NOT_FOUND for a number makes it null; a field that came
 * back empty for any other reason is an error for that number, not a PR that
 * does not exist.
 */
export async function fetchPullsByNumber(ref: GitHubRepoRef, numbers: number[], cwd: string): Promise<Map<number, PullAnswer>> {
  const fields = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ${GRAPHQL_PULL_FIELDS} }`).join(" ");
  const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
  const out = JSON.parse(await runGh(["api", "graphql", "-f", `owner=${ref.owner}`, "-f", `name=${ref.repo}`, "-f", `query=${query}`], cwd, true));
  const repository = out?.data?.repository;
  // No repository at all: a GraphQL error, or an HTTP-level one (a 401's body
  // is `{ message }`), whose reason is on stdout too.
  if (!repository || typeof repository !== "object") {
    throw new Error(String(out?.errors?.[0]?.message ?? out?.message ?? "Unexpected response from GitHub").slice(0, 200));
  }
  const errors: any[] = Array.isArray(out.errors) ? out.errors : [];
  return new Map(
    numbers.map((n): [number, PullAnswer] => {
      const found = fromGraphql(repository[`p${n}`]);
      if (found) return [n, found];
      const failure = errors.find((e) => Array.isArray(e?.path) && e.path[e.path.length - 1] === `p${n}`);
      if (failure?.type === "NOT_FOUND") return [n, null];
      return [n, { error: String(failure?.message ?? "Unexpected response from GitHub").slice(0, 200) }];
    }),
  );
}

/** A link GitHub could not be asked about, as a PR: its number and URL, state `unknown`. */
function unknownPull(link: ChatPrLink): PullSummary {
  return {
    number: link.number,
    url: link.url,
    title: `${link.repo}#${link.number}`,
    state: "unknown",
    headRef: "",
    headSha: "",
    headOwner: null,
    updatedAt: link.firstSeen,
    baseRef: "",
    author: null,
    createdAt: "",
  };
}

/** What {@link resolveLinkedPulls} answers. */
export interface LinkedPulls {
  pulls: Array<PullSummary | undefined>;
  error?: string;
  errors?: Record<string, string>;
}

export interface LinkedPullDeps {
  fetch: (ref: GitHubRepoRef, numbers: number[], cwd: string) => Promise<Map<number, PullAnswer>>;
  now: () => number;
}

/**
 * The PR behind each of `links`, in order — never fewer than asked for.
 *
 * A link in one of the `known` listings is answered from it, free. The rest
 * are answered from the by-number cache, and what that does not hold is
 * fetched in one GraphQL call per repository (per {@link NUMBER_BATCH}),
 * which `cwd` only gives a directory to run in. A merged PR is cached for
 * good; any other is served from the cache past its TTL too, while one
 * background call brings it up to date for the next poll — an ordinary poll
 * waits only for a link never answered (see {@link lookupNeed}); `force`
 * re-asks and waits. A link GitHub cannot be asked about
 * (no `gh`, offline, a repository this account cannot see) still comes back,
 * as an `unknown` PR carrying its number and URL: the chat's history says it
 * exists. One GitHub says does not exist is dropped — `error` reports the
 * first failure, `errors` the first for each repository (by lowercased
 * `owner/name`), for a caller that shows repositories apart.
 *
 * Like {@link getRepoPulls}: failures are cached for the TTL like answers, so
 * a link that cannot be resolved is not a `gh` spawn on every poll; callers
 * arriving together share one fetch; and any wait is capped at
 * {@link PR_FORCE_WAIT_MS} — past that this answers from what is cached
 * (`unknown` for what never was) and the fetch lands for the next poll.
 */
export async function resolveLinkedPulls(
  links: ChatPrLink[],
  known: Iterable<RepoPulls>,
  opts: { cwd: string; force?: boolean },
  deps: LinkedPullDeps = { fetch: fetchPullsByNumber, now: Date.now },
): Promise<LinkedPulls> {
  const listed = new Map<string, RepoPulls>();
  for (const pulls of known) if (pulls.github) listed.set(refKey(pulls.github.owner, pulls.github.repo), pulls);
  const now = deps.now();
  const keyOf = (link: ChatPrLink) => `${link.repo.toLowerCase()}#${link.number}`;
  const inListing = (link: ChatPrLink) => listed.get(link.repo.toLowerCase())?.byNumber?.get(link.number);

  const force = opts.force === true;
  const asked = links
    .filter((link) => !inListing(link))
    .map((link) => {
      const [owner, repo] = link.repo.split("/");
      return { ref: { owner, repo }, number: link.number, key: keyOf(link) };
    });
  const timedOut = await awaitLookups(numberCache, asked, {
    key: (ask) => ask.key,
    // By lowercased repository, so two spellings of one name are one call.
    group: (ask) => refKey(ask.ref.owner, ask.ref.repo),
    // A merged PR never changes again.
    need: (hit) => lookupNeed(hit, now, force, { final: hit?.value?.state === "merged" }),
    fetch: (group) =>
      fetchIntoCache(
        numberCache,
        group[0].ref,
        group.map((ask) => ask.number),
        NUMBER_BATCH,
        (batch) => deps.fetch(group[0].ref, batch, opts.cwd),
        now,
      ),
  });

  let error: string | undefined;
  const errors: Record<string, string> = {};
  const pulls = links.map((link) => {
    const hit = inListing(link);
    if (hit) return hit;
    const cached = numberCache.entries.get(keyOf(link));
    const failure = cached?.error ?? (!cached && timedOut ? "GitHub did not answer in time" : undefined);
    if (failure !== undefined) {
      error ??= failure;
      errors[link.repo.toLowerCase()] ??= failure;
    }
    // Never answered (the lookup failed, or is still running): the link itself is the answer.
    if (cached?.value === undefined) return unknownPull(link);
    return cached.value ?? undefined;
  });
  return { pulls, ...(error !== undefined && { error, errors }) };
}

// ── PRs by head branch ───────────────────────────────────────────────

/** Branches asked about per GraphQL call. Fifty real ones answer in ~0.8 s, for one rate-limit point. */
const BRANCH_BATCH = 50;
/**
 * PRs taken per branch, most recently updated first. A name is rarely reused
 * this often; forks' PRs with the same head name count against it too, and
 * are dropped afterwards.
 */
const BRANCH_PULLS = 10;

/** One branch's answer: every PR GitHub has with that head (`[]` for none), or why it could not say. */
export type BranchAnswer = PullSummary[] | { error: string };

/**
 * One GraphQL call for the PRs headed by each of up to {@link BRANCH_BATCH}
 * branch names of one repository, in any state. The names travel as GraphQL
 * variables, never spliced into the query: a branch name may hold anything.
 */
export async function fetchPullsByBranch(ref: GitHubRepoRef, branches: string[], cwd: string): Promise<Map<string, BranchAnswer>> {
  const vars = branches.map((_, i) => `, $b${i}: String!`).join("");
  const fields = branches
    .map(
      (_, i) =>
        `b${i}: pullRequests(headRefName: $b${i}, first: ${BRANCH_PULLS}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ${GRAPHQL_PULL_FIELDS} } }`,
    )
    .join(" ");
  const query = `query($owner: String!, $name: String!${vars}) { repository(owner: $owner, name: $name) { ${fields} } }`;
  const args = [
    "api",
    "graphql",
    "-f",
    `owner=${ref.owner}`,
    "-f",
    `name=${ref.repo}`,
    ...branches.flatMap((branch, i) => ["-f", `b${i}=${branch}`]),
    "-f",
    `query=${query}`,
  ];
  const out = JSON.parse(await runGh(args, cwd, true));
  const repository = out?.data?.repository;
  if (!repository || typeof repository !== "object") {
    throw new Error(String(out?.errors?.[0]?.message ?? out?.message ?? "Unexpected response from GitHub").slice(0, 200));
  }
  const errors: any[] = Array.isArray(out.errors) ? out.errors : [];
  return new Map(
    branches.map((branch, i): [string, BranchAnswer] => {
      const nodes = repository[`b${i}`]?.nodes;
      // Only a list is an answer — an empty one is "no PR". A field that came
      // back without one failed, and is not a branch that has none.
      if (Array.isArray(nodes)) {
        // Held to the name asked for, whatever came back.
        return [branch, nodes.map(fromGraphql).filter((pr): pr is PullSummary => pr !== null && pr.headRef === branch)];
      }
      const failure = errors.find((e) => Array.isArray(e?.path) && e.path.includes(`b${i}`));
      return [branch, { error: String(failure?.message ?? "Unexpected response from GitHub").slice(0, 200) }];
    }),
  );
}

export interface BranchPullDeps {
  fetch: (ref: GitHubRepoRef, branches: string[], cwd: string) => Promise<Map<string, BranchAnswer>>;
  now: () => number;
}

/**
 * `pulls` — one repository's listing — with the PRs of `branches` that it is
 * too short to hold: a PR merged or closed longer ago than the
 * {@link CLOSED_PAGE} most recently updated, which no chat's transcript
 * happens to name either.
 *
 * Asked about: each of `branches` the listing has no PR for, never the
 * default branch — one GraphQL call per {@link BRANCH_BATCH} of them
 * ({@link fetchPullsByBranch}), however many there are, which `cwd` only
 * gives a directory to run in. Cached per branch like the PRs asked about by
 * number, "no PR" included, so a repository full of branches that never had
 * one costs one call per TTL, not one per branch per poll; callers arriving
 * together share the fetch. An ordinary poll waits (at most
 * {@link PR_FORCE_WAIT_MS}) only for a branch never asked about before;
 * afterwards the cache answers and is refreshed behind the response, a failed
 * ask included. `force` waits as it does for the listing. Nothing is asked
 * while the listing itself is failing: whatever broke it breaks this.
 *
 * What is found joins `byBranch` through {@link indexPullsByBranch} — this
 * owner's heads only, never the default branch — beside whatever the listing
 * holds for that name, and `byNumber`; the listing's own copy of a PR wins.
 * So every caller's rule applies to it unchanged: a closed PR is a live
 * branch's only at that exact commit ({@link matchPull}), a trail entry's only
 * if it was not closed before the chat got there ({@link pullsForTrailEntry}).
 * An answer once cached stays in the result when the listing later gains a PR
 * for the branch (a new PR on a reused name), though it is then no longer
 * refreshed — a closed PR that is reopened is in the listing, which wins.
 *
 * A branch that could not be asked about sets `branchError`; the listing's
 * PRs are returned regardless. Returns `pulls` itself when there is nothing
 * to add. Never rejects.
 */
export async function resolveBranchPulls(
  pulls: RepoPulls,
  branches: Iterable<string | null | undefined>,
  opts: { cwd: string; force?: boolean },
  deps: BranchPullDeps = { fetch: fetchPullsByBranch, now: Date.now },
): Promise<RepoPulls> {
  const ref = pulls.github;
  if (!ref) return pulls;
  const wanted = [...new Set(branches)].filter((branch): branch is string => typeof branch === "string" && branch !== "" && branch !== pulls.defaultBranch);
  if (wanted.length === 0) return pulls;
  const now = deps.now();
  const keyOf = (branch: string) => `${refKey(ref.owner, ref.repo)}#${branch}`;
  const unlisted = wanted.filter((branch) => !pulls.byBranch.has(branch));

  let timedOut = false;
  if (pulls.error === undefined) {
    timedOut = await awaitLookups(branchCache, unlisted, {
      key: keyOf,
      group: () => "",
      need: (hit) => lookupNeed(hit, now, opts.force === true, { staleFailures: true }),
      fetch: (group) => fetchIntoCache(branchCache, ref, group, BRANCH_BATCH, (batch) => deps.fetch(ref, batch, opts.cwd), now),
    });
  }

  let branchError: string | undefined;
  for (const branch of unlisted) {
    const cached = branchCache.entries.get(keyOf(branch));
    branchError ??= cached?.error ?? (!cached && timedOut ? "GitHub did not answer in time" : undefined);
  }
  const listed = pulls.byNumber ?? new Map<number, PullSummary>();
  const found = new Map<number, PullSummary>();
  for (const branch of wanted) {
    for (const pr of branchCache.entries.get(keyOf(branch))?.value ?? []) if (!listed.has(pr.number)) found.set(pr.number, pr);
  }
  if (found.size === 0) return branchError === undefined ? pulls : { ...pulls, branchError };

  const byBranch = new Map(pulls.byBranch);
  for (const [branch, extra] of indexPullsByBranch([...found.values()], ref.owner, pulls.defaultBranch ?? null)) {
    byBranch.set(branch, [...(byBranch.get(branch) ?? []), ...extra].sort(byOpenThenUpdated));
  }
  return { ...pulls, byBranch, byNumber: new Map([...found, ...listed]), ...(branchError !== undefined && { branchError }) };
}

/** Drop every cached lookup. For tests; production never needs it. */
export function clearRepoPullsCache(): void {
  cache.clear();
  for (const keyed of [numberCache, branchCache]) {
    keyed.entries.clear();
    keyed.pending.clear();
  }
}
