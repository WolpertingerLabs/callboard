/**
 * Workspace lifecycle — the phase that actually stops using a directory.
 *
 * workspace-store.ts persists records; this composes that store with git and
 * the chat store to answer one question and act on it: may this worktree be
 * removed, and if not, why not?
 *
 * **Removal is quarantine, not deletion.** The directory is moved into
 * `~/.callboard/trash/` and unregistered with `git worktree prune`; nothing is
 * deleted until the retention sweep in utils/worktree-trash.ts, and the whole
 * move is one `rename(2)`. That is what makes the ignored-file problem go away
 * rather than needing an (unsatisfiable) policy — see that file for the
 * measurement that killed the policy version.
 *
 * Every gate is a refusal, and they are all AND-ed:
 *
 *   isolation === "worktree"        a folder the user pointed us at is never touched
 *   worktree.owned === true         we only remove what we created
 *   identity token verifies         ...and can still prove it (utils/worktree-token.ts)
 *   still a worktree of repoPath    the record still describes what is on disk
 *   no submodules                   prune would destroy their object databases
 *   no other active workspace       the ref-count: the last reference removes it
 *   no live session in the cwd      nothing may be moved out from under a subprocess
 *   clean                           no uncommitted changes, no untracked files,
 *                                   no commits that exist nowhere else
 *
 * Anything unresolvable — a git command that failed, a directory that vanished
 * mid-check — is a refusal too. There is no branch in this file that removes a
 * directory on a "probably fine", and no `--force` anywhere in the path.
 *
 * The same principle runs the other way for the registry itself:
 * {@link describeWorkspaceDirectory} observes that a record's directory is gone
 * and says so. It does not archive it. Records are only ever archived when
 * somebody asks.
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
  WorkspaceDirectory,
  WorkspaceIgnoredPreview,
  WorkspaceRemovability,
  WorkspaceRemovalReason,
  WorkspaceWithRemovability,
  WorktreeInspection,
} from "shared/types/index.js";
import type { WorktreeCleanliness } from "../utils/git.js";
import {
  checkWorktreeClean,
  isRegisteredWorktree,
  listIgnoredEntries,
  pruneWorktrees,
  resolveCommit,
  resolveWorktreeToMainRepo,
  worktreeContainsSubmodules,
} from "../utils/git.js";
import { clearDiskUsageCache, newDiskUsageBudget, type DiskUsageBudget } from "../utils/disk-usage.js";
import { readWorktreeToken, verifyWorktreeToken } from "../utils/worktree-token.js";
import { quarantineDirectory, sweepTrash } from "../utils/worktree-trash.js";
import { chatFileService } from "./chat-file-service.js";
import { sessionRegistry } from "./session-registry.js";
import { archiveWorkspace as markWorkspaceArchived, getWorkspace, listWorkspaces } from "./workspace-store.js";
// Phase 3's predicate, imported rather than restated: "does this record claim
// its cwd is a worktree?" must have exactly one definition, or the badge in the
// sidebar and the state in the workspace list can disagree about the same
// record. workspace-views reads the registry and git and nothing else, so this
// is a leaf dependency, not a cycle.
import { recordSaysWorktree } from "./workspace-views.js";
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

/** True when `child` is `parent` or sits underneath it. */
function isWithin(parent: string, child: string): boolean {
  if (samePath(parent, child)) return true;
  const p = resolve(parent);
  const c = resolve(child);
  return c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

// ── Evaluation context ──────────────────────────────────────────────
//
// Everything an evaluation needs that does NOT vary per workspace. Hoisted
// because it used to: `listWorkspacesWithRemovability` called `listWorkspaces()`
// once per workspace, so N records meant N directory scans and N² JSON parses —
// at N=44, roughly 1,900 parses on a synchronous route.

interface RemovalContext {
  /** Every active workspace, read once. The ref-count is a filter over this. */
  activeWorkspaces: Workspace[];
  /** Cleanliness memoised per resolved cwd; workspaces may share a directory. */
  cleanliness: Map<string, WorktreeCleanliness>;
  /** Directories that a live agent session is running in. Lazy — usually empty. */
  liveSessionFolders: string[] | null;
  /** Chats per workspace id, from one pass over the chat store. Lazy. */
  chatCounts: Map<string, number> | null;
}

function newRemovalContext(): RemovalContext {
  return { activeWorkspaces: listWorkspaces({ status: "active" }), cleanliness: new Map(), liveSessionFolders: null, chatCounts: null };
}

/**
 * How many chats each workspace owns, from a single pass over the chat store.
 *
 * Per-workspace {@link chatsForWorkspace} reads every chat, so a listing that
 * called it per record would be quadratic. Counted here rather than left to the
 * UI because the archive confirmation has to state the number — an archive
 * interrupts and stamps every linked chat, and a confirmation that omits that
 * is describing a different action than the one the button performs.
 */
function chatCounts(ctx: RemovalContext): Map<string, number> {
  if (ctx.chatCounts) return ctx.chatCounts;
  const counts = new Map<string, number>();
  for (const chat of chatFileService.getAllChats()) {
    if (chat.workspaceId) counts.set(chat.workspaceId, (counts.get(chat.workspaceId) ?? 0) + 1);
  }
  ctx.chatCounts = counts;
  return counts;
}

/**
 * Working directories of every session the registry currently knows about.
 *
 * Resolved from the chat record rather than the registry, which stores no path.
 * A tracking id with no chat file yet (a brand-new chat, mid-start) contributes
 * nothing — it has no recorded folder to compare against.
 */
function liveSessionFolders(ctx: RemovalContext): string[] {
  if (ctx.liveSessionFolders) return ctx.liveSessionFolders;
  const folders: string[] = [];
  for (const chatId of Object.keys(sessionRegistry.getAll())) {
    const folder = chatFileService.getChat(chatId)?.folder;
    if (folder) folders.push(folder);
  }
  ctx.liveSessionFolders = folders;
  return folders;
}

function cleanlinessFor(ctx: RemovalContext, cwd: string): WorktreeCleanliness {
  const cached = ctx.cleanliness.get(cwd);
  if (cached) return cached;
  const result = checkWorktreeClean(cwd);
  ctx.cleanliness.set(cwd, result);
  return result;
}

/**
 * Other *active* workspaces on the same directory — the reference count.
 *
 * Deliberately not workspace-store's `listWorkspacesByCwd`: here a missed match
 * means removing a directory another workspace is still working in, so the
 * comparison resolves paths — strictly more matches, never fewer.
 */
function otherActiveWorkspacesOn(ctx: RemovalContext, workspace: Workspace, cwd: string): Workspace[] {
  return ctx.activeWorkspaces.filter((other) => other.id !== workspace.id && samePath(other.cwd, cwd));
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
 *
 * `ctx` is an optimisation only: passing one shared across a listing changes no
 * verdict, it just stops each workspace re-reading the whole registry.
 */
export function evaluateWorktreeRemoval(workspace: Workspace, ctx: RemovalContext = newRemovalContext()): WorkspaceRemovability {
  const blockers: WorkspaceRemovalReason[] = [];
  const add = (code: WorkspaceRemovalReason["code"], detail: string) => blockers.push({ code, detail });

  // Resolved once, here, and used by every check below and by the quarantine
  // that follows. A relative `cwd` on an older record otherwise means the gate
  // and the action name different directories.
  const cwd = resolve(workspace.cwd);

  // ── Identity: is this even a thing we may remove? ──
  if (workspace.isolation !== "worktree" || !workspace.worktree) {
    add("not-a-worktree", `${cwd} is a local directory, not a worktree Callboard created`);
    return { removable: false, blockers };
  }
  if (!workspace.worktree.owned) {
    add("not-owned", `Callboard did not create ${cwd} — it was found on disk, so it is not ours to remove`);
  }
  if (!workspace.repoPath) {
    add("no-repo-path", `No main repo recorded for ${cwd}`);
  }

  // ── Reality: does the record still describe what is on disk? ──
  const exists = existsSync(cwd);
  if (!exists) {
    add("cwd-missing", `${cwd} no longer exists`);
  } else {
    // Uncached: a cached resolution can be up to five minutes stale, and a
    // worktree removed and recreated inside that window would resolve to the
    // wrong admin dir — the exact case the token exists to catch.
    const resolution = resolveWorktreeToMainRepo(cwd);
    if (!resolution.isWorktree) {
      add("not-a-worktree-on-disk", `${cwd} is no longer a git worktree`);
    } else if (workspace.repoPath && !samePath(resolution.mainRepoPath, workspace.repoPath)) {
      add("not-a-worktree-on-disk", `${cwd} is a worktree of ${resolution.mainRepoPath}, not of the recorded ${workspace.repoPath}`);
    } else {
      switch (verifyWorktreeToken(cwd, workspace.id)) {
        case "verified":
          break;
        case "missing":
          add(
            "token-missing",
            `${cwd} carries no Callboard identity token. Either it predates worktree lifecycle tracking, or it was ` +
              `recreated outside Callboard — in both cases it is not ours to remove.`,
          );
          break;
        case "mismatch":
          add("token-mismatch", `${cwd} carries an identity token for a different workspace`);
          break;
        case "unresolvable":
          add("not-a-worktree-on-disk", `Could not resolve a git admin directory for ${cwd}`);
          break;
      }
    }

    // Submodules. `mv` is indifferent to them, but the `git worktree prune`
    // that follows deletes the admin dir, and a submodule initialised in a
    // worktree keeps its object database there — quarantine would preserve the
    // submodule's files and destroy its history.
    if (worktreeContainsSubmodules(cwd, resolution.adminDir)) {
      add(
        "has-submodules",
        `${cwd} involves git submodules. Quarantining it would move the files but the follow-up "git worktree prune" deletes the ` +
          `worktree's admin directory, where a submodule initialised here keeps its object database — its history would not survive. ` +
          `(git worktree remove refuses on submodules outright for related reasons.) Remove this one by hand.`,
      );
    }
  }

  // ── Reference count: is anyone still using it? ──
  const others = otherActiveWorkspacesOn(ctx, workspace, cwd);
  if (others.length > 0) {
    add("shared-cwd", `${others.length} other active workspace(s) still reference ${cwd}: ${others.map((w) => w.id).join(", ")}`);
  }

  // ── Live sessions: is something writing in there right now? ──
  // Chats linked to *this* workspace are stopped by the archive itself; this
  // catches everything else, including chats that predate workspace linkage and
  // CLI sessions the server does not own.
  const running = liveSessionFolders(ctx).filter((folder) => isWithin(cwd, folder));
  if (running.length > 0) {
    add("session-still-running", `${running.length} agent session(s) are running in ${cwd} — stop them before archiving`);
  }

  // ── Cleanliness: would removing it destroy work? ──
  if (exists) {
    const cleanliness = cleanlinessFor(ctx, cwd);
    if (cleanliness.error) {
      add("git-check-failed", `Could not establish whether ${cwd} is clean: ${cleanliness.error}`);
    }
    if (cleanliness.uncommittedChanges) add("uncommitted-changes", `${cwd} has uncommitted changes`);
    if (cleanliness.untrackedFiles) add("untracked-files", `${cwd} has untracked files`);
    if (cleanliness.unpushedCommits) {
      add("unpushed-commits", `${cwd} is on commits that exist on no other branch, tag or remote`);
    }
  }

  const removable = blockers.length === 0;
  // The ignored-file preview costs a git subprocess (~35ms on a JS repo), so it
  // is computed only where it means something: a workspace that is staying put
  // has nothing about to move into the trash.
  return removable ? { removable, blockers, ignored: listIgnoredEntries(cwd) } : { removable, blockers };
}

/**
 * What the record's directory looks like right now — observed, not stored.
 *
 * Records outlive their directories: nothing sweeps them, so a worktree removed
 * outside Callboard leaves an `active` record pointing at nothing (7 of 10 on
 * the author's machine). This is how that becomes visible, and it is
 * deliberately *only* visible:
 *
 * > **A missing directory is evidence, not proof.** An unmounted volume looks
 * > exactly like a deleted worktree. Nothing in this file archives, prunes or
 * > deletes on the strength of a failed `stat` — the state is reported so a UI
 * > can offer the archive, which is the same offer-don't-act rule adoption
 * > follows. `git worktree prune`, in particular, is repo-global and would
 * > happily unregister worktrees whose volumes are merely absent; it is never
 * > run from here (only from the archive path, after a directory has already
 * > been moved into the trash).
 *
 * Pure filesystem reads — `existsSync` plus, at most, parsing one `.git` file.
 * No `git` subprocess, so a listing pays effectively nothing for it.
 */
export function describeWorkspaceDirectory(workspace: Workspace): WorkspaceDirectory {
  const cwd = resolve(workspace.cwd);

  if (!existsSync(cwd)) {
    return {
      state: "missing",
      detail:
        `${cwd} does not exist. Callboard has not touched it: a directory that is absent is not proof that the work is gone — an ` +
        `unmounted volume looks the same from here. Archive this workspace explicitly if the worktree really was removed.`,
    };
  }

  // Only a record that actually claims its cwd is a worktree has a claim to
  // check. `recordSaysWorktree` is that one definition (isolation *and* a
  // repoPath naming a different directory); a local record, or a legacy one
  // whose repoPath is its own cwd, is simply present when it exists.
  if (!recordSaysWorktree(workspace)) {
    return { state: "present", detail: `${cwd} exists` };
  }

  // Uncached, like the removal gate: a five-minute-old answer about whether a
  // directory is still a worktree is not an observation.
  const resolution = resolveWorktreeToMainRepo(cwd);
  if (!resolution.isWorktree) {
    return {
      state: "not-a-worktree",
      detail:
        `${cwd} exists but is no longer a git worktree — it may have been pruned, or replaced by a plain directory. Its contents are ` +
        `untouched and Callboard will not remove it (the not-a-worktree-on-disk gate blocks that); the record is what is out of date.`,
    };
  }
  if (workspace.repoPath && !samePath(resolution.mainRepoPath, workspace.repoPath)) {
    return {
      state: "not-a-worktree",
      detail: `${cwd} is a worktree of ${resolution.mainRepoPath}, not of the recorded ${workspace.repoPath} — the record describes a different directory than the one on disk`,
    };
  }
  return { state: "present", detail: `${cwd} is still a worktree of ${workspace.repoPath}` };
}

/**
 * Every workspace with its removability verdict and the observed state of its
 * directory. Both are read-only: listing workspaces writes nothing, archives
 * nothing and removes nothing, however stale a record turns out to be.
 */
export function listWorkspacesWithRemovability(
  filter?: { status?: Workspace["status"] },
  /**
   * Disk usage is opt-in for the same reason it is on discovery: `du -sk` over
   * a worktree with a cold `node_modules` is seconds, and a caller that only
   * wants the removal verdict should not pay for it. Measurements are memoised
   * for five minutes, so a management view that re-polls costs nothing.
   */
  opts?: {
    includeDiskUsage?: boolean;
    /**
     * The listing's `du` budget. A caller passes one in when it wants to read
     * {@link DiskUsageBudget.note} afterwards; when it does not, one is created
     * here anyway — `execFileSync` blocks the event loop, so there must be no
     * path through this function that measures N directories unbounded.
     */
    budget?: DiskUsageBudget;
  },
): WorkspaceWithRemovability[] {
  const ctx = newRemovalContext();
  const budget = opts?.includeDiskUsage ? (opts.budget ?? newDiskUsageBudget()) : undefined;
  return listWorkspaces(filter).map((workspace) => {
    const directory = describeWorkspaceDirectory(workspace);
    return {
      ...workspace,
      removability: evaluateWorktreeRemoval(workspace, ctx),
      directory,
      chatCount: chatCounts(ctx).get(workspace.id) ?? 0,
      // Nothing to measure when the directory is gone — and `du` on a missing
      // path returns an error string, which reads as a failure rather than as
      // the "there is nothing here" that `directory.state` already says.
      ...(budget && directory.state !== "missing" && { diskUsage: budget.measure(workspace.cwd) }),
    };
  });
}

/**
 * Interrupt a chat's session if one is running, and wait for it to be over.
 *
 * The waiting is the point. `stopSession` is fire-and-forget — it aborts, fires
 * `closeQuery()` un-awaited and returns — so an archive that only awaited that
 * could move a directory while the agent subprocess was still alive inside it,
 * mid-tool-call. That is the most realistic way to end up with a half-removed
 * worktree.
 *
 * `stopSession` lives in claude.ts, which drags every provider adapter in with
 * it — imported lazily, and only once we know there is something to stop, so
 * archiving a workspace with no live chats stays cheap.
 */
async function interruptChat(chatId: string): Promise<"not-running" | "stopped" | "unstoppable" | "timeout"> {
  if (!sessionRegistry.get(chatId)) return "not-running";
  try {
    const { stopSessionAndWait } = await import("./claude.js");
    return await stopSessionAndWait(chatId);
  } catch (err: any) {
    log.error(`Failed to interrupt chat ${chatId}: ${err.message}`);
    // An interruption we could not even attempt is not an interruption.
    return "timeout";
  }
}

/** What the directory and git's bookkeeping look like right now. */
function inspectWorktree(cwd: string, repoPath?: string): WorktreeInspection {
  const cwdExists = existsSync(cwd);
  let adminDirExists = false;
  try {
    const resolution = resolveWorktreeToMainRepo(cwd);
    adminDirExists = Boolean(resolution.isWorktree && resolution.adminDir && existsSync(resolution.adminDir));
  } catch {
    adminDirExists = false;
  }
  let registeredWorktree = false;
  if (repoPath) {
    try {
      registeredWorktree = isRegisteredWorktree(repoPath, cwd);
    } catch {
      registeredWorktree = false;
    }
  }
  let tokenPresent = false;
  try {
    tokenPresent = readWorktreeToken(cwd) !== null;
  } catch {
    tokenPresent = false;
  }
  return { cwdExists, registeredWorktree, adminDirExists, tokenPresent };
}

/**
 * Was the worktree left half-removed?
 *
 * An untouched worktree is: directory present, still registered, admin dir
 * present. Anything else after a failed attempt is a partial state and has to
 * be reported as one — the previous implementation reported git's partial
 * destruction (tracked files deleted, admin dir deleted, worktree unregistered,
 * exit code non-zero) as "the directory was kept", which left the record
 * permanently unfixable.
 */
function isPartialState(state: WorktreeInspection): boolean {
  return !(state.cwdExists && state.registeredWorktree && state.adminDirExists);
}

/**
 * Archive a workspace: cascade to its chats, mark the record, then quarantine
 * the worktree **only** if every gate in {@link evaluateWorktreeRemoval} passes.
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

  // 1. Cascade. Stop anything still running — and *wait* for it, because step 3
  //    may move the directory those sessions are working in. Then mark the
  //    chats so a later read can tell they belong to an archived workspace.
  //    Chat logs and the chat records themselves are untouched: archiving is
  //    not deleting.
  const chats: ArchiveWorkspaceResult["chats"] = [];
  const unstopped: string[] = [];
  const archivedAt = new Date().toISOString();
  for (const chat of chatsForWorkspace(id)) {
    const outcome = await interruptChat(chat.id);
    if (outcome === "timeout" || outcome === "unstoppable") unstopped.push(`${chat.id} (${outcome})`);
    chatFileService.updateChatMetadata(chat.id, { archivedAt }, { touch: false });
    chats.push({ chatId: chat.id, interrupted: outcome === "stopped" });
  }

  // 2. Bookkeeping.
  const workspace = markWorkspaceArchived(id) ?? existing;
  const cwd = resolve(workspace.cwd);

  // 3. Removal, if and only if everything allows it.
  const removability = evaluateWorktreeRemoval(workspace);
  const blockers = [...removability.blockers];
  if (unstopped.length > 0) {
    // A session we could not confirm dead is a refusal in its own right. A
    // `timeout` leaves the registry entry in place, so the evaluation above
    // would have caught it too; an `unstoppable` CLI session in a chat linked to
    // this workspace is caught here. Either way the archive must not act on a
    // directory a subprocess may still be inside.
    blockers.push({
      code: "session-still-running",
      detail: `Could not confirm these sessions stopped: ${unstopped.join(", ")}. Refusing to touch ${cwd} while one may still be writing in it.`,
    });
  }

  const result: ArchiveWorkspaceResult = {
    workspace,
    chats,
    worktree: { removed: false, disposition: "kept", path: cwd, blockers },
  };

  if (blockers.length > 0) {
    if (workspace.isolation === "worktree") {
      log.info(`Kept worktree ${cwd} — ${blockers.map((b) => b.code).join(", ")}`);
    }
    return result;
  }

  // `repoPath` is guaranteed by the "no-repo-path" gate above; the check keeps
  // the compiler (and any future reordering) honest.
  if (!workspace.repoPath) {
    result.worktree.blockers = [{ code: "no-repo-path", detail: `No main repo recorded for ${cwd}` }];
    return result;
  }
  const repoPath = resolve(workspace.repoPath);

  // What is about to travel into the trash with the tracked files. Captured
  // before the move, while the directory is still there to ask about.
  const ignored: WorkspaceIgnoredPreview | undefined = removability.ignored;

  // The commit, read while the checkout is still there to ask. Restoring by
  // branch name alone is how a restore can come back at a different commit and
  // still report success — see TrashManifest.headSha.
  const headSha = resolveCommit(cwd, "HEAD");
  if (!headSha) {
    log.warn(`Could not resolve HEAD for ${cwd} before quarantine — its trash entry will have to be restored by branch name`);
  }

  const quarantine = quarantineDirectory(cwd, {
    entryPrefix: workspace.id,
    manifest: { workspaceId: workspace.id, originalPath: cwd, repoPath, branch: workspace.worktree?.branch, ...(headSha && { headSha }) },
  });

  if (!quarantine.ok) {
    // Nothing moved — `renameSync` either succeeds or throws, and there is no
    // copy fallback. Re-inspect anyway rather than asserting it: "we believe
    // nothing happened" is exactly the claim that was wrong before.
    const state = inspectWorktree(cwd, repoPath);
    const partial = isPartialState(state);
    result.worktree.disposition = partial ? "partial" : "kept";
    if (partial) result.worktree.state = state;
    result.worktree.blockers = [
      {
        code: quarantine.code === "cross-device" ? "quarantine-cross-device" : "quarantine-failed",
        detail: quarantine.error,
      },
    ];
    log[partial ? "error" : "warn"](`Quarantine of ${cwd} failed (${quarantine.code}): ${quarantine.error}`);
    return result;
  }

  // Unregister the worktree and drop its admin dir (taking the identity token
  // with it). The directory is already safe in the trash, so a prune failure
  // does not undo the quarantine — but it does leave git's bookkeeping stale,
  // which is a partial state and gets reported as one.
  const pruned = pruneWorktrees(repoPath);
  result.worktree.removed = true;
  result.worktree.trashPath = quarantine.trashPath;
  result.worktree.ignored = ignored;

  const state = inspectWorktree(cwd, repoPath);
  if (!pruned.ok || state.cwdExists || state.registeredWorktree) {
    result.worktree.disposition = "partial";
    result.worktree.state = state;
    result.worktree.blockers = [
      {
        code: "quarantine-failed",
        detail:
          `${cwd} was quarantined to ${quarantine.trashPath}, but the directory is not fully detached from git afterwards` +
          (pruned.ok ? "" : `: git worktree prune failed: ${pruned.error}`) +
          `. The moved directory is intact; git's registration may need "git -C ${repoPath} worktree prune" by hand.`,
      },
    ];
    log.error(`Partial quarantine of ${cwd}: ${JSON.stringify(state)}`);
    return result;
  }

  result.worktree.disposition = "quarantined";
  log.info(`Quarantined worktree ${cwd} → ${quarantine.trashPath} for archived workspace ${workspace.id}`);

  // The directory just moved, so every memoised `du` for it — and for anything
  // the sweep is about to delete — now describes a path that is not there. Five
  // minutes of a sidebar showing a size against a gone directory is exactly the
  // stale reading this cache's TTL was never meant to cover.
  clearDiskUsageCache();

  // Age-out anything that has been in the trash past the retention window.
  // Here rather than only at startup so a long-running server keeps the trash
  // bounded, and after the move so a failure to sweep can never affect it.
  //
  // **This deletes, and it deletes entries this archive knows nothing about.**
  // Every past-retention entry goes, including ones belonging to other
  // workspaces the user may have been about to restore. It is therefore
  // reported rather than only logged: a click whose confirmation says "nothing
  // is deleted" must not be the click that silently emptied someone's trash.
  try {
    const swept = sweepTrash();
    if (swept.removed.length > 0) log.info(`Trash sweep removed ${swept.removed.length} expired entr(ies)`);
    for (const error of swept.errors) log.warn(`Trash sweep: ${error}`);
    if (swept.removed.length > 0 || swept.errors.length > 0) {
      result.trashSweep = { removed: swept.removed, ...(swept.errors.length > 0 && { errors: swept.errors }) };
    }
  } catch (err: any) {
    log.warn(`Trash sweep failed: ${err.message}`);
    result.trashSweep = { removed: [], errors: [err.message] };
  }

  return result;
}
