export type PrState = "open" | "closed" | "merged";

export type CheckConclusion = "success" | "failure" | "pending" | "neutral" | "skipped" | "cancelled" | "timed_out" | "action_required";

export interface PrCheckItem {
  name: string;
  conclusion: CheckConclusion | null;
  url?: string;
}

export interface PrChecks {
  rollup: "success" | "failure" | "pending";
  total: number;
  success: number;
  failure: number;
  pending: number;
  neutral: number;
  items: PrCheckItem[];
}

export interface PrInfo {
  number: number;
  url: string;
  /** owner/name, useful when a branch has PRs across forks */
  repo: string;
  /** Target branch (main, release/*, etc.) */
  baseRef: string;
  state: PrState;
  isDraft: boolean;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  approved: boolean;
  openUnresolvedThreads: number;
  /** Total non-outdated review threads (resolved + unresolved). */
  totalThreads: number;
  checks: PrChecks | null;
  updatedAt: string;
  title?: string;
}

export interface BranchLastCommit {
  sha: string;
  shortSha: string;
  author: string;
  subject: string;
  committedAt: string;
}

export interface BranchRow {
  branch: string;
  isCurrent: boolean;
  /** Absolute path of the worktree that has this branch checked out, or null */
  worktreePath: string | null;
  /** Full upstream ref, e.g. "origin/main", if configured */
  upstream: string | null;
  ahead: number;
  behind: number;
  lastCommit: BranchLastCommit | null;
  prs: PrInfo[];
  /**
   * Whether the branch conflicts with the base branch of its primary PR.
   * `null` if no PR is associated, detection was skipped, or git lacks support.
   */
  hasMergeConflict: boolean | null;
  /** Base ref the merge-conflict check was performed against (for tooltips). */
  mergeConflictBase: string | null;
  /** Uncommitted changes in the branch's worktree. `null` when no worktree is present. */
  hasUncommittedChanges: boolean | null;
  /** Commits on the branch that aren't on origin/<branch>. `null` if the remote ref is missing. */
  hasUnpushedCommits: boolean | null;
  /** Count of unpushed commits (best-effort; 0 when false, null when unknown). */
  unpushedCount: number | null;
  /** Whether any tracked chat/session exists in the matching worktree */
  hasLocalSession: boolean;
  /** Most recent chat activity timestamp in worktree (ISO), or null */
  lastActivityAt: string | null;
}

export interface BranchOverviewFolder {
  folder: string;
  displayName: string;
  branches: BranchRow[];
  /** Error message if data for this folder failed to load */
  error?: string;
  /** Whether PR enrichment was attempted (may be false if gh not available) */
  prsEnriched: boolean;
}

export interface BranchOverviewResponse {
  folders: BranchOverviewFolder[];
  fetchedAt: string;
  /** ISO timestamp of when PR data was last refreshed (may be older than fetchedAt) */
  prFetchedAt: string | null;
}
