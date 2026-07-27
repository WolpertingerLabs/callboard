/**
 * Workspace — the persisted "where work happens" entity: path, git isolation,
 * and (for worktrees) the *intent* that created it.
 *
 * See plans/workspace-object.md. Phase 1 is additive only: workspaces are
 * written when a chat is started with `useWorktree`, and nothing reads from
 * them yet. `Chat.folder`/`Chat.displayFolder` remain the truth for log paths.
 *
 * READ PRECEDENCE (applies from the moment anything starts reading these):
 * where a value could come from either the workspace record or a chat's path
 * fields, the workspace wins when present and the path fields are the fallback.
 * Never write both from different code paths.
 */

/** Whether work happens in the checkout as-is, or in a git worktree of it. */
export type WorkspaceIsolation = "local" | "worktree";

/**
 * Why a worktree exists — captured at creation time, because git cannot tell
 * us afterwards. "branch-off" created a new branch from a base; the other two
 * checked out something that already existed.
 */
export type WorktreeMode = "branch-off" | "checkout-branch" | "checkout-pr";

export interface WorkspaceWorktree {
  /**
   * True only when Callboard created this worktree. The safety property that
   * gates removal (Phase 2): a directory the user pointed us at is never ours
   * to delete, so anything we merely found on disk is `false`.
   */
  owned: boolean;
  mode: WorktreeMode;
  /** Branch checked out in the worktree. */
  branch: string;
  /** Base the branch was created from ("branch-off" only; absent means HEAD). */
  baseBranch?: string;
  /** PR the worktree was checked out for ("checkout-pr" only). */
  prNumber?: number;
}

export interface Workspace {
  /**
   * Opaque identifier. NEVER parse this back into a path, a branch, or
   * anything else — it carries no meaning beyond identity. Use `cwd` for the
   * directory and `worktree.branch` for the branch.
   */
  id: string;
  /** User-visible label. Renameable; defaults to the last segment of `cwd`. */
  name: string;
  /** Absolute path work happens in. */
  cwd: string;
  /** Main checkout, when `cwd` is a worktree of it. */
  repoPath?: string;
  isolation: WorkspaceIsolation;
  /** Present iff `isolation === "worktree"`. */
  worktree?: WorkspaceWorktree;
  status: "active" | "archived";
  createdAt: string;
  archivedAt?: string;
}

/** Create payload — everything a caller supplies; the store owns id/status/timestamps. */
export interface WorkspacePayload {
  /** Defaults to the last segment of `cwd` when omitted. */
  name?: string;
  cwd: string;
  repoPath?: string;
  isolation: WorkspaceIsolation;
  worktree?: WorkspaceWorktree;
}
