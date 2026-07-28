/**
 * Workspace store — file-backed persistence for workspaces ("where work
 * happens": path, git isolation, and the intent behind a worktree).
 *
 *   ~/.callboard/workspaces/{workspaceId}.json   Workspace
 *
 * Writes are atomic (tmp file + rename) so a partial write is never
 * observable. Same flat-file pattern as the job and card stores — no new
 * storage tech, no index: the directory is small and every query is a scan.
 *
 * This module stays a store. {@link archiveWorkspace} here marks status and
 * nothing else — the Phase 2 lifecycle (cascade to chats, cleanliness check,
 * `git worktree remove`) lives in workspace-service.ts, which composes this
 * with git and the chat store. Nothing in here deletes a directory.
 *
 * The one thing this module *does* read its own records for is revalidation:
 * a record is adopted only while it still describes the directory on disk
 * (see {@link recordWorktreeWorkspace}). Nothing is immortal — records the
 * filesystem has outgrown are archived rather than handed forward.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, rmSync, realpathSync } from "fs";
import { join, basename, resolve } from "path";
import { randomUUID } from "node:crypto";
import type { Workspace, WorkspacePayload, WorktreeMode } from "shared";
import type { ResolveBranchResult } from "../utils/git.js";
import { resolveWorktreeToMainRepo } from "../utils/git.js";
import { verifyWorktreeToken, writeWorktreeToken } from "../utils/worktree-token.js";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-store");

const workspacesDir = join(DATA_DIR, "workspaces");

// Non-fatal on purpose. This is the one mkdir in the store that actually runs
// on upgrade, and the rest of the module degrades to logged failures rather
// than throwing — a full disk must not stop the server from starting. Reads
// tolerate the missing directory; writes fail loudly to their (catching)
// callers.
try {
  if (!existsSync(workspacesDir)) mkdirSync(workspacesDir, { recursive: true });
} catch (err: any) {
  log.error(`Failed to create ${workspacesDir}: ${err.message} — workspace records will not persist`);
}

export const WORKSPACE_NAME_MAX = 200;

/**
 * Workspace ids we generate ({@link createWorkspace}). Enforced on every
 * read/write so an id arriving from a route param or a chat record can never
 * escape workspacesDir via `../` or an absolute path.
 */
const WORKSPACE_ID_RE = /^ws-[A-Za-z0-9_-]+$/;

function workspaceFilePath(id: string): string | null {
  if (!WORKSPACE_ID_RE.test(id)) return null;
  return join(workspacesDir, `${id}.json`);
}

