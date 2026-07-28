/**
 * Presentation helpers for the workspace surface.
 *
 * Kept out of the components because the *wording* is the load-bearing part of
 * this feature. A cleanup surface that says "cannot remove" and stops has told
 * the user nothing; the sentences here are what turn a refusal into something
 * actionable, and they belong somewhere a test can read them.
 */
import type { WorkspaceRemovalBlocker, WorktreeDiskUsage } from "../api";

/** `9.4 GB`. Sizes here run to tens of gigabytes, so the ladder goes that far. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A size, or the reason there isn't one. Never a silent blank. */
export function formatDiskUsage(usage?: WorktreeDiskUsage): string | undefined {
  if (!usage) return undefined;
  if (usage.bytes === undefined) return "size unknown";
  return formatBytes(usage.bytes);
}

/**
 * Short labels for the removal blockers, for a badge that has no room for the
 * backend's full sentence. The sentence is always shown too — as the title
 * attribute and in the archive confirmation — because these labels compress and
 * compression loses the part that tells you what to do.
 */
const BLOCKER_LABELS: Record<WorkspaceRemovalBlocker, string> = {
  "not-a-worktree": "not a worktree",
  "not-owned": "not owned by Callboard",
  "no-repo-path": "no repository recorded",
  "cwd-missing": "directory is gone",
  "not-a-worktree-on-disk": "no longer a worktree",
  "token-missing": "no ownership token",
  "token-mismatch": "ownership token mismatch",
  "shared-cwd": "another workspace uses this directory",
  "has-submodules": "has submodules",
  "uncommitted-changes": "uncommitted changes",
  "untracked-files": "untracked files",
  "unpushed-commits": "unpushed commits",
  "session-still-running": "a session is running",
  "git-check-failed": "git check failed",
  "quarantine-cross-device": "trash is on another filesystem",
  "quarantine-failed": "quarantine failed",
};

export function blockerLabel(code: WorkspaceRemovalBlocker): string {
  return BLOCKER_LABELS[code] ?? code;
}

/**
 * Whether a blocker is something the user can do something about.
 *
 * `not-owned` and `token-missing` are the two that adoption fixes, and they
 * cover the entire pre-Phase-1 backlog — 43 of 44 worktrees on the author's
 * machine. Saying "adopt it" next to those is the difference between a list of
 * refusals and a route out of them.
 */
export function isFixedByAdoption(code: WorkspaceRemovalBlocker): boolean {
  return code === "not-owned" || code === "token-missing";
}
