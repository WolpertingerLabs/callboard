/**
 * Workspace routes — the minimum surface that makes the worktree lifecycle
 * reachable.
 *
 * Phase 2: see the workspaces (with the removability verdict for each, so a
 * refusal is legible) and archive one.
 *
 * Phase 2b: see the worktrees that have *no* record (read-only), and adopt
 * named ones. The split between those two is the whole safety property —
 * `GET /unmanaged` offers candidates and never writes; `POST /adopt` acts, and
 * only on paths the caller wrote down. There is no endpoint that discovers and
 * adopts in one call, and adding one would put a naming heuristic in charge of
 * `owned`.
 *
 * Deliberately still not here: create, rename, delete.
 *
 * @see plans/workspace-object.md — Phases 2 and 2b
 */
import { Router } from "express";
import { adoptWorktrees } from "../services/workspace-adoption.js";
import { listUnmanagedWorktrees } from "../services/workspace-discovery.js";
import { archiveWorkspace, listWorkspacesWithRemovability } from "../services/workspace-service.js";
import { getWorkspace } from "../services/workspace-store.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspaces-route");

export const workspacesRouter = Router();

/**
 * Adoption is synchronous and runs several git subprocesses per path, so a
 * request is bounded rather than left to hold the event loop indefinitely. A
 * rejection over the limit is explicit (400, with the count) — never a silent
 * truncation that would report success for paths it never looked at.
 */
const ADOPT_PATH_LIMIT = 100;

// List workspaces, each with why its worktree may or may not be removed
workspacesRouter.get("/", (req, res) => {
  // #swagger.tags = ['Workspaces']
  // #swagger.summary = 'List workspaces'
  // #swagger.description = 'List workspaces with a removability verdict for each — whether its worktree can be removed, and every reason it cannot — plus `directory`, the freshly observed state of the path: present, missing, or not-a-worktree. Read-only: a record pointing at a directory that no longer exists is reported, never archived (an absent directory is evidence, not proof — an unmounted volume looks the same).'
  /* #swagger.parameters['status'] = { in: 'query', type: 'string', description: 'Filter by status - active or archived. Omit for both.' } */
  /* #swagger.responses[200] = { description: "Workspaces with removability" } */
  /* #swagger.responses[400] = { description: "Invalid status filter" } */
  try {
    const status = req.query.status as "active" | "archived" | undefined;
    if (status && status !== "active" && status !== "archived") {
      return res.status(400).json({ error: 'status must be "active" or "archived"' });
    }
    res.json({ workspaces: listWorkspacesWithRemovability(status ? { status } : undefined) });
  } catch (err: any) {
    log.error(`Error listing workspaces: ${err.message}`);
    res.status(500).json({ error: "Failed to list workspaces", details: err.message });
  }
});

// Archive a workspace: cascade to its chats, then quarantine the worktree if —
// and only if — it is owned, token-verified, unreferenced, idle and clean.
workspacesRouter.post("/:id/archive", async (req, res) => {
  // #swagger.tags = ['Workspaces']
  // #swagger.summary = 'Archive a workspace'
  // #swagger.description = 'Interrupt and archive the chats of the workspace, mark the workspace archived, and quarantine its git worktree only when Callboard created it, its identity token verifies, no other active workspace shares the directory, no session is running in it, it has no submodules, and it is clean (no uncommitted changes, no untracked files, no commits that exist nowhere else). Quarantine moves the directory to ~/.callboard/trash (ignored files included, nothing deleted) and prunes the worktree registration; restore with "git worktree add <path> <branch>" plus copying back untracked files. A worktree is never force-removed; refusals are returned as blockers.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Workspace ID' } */
  /* #swagger.responses[200] = { description: "Archive result, including whether the worktree was removed and why not" } */
  /* #swagger.responses[404] = { description: "Workspace not found" } */
  try {
    if (!getWorkspace(req.params.id)) {
      return res.status(404).json({ error: "Workspace not found" });
    }
    const result = await archiveWorkspace(req.params.id);
    if (!result) return res.status(404).json({ error: "Workspace not found" });
    res.json(result);
  } catch (err: any) {
    log.error(`Error archiving workspace ${req.params.id}: ${err.message}`);
    res.status(500).json({ error: "Failed to archive workspace", details: err.message });
  }
});

