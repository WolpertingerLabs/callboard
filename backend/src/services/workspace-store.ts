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
 * Phase 1 of plans/workspace-object.md is write-only groundwork. Records are
 * created when a chat starts in a worktree; nothing reads them to make a
 * decision yet, and archiving marks status ONLY — no cascade to chats, no
 * directory removal. That is Phase 2, and it is deliberately not here.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, rmSync } from "fs";
import { join, basename } from "path";
import { randomUUID } from "node:crypto";
import type { Workspace, WorkspacePayload, WorktreeMode } from "shared";
import type { ResolveBranchResult } from "../utils/git.js";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-store");

const workspacesDir = join(DATA_DIR, "workspaces");

if (!existsSync(workspacesDir)) mkdirSync(workspacesDir, { recursive: true });

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
  const cwd = (payload.cwd ?? "").trim();
  if (!cwd) throw new Error("Workspace cwd is required");
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
    ...(payload.repoPath && { repoPath: payload.repoPath }),
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
  for (const file of readdirSync(workspacesDir).filter((f) => f.endsWith(".json"))) {
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
 */
export function listWorkspacesByCwd(cwd: string): Workspace[] {
  return listWorkspaces({ status: "active" }).filter((w) => w.cwd === cwd);
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
 * workspace's chats and no directory removal, both of which are Phase 2.
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

/**
 * Adopt-or-create the workspace for a worktree Callboard just resolved.
 *
 * An existing active workspace on the same `cwd` wins outright: it already
 * holds the intent (and, critically, the `owned` flag) recorded when the
 * worktree was first made, and re-deriving that from a later reuse would
 * downgrade an owned worktree to unowned. Only when there is no record does
 * `created` decide ownership — which means a worktree that predates this
 * entity is recorded as unowned, the safe direction.
 */
export function recordWorktreeWorkspace(intent: WorktreeIntent): Workspace {
  const existing = listWorkspacesByCwd(intent.cwd)[0];
  if (existing) return existing;

  return createWorkspace({
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
