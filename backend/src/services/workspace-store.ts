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
import { WORKSPACE_NAME_MAX } from "shared";
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

// Re-exported so callers that already read the store's limits keep working;
// the definition is in shared/types/workspace.ts because the rename control
// enforces the same bound on its input.
export { WORKSPACE_NAME_MAX };

/**
 * Characters a name may never carry.
 *
 * A workspace name is a **label on a record** and nothing else — it is not the
 * directory, the branch or the worktree path, and nothing derives a path from
 * it (see {@link renameWorkspace}). What it *is* is a string that reaches a
 * sidebar row, a modal, an MCP tool result and a log line, so the two things
 * that break those are refused at the boundary:
 *
 * - C0/C1 controls and DEL — a newline in a name splits a log line in two, and
 *   the second half reads as a log entry nothing wrote.
 * - Zero-width space and the bidi controls (LRM/RLM, the LRE…RLO embedding
 *   block, the isolates) — U+202E in a name reverses the text that follows it
 *   in the row, so a name can rewrite how its neighbours render.
 *
 * Deliberately NOT in the class: ZWJ (U+200D) and the variation selectors, so
 * emoji sequences survive intact. They are hard to type and harmless to render.
 */
const FORBIDDEN_NAME_CLASS = "[\\u0000-\\u001F\\u007F-\\u009F\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069]";
const FORBIDDEN_NAME_CHAR = new RegExp(FORBIDDEN_NAME_CLASS, "u");
const FORBIDDEN_NAME_CHARS = new RegExp(FORBIDDEN_NAME_CLASS, "gu");

/**
 * Why this name cannot be used, or null when it can. Safe to surface directly.
 *
 * Used by everything a *caller* names — the create and rename routes and their
 * MCP tools — so a bad name comes back as a refusal with a reason rather than
 * as a silently mangled record. {@link createWorkspace} itself stays lenient
 * (see {@link coerceName}): it is on the chat-start path, where a name is
 * derived rather than typed and must never be able to fail a chat.
 */
export function workspaceNameError(raw: string): string | null {
  const name = (raw ?? "").trim();
  if (!name) return "A workspace name is required";
  // Code units, matching the bound `coerceName` slices at. A name near this
  // length is already unreadable in every surface that renders it.
  if (name.length > WORKSPACE_NAME_MAX) {
    return `A workspace name is limited to ${WORKSPACE_NAME_MAX} characters (got ${name.length})`;
  }
  const found = FORBIDDEN_NAME_CHAR.exec(name);
  if (found) {
    const codePoint = found[0].codePointAt(0) ?? 0;
    return (
      `A workspace name may not contain control or text-direction characters (found U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} ` +
      `at position ${found.index}). Names are rendered in lists and written to logs.`
    );
  }
  return null;
}

/**
 * The same rules, applied instead of enforced. Never throws.
 *
 * For names Callboard derives rather than receives — the directory basename
 * default below. A filename may legally contain a newline, so the derived name
 * has to be cleaned rather than rejected: refusing here would fail the chat
 * that is being started.
 */
function coerceName(raw: string): string {
  return (raw ?? "").replace(FORBIDDEN_NAME_CHARS, "").trim().slice(0, WORKSPACE_NAME_MAX);
}

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

/**
 * Bumped on every write to the registry — see {@link workspaceRegistryVersion}.
 *
 * It lives here rather than beside the callers because `saveWorkspace` and
 * `deleteWorkspace` are the only two ways a record ever changes on disk, and
 * nothing outside this module writes `~/.callboard/workspaces/`. A counter at
 * the funnel cannot be forgotten by a future writer the way an invalidation
 * call at each route can.
 */
let _workspaceRegistryVersion = 0;

/**
 * A value that changes whenever any workspace record is created, renamed,
 * archived or deleted.
 *
 * Folder rows carry `displayName`, `workspaceId`, `workspaceCount`, `repoPath`,
 * `workspaces[]`, `directoryState` and `directoryDetail`, all of which come
 * from this registry — so a listing cache that does not watch this will happily
 * serve a renamed workspace under its old name. It is read by the folder-list
 * cache's fingerprint; see services/folder-list-cache.ts.
 *
 * Deliberately a version rather than a `clearListCaches()` call at each writer:
 * `renameWorkspace` and `archiveWorkspace` were never among the writers that
 * invalidate, and the next one added would not be either.
 */
