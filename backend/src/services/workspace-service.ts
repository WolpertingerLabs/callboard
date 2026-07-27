/**
 * Workspace lifecycle — the phase that actually removes directories.
 *
 * workspace-store.ts persists records; this composes that store with git and
 * the chat store to answer one question and act on it: may this worktree be
 * deleted, and if not, why not?
 *
 * Every gate is a refusal, and they are all AND-ed:
 *
 *   isolation === "worktree"        a folder the user pointed us at is never touched
 *   worktree.owned === true         we only remove what we created
 *   identity token verifies         ...and can still prove it (utils/worktree-token.ts)
 *   still a worktree of repoPath    the record still describes what is on disk
 *   no other active workspace       the ref-count: the last reference removes it
 *   clean                           no uncommitted changes, no untracked files,
 *                                   no commits that exist nowhere else
 *
 * Anything unresolvable — a git command that failed, a directory that vanished
 * mid-check — is a refusal too. There is no branch in this file that removes a
 * directory on a "probably fine", and `--force` appears nowhere in the removal
 * path (see {@link import("../utils/git.js").worktreeRemoveArgs}).
 *
 * Refusals are collected, not short-circuited: a caller asking why a worktree
 * survived should see every reason at once.
 *
 * @see plans/workspace-object.md — Phase 2
 */
import { existsSync, realpathSync } from "fs";
import { resolve } from "path";
import type {
  ArchiveWorkspaceResult,
  Chat,
  Workspace,
  WorkspaceRemovability,
  WorkspaceRemovalReason,
  WorkspaceWithRemovability,
} from "shared/types/index.js";
import { checkWorktreeClean, removeWorktree, resolveWorktreeToMainRepo } from "../utils/git.js";
import { verifyWorktreeToken } from "../utils/worktree-token.js";
import { chatFileService } from "./chat-file-service.js";
import { sessionRegistry } from "./session-registry.js";
import { archiveWorkspace as markWorkspaceArchived, getWorkspace, listWorkspaces } from "./workspace-store.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-service");

/** Compare two paths, tolerating `..`/`.` segments and symlinked parents. */
function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Other *active* workspaces on the same directory — the reference count.
 *
 * Deliberately not workspace-store's `listWorkspacesByCwd`, which matches the
 * `cwd` string exactly. Here a missed match means removing a directory another
 * workspace is still working in, so the comparison resolves paths: strictly
 * more matches, never fewer.
 */
function otherActiveWorkspacesOn(workspace: Workspace): Workspace[] {
  return listWorkspaces({ status: "active" }).filter((other) => other.id !== workspace.id && samePath(other.cwd, workspace.cwd));
}

/**
 * Chats linked to this workspace.
 *
 * `workspaceId` is the only linkage consulted. Matching on `folder` instead
 * would sweep in every chat that ever ran in the directory, including ones
 * belonging to a different workspace on the same `cwd` — absent linkage means
 * absent, never "probably this one".
 */
export function chatsForWorkspace(workspaceId: string): Chat[] {
  return chatFileService.getAllChats().filter((chat) => chat.workspaceId === workspaceId);
}

/**
 * May this workspace's worktree be removed, and if not, why not?
 *
 * Pure inspection — reads the registry, the filesystem and git, and writes
 * nothing. Safe to call from a listing.
 */
export function evaluateWorktreeRemoval(workspace: Workspace): WorkspaceRemovability {
  const blockers: WorkspaceRemovalReason[] = [];
  const add = (code: WorkspaceRemovalReason["code"], detail: string) => blockers.push({ code, detail });

  // ── Identity: is this even a thing we may remove? ──
  if (workspace.isolation !== "worktree" || !workspace.worktree) {
    add("not-a-worktree", `${workspace.cwd} is a local directory, not a worktree Callboard created`);
    return { removable: false, blockers };
  }
  if (!workspace.worktree.owned) {
    add("not-owned", `Callboard did not create ${workspace.cwd} — it was found on disk, so it is not ours to remove`);
  }
  if (!workspace.repoPath) {
    add("no-repo-path", `No main repo recorded for ${workspace.cwd}`);
  }

  // ── Reality: does the record still describe what is on disk? ──
  const exists = existsSync(workspace.cwd);
  if (!exists) {
    add("cwd-missing", `${workspace.cwd} no longer exists`);
  } else {
    // Uncached: a cached resolution can be up to five minutes stale, and a
    // worktree removed and recreated inside that window would resolve to the
    // wrong admin dir — the exact case the token exists to catch.
    const resolution = resolveWorktreeToMainRepo(workspace.cwd);
    if (!resolution.isWorktree) {
      add("not-a-worktree-on-disk", `${workspace.cwd} is no longer a git worktree`);
    } else if (workspace.repoPath && !samePath(resolution.mainRepoPath, workspace.repoPath)) {
      add("not-a-worktree-on-disk", `${workspace.cwd} is a worktree of ${resolution.mainRepoPath}, not of the recorded ${workspace.repoPath}`);
    } else {
      switch (verifyWorktreeToken(workspace.cwd, workspace.id)) {
        case "verified":
          break;
        case "missing":
          add(
            "token-missing",
            `${workspace.cwd} carries no Callboard identity token. Either it predates worktree lifecycle tracking, or it was ` +
              `recreated outside Callboard — in both cases it is not ours to remove.`,
          );
          break;
        case "mismatch":
          add("token-mismatch", `${workspace.cwd} carries an identity token for a different workspace`);
          break;
        case "unresolvable":
          add("not-a-worktree-on-disk", `Could not resolve a git admin directory for ${workspace.cwd}`);
          break;
      }
    }
  }

  // ── Reference count: is anyone still using it? ──
  const others = otherActiveWorkspacesOn(workspace);
  if (others.length > 0) {
    add("shared-cwd", `${others.length} other active workspace(s) still reference ${workspace.cwd}: ${others.map((w) => w.id).join(", ")}`);
  }

  // ── Cleanliness: would removing it destroy work? ──
  if (exists) {
    const cleanliness = checkWorktreeClean(workspace.cwd);
    if (cleanliness.error) {
      add("git-check-failed", `Could not establish whether ${workspace.cwd} is clean: ${cleanliness.error}`);
    }
    if (cleanliness.uncommittedChanges) add("uncommitted-changes", `${workspace.cwd} has uncommitted changes`);
    if (cleanliness.untrackedFiles) add("untracked-files", `${workspace.cwd} has untracked files`);
    if (cleanliness.unpushedCommits) {
      add("unpushed-commits", `${workspace.cwd} is on commits that exist on no other branch, tag or remote`);
    }
  }

  return { removable: blockers.length === 0, blockers };
}

