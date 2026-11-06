/**
 * Pull requests per branch, for the Board's Branches view.
 *
 * Two `gh api` REST calls per repository — every open PR, and the most
 * recently updated closed ones — make one cache entry, kept per repo for
 * {@link PR_CACHE_TTL_MS} and matched against local branches on every request
 * (the match needs the branch tips, which move more often than the PR list is
 * refetched). An expired entry is served while it refreshes in the background.
 *
 * REST, not `gh pr list`: gh's GraphQL-backed commands fail on some repos, and
 * the REST listing carries everything the match needs (head owner, head sha,
 * the base repo's default branch) in one response.
 *
 * Every failure — no `gh`, not authenticated, offline, rate limited, a remote
 * that is not GitHub — degrades to "no PR data" for that repo. Nothing here may
 * fail the overview it feeds.
 */
import { execFile } from "child_process";
import type { BranchPr, BranchPrState } from "shared";
import { getRemoteUrlAsync } from "../utils/git.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("github-prs");

export const PR_CACHE_TTL_MS = 90_000;
/** The youngest entry a forced refresh will refetch. */
export const PR_FORCE_MIN_AGE_MS = 10_000;
/** How long a forced refresh waits for `gh` before serving the stale entry. */
export const PR_FORCE_WAIT_MS = 5_000;
/** Spawning more processes than this at once measurably stalls the daemon's event loop. */
export const PR_FETCH_CONCURRENCY = 2;
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
  // Both are spliced into a `gh api` path, so anything GitHub would not accept
  // as a name — `?`, `#`, `&`, `..` — is refused here rather than escaped.
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner)) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
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
}

/** Narrow one REST pull object, or null when it is missing a field the match needs. */
export function toPullSummary(raw: any): PullSummary | null {
  if (!raw || typeof raw.number !== "number" || typeof raw.html_url !== "string") return null;
  const headRef = raw.head?.ref;
  const headSha = raw.head?.sha;
  if (typeof headRef !== "string" || typeof headSha !== "string") return null;
  const state: BranchPrState = raw.state === "open" ? (raw.draft ? "draft" : "open") : raw.merged_at ? "merged" : "closed";
  const headOwner = raw.head?.repo?.owner?.login;
  return {
    number: raw.number,
    url: raw.html_url,
    title: typeof raw.title === "string" ? raw.title : "",
    state,
    headRef,
    headSha,
    headOwner: typeof headOwner === "string" ? headOwner : null,
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : "",
  };
}

const isOpen = (pr: PullSummary) => pr.state === "open" || pr.state === "draft";

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
    list.sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.updatedAt.localeCompare(a.updatedAt));
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

export function toBranchPr(pr: PullSummary): BranchPr {
  return { number: pr.number, url: pr.url, state: pr.state, title: pr.title };
}

/** What one repo's lookup produced: its PRs by branch, or why there are none. */
export interface RepoPulls {
  byBranch: Map<string, PullSummary[]>;
  /**
   * Set when the lookup failed. `byBranch` then holds whatever did arrive:
   * nothing when the first (open) listing failed, the open PRs when only the
   * closed listing did, or — for a failed background refresh — the entry it
   * was meant to replace.
   */
  error?: string;
}

const EMPTY: RepoPulls = { byBranch: new Map() };

/** Run `gh` and resolve its stdout; rejects with stderr's first line on failure. */
export function runGh(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile("gh", args, { cwd, encoding: "utf8", timeout: GH_TIMEOUT_MS, maxBuffer: GH_MAX_BUFFER }, (err, stdout, stderr) => {
      if (!err) return resolvePromise(stdout);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return reject(new Error("gh is not installed"));
      if ((err as { killed?: boolean }).killed) return reject(new Error("gh timed out"));
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
/** Closed PRs fetched per repo — only the recent ones can still match a live worktree. */
const CLOSED_PAGE = 50;

/** One REST listing of a repo's pulls, narrowed. */
async function listPulls(ref: GitHubRepoRef, repoPath: string, query: string): Promise<{ pulls: PullSummary[]; defaultBranch: string | null }> {
  const raw = JSON.parse(await runGh(["api", `repos/${ref.owner}/${ref.repo}/pulls?${query}`], repoPath));
  if (!Array.isArray(raw)) throw new Error("Unexpected response from GitHub");
  const defaultBranch = raw.map((pr: any) => pr?.base?.repo?.default_branch).find((b: unknown): b is string => typeof b === "string") ?? null;
  return { pulls: raw.map(toPullSummary).filter((pr): pr is PullSummary => pr !== null), defaultBranch };
}

/**
 * Fetch and index one repo's PRs. Never rejects.
 *
 * Open and closed PRs are two listings, not one `state=all` page: sorted by
 * update time, a page of everything lets a burst of recently closed PRs push
 * an old open one off the end — and the open one is the PR a live worktree
 * most needs. The two run one after the other, so a repo holds one
 * {@link PR_FETCH_CONCURRENCY} slot for both.
 */
export async function fetchRepoPulls(repoPath: string): Promise<RepoPulls> {
  const remote = await getRemoteUrlAsync(repoPath);
  const ref = remote ? parseGitHubRemote(remote) : null;
  // Not on GitHub is not an error — there is simply nothing to look up.
  if (!ref) return EMPTY;
  const pulls: PullSummary[] = [];
  let defaultBranch: string | null = null;
  let error: string | undefined;
  for (const query of [`state=open&per_page=${OPEN_PAGE}`, `state=closed&sort=updated&direction=desc&per_page=${CLOSED_PAGE}`]) {
    try {
      const listed = await listPulls(ref, repoPath, query);
      pulls.push(...listed.pulls);
      defaultBranch ??= listed.defaultBranch;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log.debug(`PR lookup failed for ${repoPath} (${query}): ${error}`);
      // Whatever broke the first call (no gh, no auth, offline) breaks the second.
      break;
    }
  }
  return { byBranch: indexPullsByBranch(pulls, ref.owner, defaultBranch), ...(error !== undefined && { error }) };
}

interface CacheEntry {
  /** When `value` was asked for. Absent until the first fetch lands. */
  at?: number;
  value?: RepoPulls;
  /** The fetch in flight, shared by every caller that arrives while it runs. */
  pending?: Promise<RepoPulls>;
}

const cache = new Map<string, CacheEntry>();
const queue: Array<() => void> = [];
let running = 0;

/** Admit `task` once fewer than {@link PR_FETCH_CONCURRENCY} fetches are running. */
function limited<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const start = () => {
      running++;
      task()
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

/** Start a fetch for `repoPath` unless one is already running; resolves to its result. */
function refresh(repoPath: string, entry: CacheEntry, now: number): Promise<RepoPulls> {
  if (entry.pending) return entry.pending;
  const pending = limited(() => fetchRepoPulls(repoPath))
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
 * with no entry at all waits (bounded by gh's own timeout). Concurrent callers
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
  if (force && age >= PR_FORCE_MIN_AGE_MS) {
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

/** Drop every cached lookup. For tests; production never needs it. */
export function clearRepoPullsCache(): void {
  cache.clear();
}
