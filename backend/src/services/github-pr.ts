import { execFile } from "child_process";
import { promisify } from "util";
import { createLogger } from "../utils/logger.js";
import type { PrInfo, PrState } from "shared/types/index.js";

const execFileAsync = promisify(execFile);
const log = createLogger("github-pr");

interface GhPrReview {
  state?: string;
  author?: { login?: string };
}

interface GhPrReviewThread {
  isResolved?: boolean;
  isOutdated?: boolean;
}

interface GhPrStatusCheck {
  status?: string;
  conclusion?: string;
  state?: string;
}

interface GhPrRecord {
  number: number;
  url: string;
  title?: string;
  headRefName: string;
  baseRefName: string;
  state?: string; // OPEN / CLOSED / MERGED
  isDraft?: boolean;
  reviewDecision?: string; // APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED or ""
  updatedAt?: string;
  reviews?: GhPrReview[];
  reviewThreads?: GhPrReviewThread[];
  statusCheckRollup?: GhPrStatusCheck[];
  headRepository?: { nameWithOwner?: string };
  headRepositoryOwner?: { login?: string };
  repository?: { nameWithOwner?: string };
}

const PR_FIELDS = [
  "number",
  "url",
  "title",
  "headRefName",
  "baseRefName",
  "state",
  "isDraft",
  "reviewDecision",
  "updatedAt",
  "reviews",
  "reviewThreads",
  "statusCheckRollup",
  "headRepository",
  "headRepositoryOwner",
].join(",");

interface CacheEntry {
  data: Map<string, PrInfo[]>;
  repoName: string;
  fetchedAt: number;
  inFlight?: Promise<void>;
}

const PR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

class GithubPrService {
  private cache = new Map<string, CacheEntry>();
  private ghAvailableChecked = false;
  private ghAvailable = false;

  /** Check whether the `gh` CLI is on PATH. Cached after first check. */
  async isAvailable(): Promise<boolean> {
    if (this.ghAvailableChecked) return this.ghAvailable;
    this.ghAvailableChecked = true;
    try {
      await execFileAsync("gh", ["--version"], { timeout: 3000 });
      this.ghAvailable = true;
    } catch {
      this.ghAvailable = false;
    }
    return this.ghAvailable;
  }

  /**
   * Fetch PRs for all branches in a repo in one `gh` call. Returns a map of
   * head branch → PrInfo[]. Uses a stale-while-revalidate cache.
   */
  async getPrsForRepo(repoDir: string, opts: { force?: boolean } = {}): Promise<{ map: Map<string, PrInfo[]>; fetchedAt: number | null }> {
    const cached = this.cache.get(repoDir);
    const now = Date.now();

    if (cached && !opts.force && now - cached.fetchedAt < PR_CACHE_TTL) {
      return { map: cached.data, fetchedAt: cached.fetchedAt };
    }

    // Stale-while-revalidate: return cached data immediately, refresh in background.
    if (cached && !opts.force) {
      if (!cached.inFlight) {
        cached.inFlight = this.fetchAndCache(repoDir).finally(() => {
          const entry = this.cache.get(repoDir);
          if (entry) entry.inFlight = undefined;
        });
      }
      return { map: cached.data, fetchedAt: cached.fetchedAt };
    }

    // No cache (or forced): fetch synchronously.
    try {
      await this.fetchAndCache(repoDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`gh PR fetch failed for ${repoDir}: ${message}`);
      return { map: new Map(), fetchedAt: null };
    }
    const entry = this.cache.get(repoDir);
    return entry ? { map: entry.data, fetchedAt: entry.fetchedAt } : { map: new Map(), fetchedAt: null };
  }

