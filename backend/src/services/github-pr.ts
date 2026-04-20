import { execFile } from "child_process";
import { promisify } from "util";
import { createLogger } from "../utils/logger.js";
import type { CheckConclusion, PrChecks, PrCheckItem, PrInfo, PrState } from "shared/types/index.js";

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
  name?: string;
  workflowName?: string;
  context?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

const MAX_CHECK_ITEMS = 50;

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

const PR_FIELDS_CORE = [
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
  "statusCheckRollup",
  "headRepository",
  "headRepositoryOwner",
];

// `reviewThreads` requires gh >= 2.54 or so. Older CLIs return "Unknown JSON field",
// which used to fail the whole query and leave every branch PR-less. We now probe for
// support and degrade gracefully — thread counts show 0 but the rest of the PR data
// still renders.
const PR_FIELDS_WITH_THREADS = [...PR_FIELDS_CORE, "reviewThreads"].join(",");
const PR_FIELDS_CORE_JOINED = PR_FIELDS_CORE.join(",");

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
  // null = unknown, true/false = probed result for this gh install.
  private reviewThreadsSupported: boolean | null = null;

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
    const fields = this.reviewThreadsSupported === false ? PR_FIELDS_CORE_JOINED : PR_FIELDS_WITH_THREADS;
    let raw: string;
    try {
      const { stdout } = await execFileAsync("gh", ["pr", "list", "--state", "all", "--limit", "200", "--json", fields], {
        cwd: repoDir,
        timeout: 15000,
        maxBuffer: 10 * 1024 * 1024,
      });
      raw = stdout;
      if (this.reviewThreadsSupported === null) this.reviewThreadsSupported = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stderr = err && typeof err === "object" && "stderr" in err ? String((err as { stderr: unknown }).stderr || "") : "";
      const unknownThreadsField = /Unknown JSON field: "reviewThreads"/i.test(message) || /Unknown JSON field: "reviewThreads"/i.test(stderr);
      if (unknownThreadsField && this.reviewThreadsSupported !== false) {
        log.warn("gh CLI does not support the 'reviewThreads' JSON field — review thread counts will be unavailable. Upgrade gh for full PR details.");
        this.reviewThreadsSupported = false;
        try {
          const { stdout } = await execFileAsync("gh", ["pr", "list", "--state", "all", "--limit", "200", "--json", PR_FIELDS_CORE_JOINED], {
            cwd: repoDir,
            timeout: 15000,
            maxBuffer: 10 * 1024 * 1024,
          });
          raw = stdout;
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          log.warn(`gh pr list failed after fallback: ${retryMsg}`);
          this.cache.set(repoDir, { data: new Map(), repoName: "", fetchedAt: Date.now() });
          return;
        }
      } else {
        // `gh` failures (not authed, no repo, etc.) — surface so operators can fix.
        log.warn(`gh pr list failed for ${repoDir}: ${message}`);
        this.cache.set(repoDir, { data: new Map(), repoName: "", fetchedAt: Date.now() });
        return;
      }
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
      pr.reviewDecision === "APPROVED" || pr.reviewDecision === "CHANGES_REQUESTED" || pr.reviewDecision === "REVIEW_REQUIRED" ? pr.reviewDecision : null;

    // Count non-outdated review threads (matching what GitHub's UI surfaces).
    const threads = pr.reviewThreads || [];
    const nonOutdated = threads.filter((t) => !t.isOutdated);
    const totalThreads = nonOutdated.length;
    const openUnresolvedThreads = nonOutdated.filter((t) => !t.isResolved).length;

    const checks = this.buildChecks(pr.statusCheckRollup);

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
      totalThreads,
      checks,
      updatedAt: pr.updatedAt || "",
      title: pr.title,
    };
  }

  private buildChecks(checks?: GhPrStatusCheck[]): PrChecks | null {
    if (!checks || checks.length === 0) return null;

    let success = 0;
    let failure = 0;
    let pending = 0;
    let neutral = 0;
    const items: PrCheckItem[] = [];

    for (const c of checks) {
      const status = (c.status || "").toUpperCase();
      const conclusion = (c.conclusion || "").toUpperCase();
      const state = (c.state || "").toUpperCase();

      let bucket: "success" | "failure" | "pending" | "neutral";
      let itemConclusion: CheckConclusion | null;

      if (status === "IN_PROGRESS" || status === "QUEUED" || status === "PENDING" || state === "PENDING") {
        bucket = "pending";
        itemConclusion = null;
      } else if (
        conclusion === "FAILURE" ||
        conclusion === "TIMED_OUT" ||
        conclusion === "CANCELLED" ||
        conclusion === "ACTION_REQUIRED" ||
        conclusion === "STARTUP_FAILURE" ||
        state === "FAILURE" ||
        state === "ERROR"
      ) {
        bucket = "failure";
        itemConclusion =
          conclusion === "TIMED_OUT"
            ? "timed_out"
            : conclusion === "CANCELLED"
              ? "cancelled"
              : conclusion === "ACTION_REQUIRED"
                ? "action_required"
                : "failure";
      } else if (conclusion === "NEUTRAL" || conclusion === "SKIPPED" || conclusion === "STALE") {
        bucket = "neutral";
        itemConclusion = conclusion === "SKIPPED" ? "skipped" : "neutral";
      } else if (conclusion === "SUCCESS" || state === "SUCCESS") {
        bucket = "success";
        itemConclusion = "success";
      } else {
        // Unknown — treat as pending so it doesn't silently disappear.
        bucket = "pending";
        itemConclusion = null;
      }

      if (bucket === "success") success++;
      else if (bucket === "failure") failure++;
      else if (bucket === "pending") pending++;
      else neutral++;

      const name = c.workflowName || c.name || c.context || "check";
      const url = c.detailsUrl || c.targetUrl;
      items.push({ name, conclusion: itemConclusion, url });
    }

    const total = success + failure + pending + neutral;
    const rollup: "success" | "failure" | "pending" = failure > 0 ? "failure" : pending > 0 ? "pending" : "success";

    // Order: failures first, then pending, then others. Bounded to avoid unbounded payloads.
    const bucketRank = (item: PrCheckItem): number => {
      const c = item.conclusion;
      if (c === "failure" || c === "timed_out" || c === "cancelled" || c === "action_required") return 0;
      if (c === null) return 1;
      return 2;
    };
    items.sort((a, b) => bucketRank(a) - bucketRank(b));
    const trimmed = items.length > MAX_CHECK_ITEMS ? items.slice(0, MAX_CHECK_ITEMS) : items;

    return { rollup, total, success, failure, pending, neutral, items: trimmed };
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
