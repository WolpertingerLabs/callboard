/**
 * Pull requests per branch, for the Board's Branches view.
 *
 * One `gh api` REST call per repository lists its most recently updated PRs;
 * the answer is cached per repo for {@link PR_CACHE_TTL_MS} and matched against
 * local branches on every request (the match needs the branch tips, which move
 * more often than the PR list is refetched).
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
  const trimmed = url.trim();
  const scp = /^[\w.-]+@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (scp) return { owner: scp[1], repo: scp[2] };
  const full = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (full) return { owner: full[1], repo: full[2] };
  return null;
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
  /** Set when the lookup failed; `byBranch` is then empty. */
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
      const firstLine = String(stderr ?? "").trim().split("\n")[0] || err.message;
      reject(new Error(firstLine.slice(0, 200)));
    });
    child.stdin?.end();
  });
}

/** Fetch and index one repo's PRs. Never rejects. */
export async function fetchRepoPulls(repoPath: string): Promise<RepoPulls> {
  const remote = await getRemoteUrlAsync(repoPath);
  const ref = remote ? parseGitHubRemote(remote) : null;
  // Not on GitHub is not an error — there is simply nothing to look up.
  if (!ref) return EMPTY;
  try {
    const out = await runGh(["api", `repos/${ref.owner}/${ref.repo}/pulls?state=all&per_page=50&sort=updated&direction=desc`], repoPath);
    const raw = JSON.parse(out);
    if (!Array.isArray(raw)) return { byBranch: new Map(), error: "Unexpected response from GitHub" };
    const defaultBranch = raw.map((pr: any) => pr?.base?.repo?.default_branch).find((b: unknown): b is string => typeof b === "string") ?? null;
    const pulls = raw.map(toPullSummary).filter((pr): pr is PullSummary => pr !== null);
    return { byBranch: indexPullsByBranch(pulls, ref.owner, defaultBranch) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.debug(`PR lookup failed for ${repoPath}: ${message}`);
    return { byBranch: new Map(), error: message };
  }
}

interface CacheEntry {
  at: number;
  pending: Promise<RepoPulls>;
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

/**
 * One repo's PRs, from cache when the entry is younger than the TTL.
 * Concurrent callers for one repo share a single in-flight fetch; failures are
 * cached for the same TTL so a missing `gh` is not re-spawned on every poll.
 *
 * `force` (an explicit refresh) refetches an entry older than
 * {@link PR_FORCE_MIN_AGE_MS} — enough to make the button mean something
 * without letting repeated clicks spend the GitHub rate limit.
 */
export function getRepoPulls(repoPath: string, force = false, now = Date.now()): Promise<RepoPulls> {
  const hit = cache.get(repoPath);
  const maxAge = force ? PR_FORCE_MIN_AGE_MS : PR_CACHE_TTL_MS;
  if (hit && now - hit.at < maxAge) return hit.pending;
  const pending = limited(() => fetchRepoPulls(repoPath));
  cache.set(repoPath, { at: now, pending });
  return pending;
}

/** Drop every cached lookup — the refresh button's `force`, and tests. */
export function clearRepoPullsCache(): void {
  cache.clear();
}
