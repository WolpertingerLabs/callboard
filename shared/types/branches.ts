/**
 * `GET /api/git/overview` — the Board's Branches view.
 *
 * Organised around **directories**, not cards: one row per worktree (checkout)
 * an unarchived card is working in, keyed on `cwd` (see "Workspace keying" in
 * .claude/CLAUDE.md), grouped by repository. Cards are attached to the row
 * whose directory contains their member chats' folders. Only worktrees with at
 * least one such card are rows — the main checkout included — so `cardIds` is
 * never empty, and a repository with no rows is not listed.
 *
 * The open cards' git trails add to that, never replace it: a live row lists
 * the PRs of branches its chats were on earlier in that directory beside its
 * live one (`prs`), and a worktree a trail recorded that has since been
 * deleted gets a `removed` row of its own — when it has a PR to show.
 *
 * An HTTP response, not part of the stream wire surface.
 */

/** `draft` is an open PR marked as a draft; `merged` is a closed PR that merged. */
export type BranchPrState = "open" | "draft" | "merged" | "closed";

export interface BranchPr {
  number: number;
  url: string;
  state: BranchPrState;
  title: string;
}

export interface BranchRow {
  /** The worktree's directory — the row's identity. */
  cwd: string;
  /** Null for a detached HEAD. */
  branch: string | null;
  /** The repository's main checkout, as opposed to a linked worktree. */
  isMain: boolean;
  /** The pull request for this branch, when the repo is on GitHub and one matched. */
  pr?: BranchPr;
  /**
   * Every PR to badge on this row when the git trail adds any: `pr` first (when
   * there is one), then the PRs of branches this directory's chats were on
   * earlier — open first, then most recently updated — one per URL. Absent when
   * the trail adds nothing, so a row then reads exactly as `pr` alone.
   */
  prs?: BranchPr[];
  /**
   * A worktree the git trail recorded that no longer exists. `branch` is the
   * last one recorded there, `prs` holds its PRs, and there is no `pr` (no
   * live branch to match). Absent on every live row.
   */
  removed?: true;
  /** Unarchived cards with a member chat in this directory (or below it), or — on a removed row — whose chats' trails recorded it. Never empty. */
  cardIds: string[];
}

export interface BranchRepo {
  /** The main checkout's path. */
  repoPath: string;
  /** Display name — the main checkout's directory name. */
  name: string;
  rows: BranchRow[];
  /**
   * Why there is no PR data for this repo, when looking it up failed (no `gh`,
   * not authenticated, network, rate limit). Absent when the lookup worked or
   * was never attempted (no GitHub remote).
   */
  prError?: string;
}

export interface GitOverviewResponse {
  repos: BranchRepo[];
  /** ISO timestamp the response was assembled at. */
  generatedAt: string;
}

/**
 * A pull request with the detail the chat's PRs tab shows. Every field comes
 * from the same REST listing the overview's {@link BranchPr} is cut from — no
 * per-PR calls.
 */
export interface ChatPr extends BranchPr {
  /** The PR's head branch. */
  headRef: string;
  /** The branch it targets. */
  baseRef: string;
  /** The author's GitHub login; null when GitHub did not say (a deleted account). */
  author: string | null;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  /** Set once merged. */
  mergedAt?: string;
  /** Set once closed (merged or not). */
  closedAt?: string;
}

/**
 * What one directory's branch has, and why when it has nothing:
 * - `found` — `pr` is set.
 * - `not_git` — the directory is not in a git repository (or no longer exists).
 * - `not_github` — the repository's `origin` is not on github.com.
 * - `detached` — no branch is checked out.
 * - `default_branch` — the repository's default branch, which has no PR by design.
 * - `no_pr` — GitHub has no PR this branch matches.
 * - `error` — the lookup failed; `prError` says why.
 */
export type FolderPrStatus = "found" | "not_git" | "not_github" | "detached" | "default_branch" | "no_pr" | "error";

/** A directory's PR, keyed on the directory (see "Workspace keying" in .claude/CLAUDE.md). */
export interface FolderPrs {
  /** The directory asked about. */
  folder: string;
  /** The worktree containing it, when it is in a repository. */
  cwd?: string;
  /** Display name of the repository — its main checkout's directory name. */
  repoName?: string;
  /** The branch checked out there; null for a detached HEAD. Absent outside a repository. */
  branch?: string | null;
  status: FolderPrStatus;
  /** The PR matched to the live branch (`status: "found"`). */
  pr?: ChatPr;
  /**
   * Every PR of this chat's own history: `pr` (when found) plus the PRs of
   * branches its git trail recorded it on earlier — worktrees since deleted
   * included — deduplicated by URL, open first, then most recently updated.
   * Present on the chat PRs route; absent when there are none.
   */
  prs?: ChatPr[];
  /**
   * Why PR data is missing or may be stale. With `status: "error"` there is no
   * PR; alongside `found` it means a refresh failed and the PR shown is the
   * last good answer.
   */
  prError?: string;
}

/**
 * One (directory, branch) a chat's folder was seen on — the chat's git trail,
 * stored as `metadata.gitTrail` and recorded at every turn's start and end.
 * One entry per distinct (`cwd`, `branch`); detached HEADs are not recorded.
 */
export interface GitTrailEntry {
  /** The checkout root the chat's folder resolved to (a worktree, or the main checkout). */
  cwd: string;
  /** Its repository's main checkout — still a repository after `cwd` is deleted. */
  repoPath: string;
  branch: string;
  /** The commit checked out at the last recorded sighting. Absent when it could not be read without git. */
  head?: string;
  /** ISO timestamps of the first and the last recorded sighting. */
  firstSeen: string;
  lastSeen: string;
}

/** One chat on the card that a {@link CardPr} was found through. */
export interface CardPrSource {
  chatId: string;
  title: string | null;
  folder: string;
}

/** A PR another chat on the same card is working on, deduplicated across chats. */
export interface CardPr {
  pr: ChatPr;
  repoName: string;
  branch: string;
  /** The chats whose directories this PR was matched from. */
  sources: CardPrSource[];
}

/**
 * `GET /api/git/prs?folder=…[&chatId=…]` — the PRs tab of a chat's git view.
 *
 * `current` is the PR of the chat's own directory. `card` lists the PRs of
 * the card's other directories — member chats working elsewhere — and is
 * absent without a `chatId`, when the chat is on no card, or when no other
 * member chat works in another directory.
 */
export interface ChatPrsResponse {
  current: FolderPrs;
  card?: {
    cardId: string;
    title: string;
    prs: CardPr[];
  };
  /** ISO timestamp the response was assembled at. */
  generatedAt: string;
}