/** Every workspace with its removability verdict attached. */
export function listWorkspacesWithRemovability(filter?: { status?: Workspace["status"] }): WorkspaceWithRemovability[] {
  return listWorkspaces(filter).map((workspace) => ({ ...workspace, removability: evaluateWorktreeRemoval(workspace) }));
}

/**
 * Interrupt a chat's session if one is running.
 *
 * `stopSession` lives in claude.ts, which drags every provider adapter in with
 * it — imported lazily, and only once we know there is something to stop, so
 * archiving a workspace with no live chats stays cheap.
 */
async function interruptChat(chatId: string): Promise<boolean> {
  if (!sessionRegistry.get(chatId)) return false;
  try {
    const { stopSession } = await import("./claude.js");
    return stopSession(chatId);
  } catch (err: any) {
    log.error(`Failed to interrupt chat ${chatId}: ${err.message}`);
    return false;
  }
}

/**
 * Archive a workspace: cascade to its chats, mark the record, then remove the
 * worktree **only** if every gate in {@link evaluateWorktreeRemoval} passes.
 *
 * Order matters. The record is marked archived before removal is evaluated so
 * the workspace being archived cannot count as a reference to its own
 * directory — archiving the last of two workspaces on one `cwd` is what makes
 * the directory removable, and archiving the first must not.
 *
 * Returns null when there is no such workspace. Idempotent: archiving an
 * already-archived workspace re-evaluates removal, which is the natural way to
 * retry after cleaning up whatever blocked it.
 */
export async function archiveWorkspace(id: string): Promise<ArchiveWorkspaceResult | null> {
  const existing = getWorkspace(id);
  if (!existing) return null;

  // 1. Cascade. Stop anything still running, then mark the chats so a later
  //    read can tell they belong to an archived workspace. Chat logs and the
  //    chat records themselves are untouched — archiving is not deleting.
  const chats: ArchiveWorkspaceResult["chats"] = [];
  const archivedAt = new Date().toISOString();
  for (const chat of chatsForWorkspace(id)) {
    const interrupted = await interruptChat(chat.id);
    chatFileService.updateChatMetadata(chat.id, { archivedAt }, { touch: false });
    chats.push({ chatId: chat.id, interrupted });
  }

  // 2. Bookkeeping.
  const workspace = markWorkspaceArchived(id) ?? existing;

  // 3. Removal, if and only if everything allows it.
  const removability = evaluateWorktreeRemoval(workspace);
  const result: ArchiveWorkspaceResult = {
    workspace,
    chats,
    worktree: { removed: false, path: workspace.cwd, blockers: removability.blockers },
  };

  if (!removability.removable) {
    if (workspace.isolation === "worktree") {
      log.info(`Kept worktree ${workspace.cwd} — ${removability.blockers.map((b) => b.code).join(", ")}`);
    }
    return result;
  }

  // `repoPath` is guaranteed by the "no-repo-path" gate above; the check keeps
  // the compiler (and any future reordering) honest.
  if (!workspace.repoPath) {
    result.worktree.blockers = [{ code: "no-repo-path", detail: `No main repo recorded for ${workspace.cwd}` }];
    return result;
  }

  const removal = removeWorktree(workspace.repoPath, workspace.cwd);
  if (removal.ok) {
    result.worktree.removed = true;
    log.info(`Removed worktree ${workspace.cwd} for archived workspace ${workspace.id}`);
  } else {
    // git's own refusal, behind ours. Reaching this means our checks passed and
    // git still said no — keep the directory and report what it said.
    result.worktree.blockers = [{ code: "git-remove-failed", detail: removal.error }];
    log.warn(`git worktree remove refused ${workspace.cwd}: ${removal.error}`);
  }
  return result;
}