export function workspaceRegistryVersion(): number {
  return _workspaceRegistryVersion;
}

function saveWorkspace(workspace: Workspace): void {
  const filepath = workspaceFilePath(workspace.id);
  if (!filepath) throw new Error(`Invalid workspace id: ${workspace.id}`);
  atomicWrite(filepath, JSON.stringify(workspace, null, 2));
  _workspaceRegistryVersion++;
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

  // Cleaned, not validated: this is the chat-start path (see {@link coerceName}).
  // Callers that take a name from a user or an agent validate it first with
  // {@link workspaceNameError} so a bad one is a refusal rather than a mangling.
  const name = coerceName(payload.name ?? "") || coerceName(defaultName(cwd)) || "workspace";
  const now = new Date().toISOString();
  const workspace: Workspace = {
    id: `ws-${randomUUID().slice(0, 8)}-${Date.now().toString(36)}`,
    name,
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

/**
 * Rename a workspace. **Nothing on disk moves.**
 *
 * The name is a label on the record: it is not the directory, not the branch,
 * not the worktree path, and nothing derives any of those from it. `cwd`,
 * `repoPath` and `worktree.branch` are what every path-producing caller reads —
 * the quarantine's `rename(2)`, the restore recipe, the identity token's admin
 * dir, `git -C`. The only thing a rename touches is this record's JSON, which
 * is why it needs no gate beyond the name being a usable string.
 *
 * Returns null when there is no such workspace; throws on an unusable name, so
 * a caller that mistyped one hears about it rather than storing a mangled
 * version. Archived workspaces rename too: the label is how a stale record is
 * recognised later, and that is exactly when it is worth annotating.
 */
export function renameWorkspace(id: string, name: string): Workspace | null {
  const workspace = getWorkspace(id);
  if (!workspace) return null;
  const error = workspaceNameError(name);
  if (error) throw new Error(error);
  // The outgoing name is cleaned before it reaches the log line: it may predate
  // these rules, and the log is one of the two places the rules exist to protect.
  const previous = coerceName(workspace.name);
  workspace.name = name.trim();
  saveWorkspace(workspace);
  log.info(`Renamed workspace ${id}: "${previous}" → "${workspace.name}" (record only — ${workspace.cwd} is untouched)`);
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
    _workspaceRegistryVersion++;
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
  // Degenerate case: a record whose cwd is its own repoPath, which is what
  // ensureWorktree handing back the *main* checkout used to produce. The write
  // path now records those as `local` ({@link recordMainCheckoutWorkspace}), so
  // this covers the ones already on disk — they are not migrated. The directory
  // is not a worktree of anything, so existence of the repo is all there is to
  // verify (and such a record is never `owned`).
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
 * Adopt-or-create the `local` record for a `useWorktree` resolution that landed
 * on the **main checkout** — the branch was already checked out there, so
 * `ensureWorktreeDetailed` handed back the repository itself and created
 * nothing (utils/git.ts, `isMainCheckout`).
 *
 * A worktree was asked for; none exists. Recording `isolation: "worktree"` here
 * is what produced records describing the main repo as a worktree of itself —
 * the write-path half of the defect whose read-path half is the `repoPath`
 * guard in services/workspace-views.ts. There is no worktree provenance to
 * capture (nothing was created, so `owned` would be false and `repoPath` would
 * equal `cwd`), and the honest record for "work happens in this checkout as-is"
 * is a local one.
 *
 * Only a `local` record is reused. A `worktree` record on a main checkout is
 * one of the legacy misdescribing ones, and handing it back would mean stamping
 * a new chat with a claim we have just stopped making; leaving it alone means
 * the directory carries two active records, which is a state Phase 3 already
 * models (`workspaceCount`) and which existing records are not migrated out of
 * by design.
 */
function recordMainCheckoutWorkspace(cwd: string): Workspace {
  const local = listWorkspacesByCwd(cwd).find((w) => w.isolation === "local");
  if (local) return local;
  return createWorkspace({ cwd, isolation: "local" });
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
    // The resolution says which of the two it was; nothing here re-derives it
    // from the paths.
    if (result.worktree.isMainCheckout) return recordMainCheckoutWorkspace(result.folder).id;
    return recordWorktreeWorkspace({ cwd: result.folder, ...result.worktree }).id;
  } catch (err: any) {
    log.warn(`Failed to record workspace for worktree ${result.folder}: ${err.message}`);
    return undefined;
  }
}
