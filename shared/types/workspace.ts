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

// ── Removability (Phase 2) ──────────────────────────────────────────
//
// Whether a workspace's worktree may be removed, and — far more useful — why
// not. Every automatic removal is gated on this, and a caller that asked for
// an archive gets the blockers back so a refusal is legible rather than
// silent.
//
// "Removed" throughout this section means **quarantined**: moved to
// ~/.callboard/trash/ and unregistered with `git worktree prune`, never
// deleted. See utils/worktree-trash.ts for why, and for how to restore one.

/**
 * Why a worktree was NOT removed. Ordered from "never was a candidate" to
 * "would have destroyed work".
 */
export type WorkspaceRemovalBlocker =
  /** Not a worktree at all. A directory the user works in is never removed. */
  | "not-a-worktree"
  /** `worktree.owned` is false — Callboard did not create it. */
  | "not-owned"
  /** A worktree record with no `repoPath`; there is no repo to run removal from. */
  | "no-repo-path"
  /** The directory is already gone. Nothing to remove. */
  | "cwd-missing"
  /** The directory is no longer a worktree of the recorded repo. */
  | "not-a-worktree-on-disk"
  /**
   * No identity token. Every record written before Phase 2, and every worktree
   * the user recreated by hand. Reads as "not ours" and stays.
   */
  | "token-missing"
  /** A token naming a different workspace. */
  | "token-mismatch"
  /** Another active workspace still references this directory (ref-count > 0). */
  | "shared-cwd"
  /**
   * The worktree involves submodules. `mv` does not mind them, but the
   * `git worktree prune` that follows deletes the worktree's admin dir — and a
   * submodule initialised in a worktree keeps its **object database** there, so
   * pruning destroys submodule history that quarantine cannot give back.
   */
  | "has-submodules"
  /** Staged or unstaged modifications to tracked files. */
  | "uncommitted-changes"
  /** Untracked files in the working tree. */
  | "untracked-files"
  /** Commits reachable from HEAD and from no other ref. */
  | "unpushed-commits"
  /**
   * An agent session is still live in this directory, or one refused to stop
   * within the teardown timeout. Moving a directory out from under a running
   * subprocess is how a removal ends up half-done.
   */
  | "session-still-running"
  /** A git command failed, so cleanliness could not be established. Refuse. */
  | "git-check-failed"
  /** The trash directory is on another filesystem, so the move is not atomic. */
  | "quarantine-cross-device"
  /** Every check passed but the quarantine itself failed. Nothing was moved. */
  | "quarantine-failed";

export interface WorkspaceRemovalReason {
  code: WorkspaceRemovalBlocker;
  /** Human-readable detail — safe to surface directly. */
  detail: string;
}

/**
 * Gitignored entries that would travel into the trash with the directory.
 * Informational only — never a blocker (see utils/worktree-trash.ts).
 */
export interface WorkspaceIgnoredPreview {
  /** Collapsed paths relative to the worktree, capped. */
  entries: string[];
  truncated: boolean;
  /** Set when git could not be asked. Still not a blocker. */
  error?: string;
}

export interface WorkspaceRemovability {
  /** True only when every gate passed. Never inferred from an empty list. */
  removable: boolean;
  /** All blockers, not just the first — a caller should see every reason. */
  blockers: WorkspaceRemovalReason[];
  /**
   * What would move to the trash alongside the tracked files. Only computed
   * when `removable` is true: for a workspace that is staying put there is
   * nothing to preview, and the listing pays a git subprocess per entry.
   */
  ignored?: WorkspaceIgnoredPreview;
}

/** A workspace plus the removability verdict for its directory. */
export interface WorkspaceWithRemovability extends Workspace {
  removability: WorkspaceRemovability;
}

/**
 * What happened to the directory.
 *
 * `partial` is the honest answer to a failed removal, and it exists because the
 * previous design lied about one: `git worktree remove` can delete tracked
 * files, delete the admin dir and unregister the worktree and *still* exit
 * non-zero, which was reported as "kept". A record in that state can never be
 * cleaned up — the directory exists, it is no longer a worktree, and the
 * identity token that proved ownership is gone.
 */
export type WorktreeDisposition =
  /** Moved to the trash and unregistered. Restorable. */
  | "quarantined"
  /** Untouched: a gate refused, or there was no worktree to act on. */
  | "kept"
  /** Acted on and now in an inconsistent state. `state` says what was found. */
  | "partial";

/** What the directory looked like on re-inspection after a failed removal. */
export interface WorktreeInspection {
  cwdExists: boolean;
  /** Still listed by `git worktree list` in the recorded main repo. */
  registeredWorktree: boolean;
  /** The git admin dir (`<repo>/.git/worktrees/<slug>`) still resolves. */
  adminDirExists: boolean;
  /** The Callboard identity token is still readable there. */
  tokenPresent: boolean;
}

/** Result of the lifecycle archive (cascade + ref-counted worktree quarantine). */
export interface ArchiveWorkspaceResult {
  workspace: Workspace;
  /** Chats that belonged to the workspace, and whether a live session was stopped. */
  chats: Array<{ chatId: string; interrupted: boolean }>;
  worktree: {
    /**
     * True when the directory was moved into the trash. That includes a
     * `partial` outcome where the move landed but git's bookkeeping did not —
     * `disposition` is the field to branch on, this one only says whether the
     * directory is still where it was.
     */
    removed: boolean;
    /** Which of the three outcomes this was. */
    disposition: WorktreeDisposition;
    /** The directory that was (or was not) quarantined. */
    path: string;
    /** Where it went. Only set when `disposition === "quarantined"`. */
    trashPath?: string;
    /** Empty only when `removed` is true. */
    blockers: WorkspaceRemovalReason[];
    /** What was found on re-inspection. Only set when `disposition === "partial"`. */
    state?: WorktreeInspection;
    /** Ignored entries that moved with it. Only set when quarantined. */
    ignored?: WorkspaceIgnoredPreview;
  };
}