// ── Adoption (Phase 2b) ─────────────────────────────────────────────

// Read-only: which worktrees of a repo have no workspace record. Creates
// nothing. The `naming` field on each entry is a labelled guess, for a human
// to read — it is not what adoption acts on.
workspacesRouter.get("/unmanaged", (req, res) => {
  // #swagger.tags = ['Workspaces']
  // #swagger.summary = 'List worktrees with no workspace record'
  // #swagger.description = 'Read-only discovery of adoption candidates: every git worktree of the repository that Callboard has no active workspace record for. Creates no records and writes nothing. Each entry reports branch, disk usage, cleanliness (the same check that gates removal), the gitignored entries that would be quarantined if it were ever archived, whether adoption would be refused and why, and a `naming` HEURISTIC — whether the path looks like one of Callboard\'s worktree naming conventions. That heuristic is a guess about the past (Callboard has used more than one convention) and is presentation only: adoption never reads it.'
  /* #swagger.parameters['repoPath'] = { in: 'query', required: true, type: 'string', description: 'The repository — its main checkout, or any worktree of it.' } */
  /* #swagger.parameters['includeDiskUsage'] = { in: 'query', type: 'string', description: 'Pass the string false to skip measuring disk usage, which is the slow part. Anything else measures it.' } */
  /* #swagger.responses[200] = { description: "Unmanaged worktrees" } */
  /* #swagger.responses[400] = { description: "Missing repoPath" } */
  try {
    const repoPath = typeof req.query.repoPath === "string" ? req.query.repoPath.trim() : "";
    if (!repoPath) return res.status(400).json({ error: "repoPath is required" });
    const includeDiskUsage = req.query.includeDiskUsage !== "false";
    res.json(listUnmanagedWorktrees(repoPath, { includeDiskUsage }));
  } catch (err: any) {
    log.error(`Error listing unmanaged worktrees: ${err.message}`);
    res.status(500).json({ error: "Failed to list unmanaged worktrees", details: err.message });
  }
});

// Adopt the named worktrees. Deletes nothing, quarantines nothing: it writes an
// identity token and creates an `owned: true` record, and that is all. There is
// deliberately no "adopt everything" — the caller names paths.
workspacesRouter.post("/adopt", (req, res) => {
  // #swagger.tags = ['Workspaces']
  // #swagger.summary = 'Adopt named worktrees'
  // #swagger.description = 'Bring specific, caller-named git worktrees under Callboard management: write the identity token into each one\'s git admin directory and create an owned workspace record with the branch and repository git reports. Deletes nothing and quarantines nothing — removal stays a separate action behind every existing gate, and a dirty worktree is adopted happily (it just remains unremovable, which the returned `removability` shows). Refuses a path that is not a registered worktree of its repository, the main checkout, one that already has an active record, one with a detached HEAD, and one whose git admin directory cannot be resolved (no token could be written there, so the record could never be acted on). No record is ever kept without a verified token. Adopting the same path twice refuses the second time with `already-managed`.'
  /* #swagger.parameters['body'] = { in: 'body', required: true, schema: { paths: ['/abs/path/to/worktree'] } } */
  /* #swagger.responses[200] = { description: "Per-path outcomes: the record created, or the refusal" } */
  /* #swagger.responses[400] = { description: "Invalid or missing paths" } */
  try {
    const paths = req.body?.paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: "paths must be a non-empty array of worktree paths" });
    }
    if (paths.some((p: unknown) => typeof p !== "string" || !p.trim())) {
      return res.status(400).json({ error: "every entry in paths must be a non-empty string" });
    }
    if (paths.length > ADOPT_PATH_LIMIT) {
      return res.status(400).json({ error: `paths is limited to ${ADOPT_PATH_LIMIT} per request (got ${paths.length}) — adopt in batches` });
    }
    res.json(adoptWorktrees(paths));
  } catch (err: any) {
    log.error(`Error adopting worktrees: ${err.message}`);
    res.status(500).json({ error: "Failed to adopt worktrees", details: err.message });
  }
});
