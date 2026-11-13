/**
 * Pull requests, for the Board's Branches view and the chat's PRs tab.
 *
 * Two `gh api` REST calls per repository — every open PR, and the most
 * recently updated closed ones — make one cache entry, kept per repo for
 * {@link PR_CACHE_TTL_MS} and matched against local branches on every request
 * (the match needs the branch tips, which move more often than the PR list is
 * refetched). An expired entry is served while it refreshes in the background,
 * until it is older than {@link PR_STALE_MAX_MS}.
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
  return (pulls.byBranch.get(entry.branch) ?? []).filter((pr) => isOpen(pr) || !pr.closedAt || pr.closedAt >= entry.firstSeen);
}

/** Open work first, then most recently updated. */
export function byOpenThenUpdated(a: PullSummary, b: PullSummary): number {
  return Number(isOpen(b)) - Number(isOpen(a)) || b.updatedAt.localeCompare(a.updatedAt);
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
   * nothing when the first (open) listing failed, the open PRs when only the
   * closed listing did, or — for a failed background refresh — the entry it
   * was meant to replace.
   */
  error?: string;
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

// ── PRs by number ────────────────────────────────────────────────────

const refKey = (owner: string, repo: string) => `${owner}/${repo}`.toLowerCase();

/** PRs asked about by number, by `owner/repo#number`. `value` is null for one GitHub does not have. */
const numberCache = new Map<string, { at: number; value: PullSummary | null }>();

/** A merged PR never changes again; anything else is re-asked once the TTL passes. */
const isSettled = (hit: { at: number; value: PullSummary | null }, now: number) => hit.value?.state === "merged" || now - hit.at < PR_CACHE_TTL_MS;

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

/** One GraphQL call for up to {@link NUMBER_BATCH} PRs of one repository. A number GitHub does not have maps to null. */
export async function fetchPullsByNumber(ref: GitHubRepoRef, numbers: number[], cwd: string): Promise<Map<number, PullSummary | null>> {
  const fields = numbers.map((n) => `p${n}: pullRequest(number: ${n}) { ${GRAPHQL_PULL_FIELDS} }`).join(" ");
  const query = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`;
  const out = JSON.parse(await runGh(["api", "graphql", "-f", `owner=${ref.owner}`, "-f", `name=${ref.repo}`, "-f", `query=${query}`], cwd, true));
  const repository = out?.data?.repository;
  if (!repository || typeof repository !== "object") throw new Error(String(out?.errors?.[0]?.message ?? "Unexpected response from GitHub").slice(0, 200));
  return new Map(numbers.map((n) => [n, fromGraphql(repository[`p${n}`])]));
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

export interface LinkedPullDeps {
  fetch: (ref: GitHubRepoRef, numbers: number[], cwd: string) => Promise<Map<number, PullSummary | null>>;
  now: () => number;
}

/**
 * The PR behind each of `links`, in order — never fewer than asked for.
 *
 * A link in one of the `known` listings is answered from it, free. The rest
 * are answered from the by-number cache, and what that does not hold is
 * fetched in one GraphQL call per repository (per {@link NUMBER_BATCH}),
 * which `cwd` only gives a directory to run in. A merged PR is cached for
 * good; `force` re-asks about any other. A link GitHub cannot be asked about
 * (no `gh`, offline, a repository this account cannot see) still comes back,
 * as an `unknown` PR carrying its number and URL: the chat's history says it
 * exists. One GitHub says does not exist is dropped — `error` reports the
 * first failure.
 */
export async function resolveLinkedPulls(
  links: ChatPrLink[],
  known: Iterable<RepoPulls>,
  opts: { cwd: string; force?: boolean },
  deps: LinkedPullDeps = { fetch: fetchPullsByNumber, now: Date.now },
): Promise<{ pulls: Array<PullSummary | undefined>; error?: string }> {
  const listed = new Map<string, RepoPulls>();
  for (const pulls of known) if (pulls.github) listed.set(refKey(pulls.github.owner, pulls.github.repo), pulls);
  const now = deps.now();
  const keyOf = (link: ChatPrLink) => `${link.repo.toLowerCase()}#${link.number}`;

  const missing = new Map<string, Set<number>>();
  for (const link of links) {
    if (listed.get(link.repo.toLowerCase())?.byNumber?.has(link.number)) continue;
    const hit = numberCache.get(keyOf(link));
    if (hit && isSettled(hit, now) && !(opts.force && hit.value?.state !== "merged" && now - hit.at >= PR_FORCE_MIN_AGE_MS)) continue;
    const numbers = missing.get(link.repo) ?? new Set<number>();
    numbers.add(link.number);
    missing.set(link.repo, numbers);
  }

  let error: string | undefined;
  await Promise.all(
    [...missing].map(async ([repo, numbers]) => {
      const [owner, name] = repo.split("/");
      const all = [...numbers];
      for (let i = 0; i < all.length; i += NUMBER_BATCH) {
        const batch = all.slice(i, i + NUMBER_BATCH);
        try {
          const fetched = await limited(() => deps.fetch({ owner, repo: name }, batch, opts.cwd));
          for (const n of batch) numberCache.set(`${repo.toLowerCase()}#${n}`, { at: now, value: fetched.get(n) ?? null });
        } catch (err) {
          error ??= err instanceof Error ? err.message : String(err);
          log.debug(`PR lookup by number failed for ${repo}: ${error}`);
          break;
        }
      }
    }),
  );

  const pulls = links.map((link) => {
    const hit = listed.get(link.repo.toLowerCase())?.byNumber?.get(link.number);
    if (hit) return hit;
    const cached = numberCache.get(keyOf(link));
    // Never fetched (the lookup failed): the link itself is the answer.
    if (!cached) return unknownPull(link);
    return cached.value ?? undefined;
  });
  return { pulls, ...(error !== undefined && { error }) };
}

/** Drop every cached lookup. For tests; production never needs it. */
export function clearRepoPullsCache(): void {
  cache.clear();
  numberCache.clear();
}
