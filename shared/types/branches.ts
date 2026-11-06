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
  /** Unarchived cards with a member chat in this directory (or below it). Never empty. */
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