function atomicWrite(filepath: string, content: string): void {
  const tmp = `${filepath}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, filepath);
}

function saveWorkspace(workspace: Workspace): void {
  const filepath = workspaceFilePath(workspace.id);
  if (!filepath) throw new Error(`Invalid workspace id: ${workspace.id}`);
  atomicWrite(filepath, JSON.stringify(workspace, null, 2));
}

/** Fall back to the directory name when the caller supplies no name. */
function defaultName(cwd: string): string {
  return basename(cwd) || cwd;
}

// ── CRUD ────────────────────────────────────────────────────────────

export function createWorkspace(payload: WorkspacePayload): Workspace {
  const rawCwd = (payload.cwd ?? "").trim();
  if (!rawCwd) throw new Error("Workspace cwd is required");
  // Resolve at the boundary, once. A relative `cwd` (start_chat_session passes
  // `folder` through without an absoluteness check) would otherwise be read
  // against two different bases later: `existsSync`/`checkWorktreeClean`
  // resolve it against the backend process cwd, while a `git -C <repo>` call
  // resolves it against the main checkout. The gate and the action have to name
  // the same directory, so the record stores the resolved form and everything
  // downstream reads that.
  const cwd = resolve(rawCwd);
  const repoPath = payload.repoPath ? resolve(payload.repoPath) : undefined;
  if (payload.isolation !== "local" && payload.isolation !== "worktree") {
    throw new Error(`Workspace isolation must be "local" or "worktree" (got ${JSON.stringify(payload.isolation)})`);
  }
  if (payload.isolation === "worktree" && !payload.worktree) {
    throw new Error('Workspace isolation "worktree" requires a worktree block');
  }
  // A worktree block on a local workspace would be a lie about isolation the
  // Phase 2 removal gate then reads — reject rather than silently dropping it.
  if (payload.isolation === "local" && payload.worktree) {
    throw new Error('Workspace isolation "local" cannot carry a worktree block');
  }
  if (payload.worktree && !payload.worktree.branch?.trim()) {
    throw new Error("Workspace worktree requires a branch");
  }

  const name = (payload.name ?? "").trim() || defaultName(cwd);
  const now = new Date().toISOString();
  const workspace: Workspace = {
    id: `ws-${randomUUID().slice(0, 8)}-${Date.now().toString(36)}`,
    name: name.slice(0, WORKSPACE_NAME_MAX),
    cwd,
    ...(repoPath && { repoPath }),
    isolation: payload.isolation,
    ...(payload.worktree && {
      worktree: {
        owned: payload.worktree.owned === true,
        mode: payload.worktree.mode,
        branch: payload.worktree.branch.trim(),
        ...(payload.worktree.baseBranch && { baseBranch: payload.worktree.baseBranch }),
        ...(typeof payload.worktree.prNumber === "number" && { prNumber: payload.worktree.prNumber }),
      },
    }),
    status: "active",
    createdAt: now,
  };
  saveWorkspace(workspace);
  log.info(`Created workspace ${workspace.id} (${workspace.isolation}) at ${workspace.cwd}`);
  return workspace;
}

export function getWorkspace(id: string): Workspace | null {
  const filepath = workspaceFilePath(id);
  if (!filepath || !existsSync(filepath)) return null;
  try {
    return JSON.parse(readFileSync(filepath, "utf8"));
  } catch (err: any) {
    log.error(`Failed to read workspace ${id}: ${err.message}`);
    return null;
  }
}

/**
 * All workspaces, newest first. `status` filters to active or archived;
 * omitting it returns both.
 */
export function listWorkspaces(filter?: { status?: Workspace["status"] }): Workspace[] {
  const workspaces: Workspace[] = [];
  let files: string[];
  try {
    // Only fully-written records are named `*.json` — an interrupted
    // atomicWrite leaves `*.json.tmp`, which this never picks up.
    files = readdirSync(workspacesDir).filter((f) => f.endsWith(".json"));
  } catch (err: any) {
    // The directory could not be created at import (see above) or vanished
    // underneath us. An empty registry is the honest answer, not a throw.
    log.error(`Failed to list ${workspacesDir}: ${err.message}`);
    return [];
  }
  for (const file of files) {
    try {
      const workspace: Workspace = JSON.parse(readFileSync(join(workspacesDir, file), "utf8"));
      if (filter?.status && workspace.status !== filter.status) continue;
      workspaces.push(workspace);
    } catch (err: any) {
      log.error(`Failed to read workspace ${file}: ${err.message}`);
    }
  }
  workspaces.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return workspaces;
}

/**
 * Active workspaces on a given directory, newest first.
 *
 * Multiple workspaces may share one `cwd` — that is a supported state, not a
 * bug (see plans/workspace-object.md). This is also what Phase 2's ref-count
 * will be built on: an owned worktree is only removable once no active
 * workspace references its directory.
 *
 * Compares resolved paths rather than strings. Records written before
 * {@link createWorkspace} started resolving `cwd` may hold a relative or
 * `..`-laden spelling of the same directory, and a missed match here means a
 * second record for a directory that already has one.
 */
export function listWorkspacesByCwd(cwd: string): Workspace[] {
  return listWorkspaces({ status: "active" }).filter((w) => samePath(w.cwd, cwd));
}

export function renameWorkspace(id: string, name: string): Workspace | null {
  const workspace = getWorkspace(id);
  if (!workspace) return null;
  const trimmed = (name ?? "").trim();
  if (!trimmed) throw new Error("Workspace name is required");
  workspace.name = trimmed.slice(0, WORKSPACE_NAME_MAX);
  saveWorkspace(workspace);
  return workspace;
}

/**
 * Mark a workspace archived. Status only — deliberately no cascade to the
 * workspace's chats and no directory removal. Both of those are the lifecycle
 * archive in workspace-service.ts, which calls this as its bookkeeping step.
 * Idempotent: re-archiving keeps the original `archivedAt`.
 */
export function archiveWorkspace(id: string): Workspace | null {
  const workspace = getWorkspace(id);
  if (!workspace) return null;
  if (workspace.status === "archived") return workspace;
  workspace.status = "archived";
  workspace.archivedAt = new Date().toISOString();
  saveWorkspace(workspace);
  log.info(`Archived workspace ${id}`);
  return workspace;
}

/**
 * Remove a workspace's record. Best-effort cleanup for a workspace created as
 * part of a larger operation that then failed — NOT a user-facing delete, and
 * it never touches the directory the workspace points at.
 */
export function deleteWorkspace(id: string): boolean {
  const filepath = workspaceFilePath(id);
  if (!filepath || !existsSync(filepath)) return false;
  try {
    rmSync(filepath);
    return true;
  } catch (err: any) {
    log.error(`Failed to delete workspace ${id}: ${err.message}`);
    return false;
  }
}

// ── Worktree intent capture ─────────────────────────────────────────

export interface WorktreeIntent {
  /** The worktree directory. */
  cwd: string;
  /** The main checkout the worktree belongs to. */
  repoPath: string;
  /**
   * Did Callboard create this worktree just now? The only thing that can make
   * `owned` true for a new record — a directory we merely found already
   * sitting there is not ours to remove later.
   */
  created: boolean;
  mode: WorktreeMode;
  branch: string;
  baseBranch?: string;
  prNumber?: number;
}

/** Compare two paths, tolerating `..`/`.` segments and symlinked parents. */
export function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Does this record still describe the directory that is actually on disk?
 *
 * Nothing archives workspaces on its own, so records outlive the directories
 * they point at: `git worktree remove` leaves the record `active`, and a
 * directory the user then recreates at the same path is a *different*
 * directory that the record still claims to own. Adopting across that gap is
 * how `owned: true` ends up on a worktree Callboard never made — precisely
 * what `owned` exists to prevent.
 *
 * Pure filesystem reads (no `git` subprocess), so it is cheap enough for the
 * chat-start path.
 *
 * Phase 2 adds the half the filesystem alone cannot answer. A worktree the
 * *user* recreated at the same path, on the same branch, of the same repo
 * satisfies every check below — it is byte-for-byte what the record describes.
 * An **owned** record therefore has to prove it as well, via the identity
 * token in the worktree's git admin dir, which only a worktree we created
 * carries. An unowned record has no token by definition and is unaffected:
 * it can never be adopted into ownership anyway.
 */
function worktreeRecordMatchesDisk(workspace: Workspace): boolean {
  if (!existsSync(workspace.cwd)) return false;
  if (workspace.worktree?.owned && verifyWorktreeToken(workspace.cwd, workspace.id) !== "verified") {
    return false;
  }
  // Degenerate case: ensureWorktree hands back the *main* checkout when the
  // branch is already checked out there, so cwd === repoPath and the
  // directory is not a worktree of anything. Existence of the repo is all
  // there is to verify (and such a record is never `owned`).
  if (!workspace.repoPath || samePath(workspace.repoPath, workspace.cwd)) {
    return existsSync(join(workspace.cwd, ".git"));
  }
  const resolution = resolveWorktreeToMainRepo(workspace.cwd);
  return resolution.isWorktree && samePath(resolution.mainRepoPath, workspace.repoPath);
}

/**
 * Adopt-or-create the workspace for a worktree Callboard just resolved.
 *
 * An existing active workspace on the same `cwd` wins outright: it already
 * holds the intent (and, critically, the `owned` flag) recorded when the
 * worktree was first made, and re-deriving that from a later reuse would
 * downgrade an owned worktree to unowned. Only when there is no record does
 * `created` decide ownership — which means a worktree that predates this
 * entity is recorded as unowned, the safe direction.
 *
 * Two things bound that adoption:
 *
 * - **Isolation.** Only a `worktree` record can be adopted. A `local`
 *   workspace on the same path (Phase 3's adopt-on-open will create those)
 *   describes the directory as a plain folder and holds no worktree
 *   provenance at all — adopting it would drop this resolution's `owned` on
 *   the floor rather than preserve it.
 * - **Reality.** The record must still describe the directory on disk
 *   ({@link worktreeRecordMatchesDisk}). A record that no longer does is
 *   archived, not adopted, and the directory is recorded afresh with `owned`
 *   decided by `created` as normal.
 */
export function recordWorktreeWorkspace(intent: WorktreeIntent): Workspace {
  const candidates = listWorkspacesByCwd(intent.cwd).filter((w) => w.isolation === "worktree");
  const live = candidates.find(worktreeRecordMatchesDisk);
  if (live) return live;

  // Nothing active on this path still describes reality. Archive the stale
  // records first: leaving them active would leave Phase 2's ref-count (and
  // its removal gate) reading provenance for a directory that no longer
  // exists, or for one that somebody else put there.
  for (const stale of candidates) {
    log.info(`Archiving stale workspace ${stale.id} — ${stale.cwd} no longer matches its record`);
    archiveWorkspace(stale.id);
  }

  const workspace = createWorkspace({
    cwd: intent.cwd,
    repoPath: intent.repoPath,
    isolation: "worktree",
    worktree: {
      owned: intent.created,
      mode: intent.mode,
      branch: intent.branch,
      ...(intent.baseBranch && { baseBranch: intent.baseBranch }),
      ...(typeof intent.prNumber === "number" && { prNumber: intent.prNumber }),
    },
  });

  // ── One of exactly two places that can write `owned: true`. ──
  // Here it means "this call ran git worktree add" (`intent.created`). The
  // other is adoptWorktrees() in workspace-adoption.ts, where it means "a
  // caller named this exact path". Nothing else may produce that value: the
  // whole Phase 2 removal gate is built on it, and a third writer — an
  // inference, a pattern match, a backfill — would quietly redefine what it
  // guarantees.

  // Stamp the worktree we just made with this record's id. Only for one we
  // created: the token is the claim "Callboard made this directory", and
  // writing it over a directory we merely found would be a lie of exactly the
  // kind `owned` exists to prevent.
  //
  // A failed write is not an error. The record keeps `owned: true` (it is
  // true), and the missing token simply makes the worktree unremovable — the
  // safe direction, and the same state every pre-Phase-2 record is in.
  if (intent.created && !writeWorktreeToken(intent.cwd, workspace.id)) {
    log.warn(`Workspace ${workspace.id} has no identity token — its worktree will never be removed automatically`);
  }

  return workspace;
}

/**
 * The single write path from branch resolution to a workspace record — both
 * chat-start entry points (the /new/message route and the start_chat_session
 * tool) go through this and nothing else writes worktree provenance.
 *
 * Returns the workspace id to stamp on the new chat, or undefined when the
 * resolution produced no worktree. Never throws: a workspace is bookkeeping,
 * and Phase 1 reads nothing from it, so failing to record one must not fail
 * the chat the user actually asked for.
 */
export function captureWorktreeWorkspace(result: ResolveBranchResult): string | undefined {
  if (!result.ok || !result.worktree) return undefined;
  try {
    return recordWorktreeWorkspace({ cwd: result.folder, ...result.worktree }).id;
  } catch (err: any) {
    log.warn(`Failed to record workspace for worktree ${result.folder}: ${err.message}`);
    return undefined;
  }
}
