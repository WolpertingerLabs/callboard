/**
 * Directory → workspace projection. The read half of plans/workspace-object.md
 * Phase 3.
 *
 * ## What a path-only chat is
 *
 * Workspace records are only written when a chat starts in a worktree (Phase
 * 1's intent capture), so on this machine 9 of 6,780 chats carry a
 * `workspaceId` — 0.13%. The registry is not, and will not become, an
 * enumeration of "where work happens": it is also *stale in the other
 * direction*, with 6 of 9 records still `active` while their directories were
 * removed outside Callboard. Neither "list workspaces" nor "chats that have
 * one" is a usable row source.
 *
 * So the projection runs the other way. **Every directory is a workspace.**
 * One that a record claims is that record; one that no record claims is a
 * *synthesised* directory workspace — the same shape, derived from the path,
 * persisted nowhere. Reads get a uniform object without adopt-on-open writing
 * registry entries as a side effect of scrolling a sidebar.
 *
 * ## Why the row is not keyed on the chat's workspaceId
 *
 * Because grouping by `Chat.workspaceId` splits directories. `/home/cybil/
 * callboard` holds 84 chats of which exactly one has a `workspaceId`; keyed
 * that way it becomes two rows both labelled "callboard", and stays that way
 * until every historical chat is backfilled. The chat's `workspaceId` is
 * provenance. The directory is the group. Workspace-*owned* state still keys
 * on `workspaceId` — that is the whole keying rule, and it is written down in
 * `.claude/CLAUDE.md`.
 *
 * ## Why `isolation: "worktree"` is not believed on its own
 *
 * `ensureWorktreeDetailed` returns the *main checkout* when the requested
 * branch is already checked out there ("including the main one",
 * utils/git.ts). `resolveBranch` still reports a `worktree` block for that,
 * and `recordWorktreeWorkspace` still writes `isolation: "worktree"` — so a
 * record can describe the main repo as a worktree. There is one such record
 * live right now (`/home/cybil/callboard`, `repoPath` equal to `cwd`, `.git`
 * a directory). A record is therefore believed only when its `repoPath` names
 * a *different* directory, which is the record stating for itself that the
 * cwd is not the main checkout.
 */
import type { Workspace } from "shared";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { listWorkspaces, samePath } from "./workspace-store.js";
import { resolveWorktreeToMainRepoCached } from "../utils/git.js";

/** What a directory looks like once resolved through the registry. */
export interface WorkspaceView {
  /** The directory itself, exactly as the caller gave it. */
  cwd: string;
  /** Opaque record id — set only when exactly one active record claims `cwd`. */
  workspaceId?: string;
  /** Active records on `cwd`, set only when more than one. */
  workspaceCount?: number;
  isWorktree: boolean;
  /** Main checkout, set only when `isWorktree`. */
  repoPath?: string;
  /**
   * Where `isWorktree`/`repoPath` came from. `"record"` means the registry
   * answered; `"directory"` means the `.git` file did. Not on the wire — it
   * exists so tests can assert the read actually moved.
   */
  source: "record" | "directory";
}

/**
 * Active workspace records indexed by directory.
 *
 * Built once per request rather than per row: `listWorkspaces` reads the whole
 * registry directory, and the sidebar asks about ~20 folders at a time. The
 * registry's own growth (an index, rather than a directory scan) is out of
 * scope for this phase and tracked separately.
 */
export interface WorkspaceIndex {
  /** Active records whose `cwd` is this directory. Never null; may be empty. */
  recordsFor(cwd: string): Workspace[];
}

/**
 * Path keys a directory can be found under. `resolve` handles `..`/`.` and
 * relative `cwd`s on older records; the realpath is added when it differs so a
 * symlinked home matches too. Mirrors what {@link samePath} compares, but as a
 * hash key — a linear `samePath` scan per row is what this replaces.
 */
function pathKeys(path: string): string[] {
  const keys = [resolve(path)];
  try {
    const real = realpathSync(path);
    if (real !== keys[0]) keys.push(real);
  } catch {
    // Directory is gone. The resolved path is still a valid key; a record
    // pointing at a removed directory simply will not match anything on disk.
  }
  return keys;
}

export function buildWorkspaceIndex(records?: Workspace[]): WorkspaceIndex {
  const source = records ?? listWorkspaces({ status: "active" });
  const byPath = new Map<string, Workspace[]>();
  for (const workspace of source) {
    if (workspace.status !== "active") continue;
    for (const key of pathKeys(workspace.cwd)) {
      const bucket = byPath.get(key);
      if (bucket) {
        // A record can be reachable under both its resolved and its real path;
        // don't let it count twice toward `workspaceCount`.
        if (!bucket.some((w) => w.id === workspace.id)) bucket.push(workspace);
      } else {
        byPath.set(key, [workspace]);
      }
    }
  }
  return {
    recordsFor(cwd: string): Workspace[] {
      // Merged across every key, not first-match: one record may be stored
      // under a symlinked path and another under the real one, and taking
      // whichever bucket matched first would undercount them — reporting an
      // unambiguous `workspaceId` for a directory that in fact has two.
      const found: Workspace[] = [];
      for (const key of pathKeys(cwd)) {
        for (const workspace of byPath.get(key) ?? []) {
          if (!found.some((w) => w.id === workspace.id)) found.push(workspace);
        }
      }
      return found;
    },
  };
}

/**
 * Does this record assert that its `cwd` is a worktree?
 *
 * Both conditions matter. `isolation: "worktree"` alone means "a worktree was
 * *asked for*", which is true of the main checkout when the branch was
 * already checked out there. A `repoPath` naming a different directory is the
 * record saying the cwd is not the main checkout — which is the actual claim.
 */
export function recordSaysWorktree(workspace: Workspace): boolean {
  if (workspace.isolation !== "worktree") return false;
  if (!workspace.repoPath) return false;
  return !samePath(workspace.repoPath, workspace.cwd);
}

/**
 * Resolve one directory to its workspace view.
 *
 * The record wins when one claims the directory. Otherwise the `.git` file
 * answers, through the **cached** resolver: this is a display read, refreshed
 * every few seconds, and a stale answer costs a wrong badge. Deletion
 * decisions use the uncached resolver and are untouched by this module — see
 * `evaluateWorktreeRemoval`.
 */
export function viewForDirectory(cwd: string, index: WorkspaceIndex): WorkspaceView {
  const records = index.recordsFor(cwd);

  if (records.length > 0) {
    // Records share a cwd, so they agree about the directory; take the first
    // that makes the worktree claim. The *identity* is only unambiguous when
    // there is exactly one.
    const claiming = records.find(recordSaysWorktree);
    return {
      cwd,
      ...(records.length === 1 ? { workspaceId: records[0].id } : { workspaceCount: records.length }),
      isWorktree: Boolean(claiming),
      ...(claiming?.repoPath && { repoPath: claiming.repoPath }),
      source: "record",
    };
  }

  const { isWorktree, mainRepoPath } = resolveWorktreeToMainRepoCached(cwd);
  return {
    cwd,
    isWorktree,
    ...(isWorktree && { repoPath: mainRepoPath }),
    source: "directory",
  };
}