  private async fetchAndCache(repoDir: string): Promise<void> {
    const available = await this.isAvailable();
    if (!available) {
      // Cache empty to avoid repeated checks
      this.cache.set(repoDir, { data: new Map(), repoName: "", fetchedAt: Date.now() });
      return;
    }

    // Fetch both open and closed PRs, but cap closed to keep the response small.
    // Users mostly care about open PRs; closed/merged PRs are for historical context.
    let raw: string;
    try {
      const { stdout } = await execFileAsync("gh", ["pr", "list", "--state", "all", "--limit", "200", "--json", PR_FIELDS], {
        cwd: repoDir,
        timeout: 15000,
        maxBuffer: 10 * 1024 * 1024,
      });
      raw = stdout;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // `gh` failures (not authed, no repo, etc.) — cache empty for the TTL.
      log.debug(`gh pr list failed: ${message}`);
      this.cache.set(repoDir, { data: new Map(), repoName: "", fetchedAt: Date.now() });
      return;
    }

    let prs: GhPrRecord[] = [];
    try {
      prs = JSON.parse(raw);
    } catch {
      this.cache.set(repoDir, { data: new Map(), repoName: "", fetchedAt: Date.now() });
      return;
    }

    const map = new Map<string, PrInfo[]>();
    for (const pr of prs) {
      const info = this.normalize(pr);
      if (!info) continue;
      const list = map.get(pr.headRefName) || [];
      list.push(info);
      map.set(pr.headRefName, list);
    }

    // Sort each branch's PRs: open non-draft > open draft > closed/merged (by updatedAt desc)
    for (const [key, list] of map) {
      list.sort(comparePrs);
      map.set(key, list);
    }

    this.cache.set(repoDir, { data: map, repoName: "", fetchedAt: Date.now() });
  }

  private normalize(pr: GhPrRecord): PrInfo | null {
    if (typeof pr.number !== "number") return null;

    const state: PrState = (pr.state || "").toUpperCase() === "MERGED" ? "merged" : (pr.state || "").toUpperCase() === "CLOSED" ? "closed" : "open";

    const reviewDecision =
      pr.reviewDecision === "APPROVED" || pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED"
        ? pr.reviewDecision
        : null;

    // Count unresolved, non-outdated review threads
    const threads = pr.reviewThreads || [];
    const openUnresolvedThreads = threads.filter((t) => !t.isResolved && !t.isOutdated).length;

    const checksStatus = this.rollupChecks(pr.statusCheckRollup);

    const repo = pr.headRepository?.nameWithOwner || pr.repository?.nameWithOwner || "";

    return {
      number: pr.number,
      url: pr.url,
      repo,
      baseRef: pr.baseRefName,
      state,
      isDraft: !!pr.isDraft,
      reviewDecision,
      approved: reviewDecision === "APPROVED",
      openUnresolvedThreads,
      checksStatus,
      updatedAt: pr.updatedAt || "",
      title: pr.title,
    };
  }

  private rollupChecks(checks?: GhPrStatusCheck[]): "success" | "failure" | "pending" | null {
    if (!checks || checks.length === 0) return null;
    let anyPending = false;
    let anyFailure = false;
    for (const c of checks) {
      // Check runs use status/conclusion; status contexts use state.
      const status = (c.status || "").toUpperCase();
      const conclusion = (c.conclusion || "").toUpperCase();
      const state = (c.state || "").toUpperCase();

      if (status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING" || state === "PENDING") {
        anyPending = true;
      }
      if (conclusion === "FAILURE" || conclusion === "TIMED_OUT" || conclusion === "CANCELLED" || state === "FAILURE" || state === "ERROR") {
        anyFailure = true;
      }
    }
    if (anyFailure) return "failure";
    if (anyPending) return "pending";
    return "success";
  }

  /** Bust the cache for a specific repo. Used by ?refresh=1. */
  invalidate(repoDir: string): void {
    this.cache.delete(repoDir);
  }
}

function comparePrs(a: PrInfo, b: PrInfo): number {
  const rank = (p: PrInfo) => {
    if (p.state === "open" && !p.isDraft) return 0;
    if (p.state === "open" && p.isDraft) return 1;
    return 2;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  // Within same rank, most recently updated first
  return (b.updatedAt || "").localeCompare(a.updatedAt || "");
}

export const githubPrService = new GithubPrService();
