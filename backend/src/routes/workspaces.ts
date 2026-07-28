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
 * Phase 4b: create and rename. Both are narrower than their names suggest, and
 * on purpose — `POST /` writes a **local** record and refuses a worktree
 * directory outright (that is adoption's job, with adoption's gates), and
 * rename touches nothing but the record's own JSON. See services/
 * workspace-create.ts for why creation may not be allowed to reach `owned`.
 *
 * Deliberately still not here: delete. A record is archived, never removed —
 * `deleteWorkspace` in the store exists only to roll back a half-finished
 * adoption, and exposing it would throw away the provenance that makes a stale
 * record cleanable.
 *
 * @see plans/workspace-object.md — Phases 2, 2b and 4
 */
import { Router } from "express";
import { adoptWorktrees } from "../services/workspace-adoption.js";
import { createLocalWorkspace } from "../services/workspace-create.js";
import { listUnmanagedWorktrees } from "../services/workspace-discovery.js";
import { archiveWorkspace, listWorkspacesWithRemovability } from "../services/workspace-service.js";
import { getWorkspace, renameWorkspace } from "../services/workspace-store.js";
import { listTrash, restoreTrashEntry } from "../services/workspace-trash.js";
import { newDiskUsageBudget } from "../utils/disk-usage.js";
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
  /* #swagger.parameters['includeDiskUsage'] = { in: 'query', type: 'string', description: 'Pass "true" to measure each workspace with du -sk. Off by default: it is the slow part. Measurements are memoised for five minutes, a workspace whose directory is missing is not measured, and the whole listing shares one wall-clock budget — entries past it carry an error saying so and the response carries a diskUsageNote.' } */
  /* #swagger.responses[200] = { description: "Workspaces with removability" } */
  /* #swagger.responses[400] = { description: "Invalid status filter" } */
  try {
    const status = req.query.status as "active" | "archived" | undefined;
    if (status && status !== "active" && status !== "archived") {
      return res.status(400).json({ error: 'status must be "active" or "archived"' });
    }
    const includeDiskUsage = req.query.includeDiskUsage === "true";
    // One budget for the whole listing. `du` is synchronous, so N entries with
    // only a per-entry timeout is N × 15s of frozen daemon.
    const budget = newDiskUsageBudget();
    const workspaces = listWorkspacesWithRemovability(status ? { status } : undefined, { includeDiskUsage, budget });
    const diskUsageNote = budget.note(workspaces.length);
    res.json({ workspaces, ...(diskUsageNote && { diskUsageNote }) });
  } catch (err: any) {
    log.error(`Error listing workspaces: ${err.message}`);
    res.status(500).json({ error: "Failed to list workspaces", details: err.message });
  }
});

// ── Create and rename (Phase 4b) ────────────────────────────────────

// Create a LOCAL workspace record for an existing directory. It cannot produce
// an owned worktree record: no isolation, no worktree block, no `owned` — and a
// directory that is already a worktree is refused and sent to /adopt.
workspacesRouter.post("/", (req, res) => {
  // #swagger.tags = ['Workspaces']
  // #swagger.summary = 'Create a workspace record for a directory'
  // #swagger.description = 'Create a local workspace record for an existing directory: a named "where work happens" entry the sidebar and the workspace list can show. It creates NO worktree, runs no git command that writes, and can never mark a directory as owned by Callboard — records written here carry no worktree block at all, so the ownership flag that gates worktree removal does not exist on them. A directory that is already a git worktree is refused with `is-a-worktree`: bringing one under management is POST /adopt, which writes the identity token and verifies registration, and a plain record here would additionally make that worktree permanently unadoptable. A second record on a directory that already has one is allowed (several workspaces may share a cwd) and the existing ones come back as `sharedWith`.'
  /* #swagger.parameters['body'] = { in: 'body', required: true, schema: { cwd: '/abs/path/to/directory', name: 'Optional label' } } */
  /* #swagger.responses[201] = { description: "The created workspace record" } */
  /* #swagger.responses[400] = { description: "Invalid body, or a refusal with its code and detail" } */
  try {
    const cwd = req.body?.cwd;
    if (typeof cwd !== "string" || !cwd.trim()) {
      return res.status(400).json({ error: "cwd must be a non-empty string — the absolute path of the directory work happens in" });
    }
    const name = req.body?.name;
    if (name !== undefined && typeof name !== "string") {
      return res.status(400).json({ error: "name must be a string when given" });
    }
    const result = createLocalWorkspace({ cwd, ...(name !== undefined && { name }) });
    // A refusal is the answer, not a transport failure — but it is a 400 so a
    // caller that only checks the status never mistakes it for a creation.
    res.status(result.created ? 201 : 400).json(result);
  } catch (err: any) {
    log.error(`Error creating workspace: ${err.message}`);
    res.status(500).json({ error: "Failed to create workspace", details: err.message });
  }
});

// Rename a workspace. Record-only: nothing on disk moves.
workspacesRouter.post("/:id/rename", (req, res) => {
  // #swagger.tags = ['Workspaces']
  // #swagger.summary = 'Rename a workspace'
  // #swagger.description = 'Change a workspace record\'s label. NOTHING ON DISK MOVES: the name is not the directory, the branch or the worktree path, and no path is ever derived from it — cwd, repoPath and worktree.branch are what every path-producing operation reads. Names are rejected when empty, longer than 200 characters, or carrying control or text-direction characters, because they are rendered in lists and written to log lines. Archived workspaces can be renamed too.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Workspace ID' } */
  /* #swagger.parameters['body'] = { in: 'body', required: true, schema: { name: 'New label' } } */
  /* #swagger.responses[200] = { description: "The renamed workspace record" } */
  /* #swagger.responses[400] = { description: "Invalid name" } */
  /* #swagger.responses[404] = { description: "Workspace not found" } */
  try {
    const name = req.body?.name;
    if (typeof name !== "string") {
      return res.status(400).json({ error: "name must be a string" });
    }
    let workspace;
    try {
      workspace = renameWorkspace(req.params.id, name);
    } catch (err: any) {
      // The store throws on an unusable name and returns null on an unknown id;
      // only the first is the caller's input being wrong.
      return res.status(400).json({ error: err.message });
    }
    if (!workspace) return res.status(404).json({ error: "Workspace not found" });
    res.json({ workspace });
  } catch (err: any) {
    log.error(`Error renaming workspace ${req.params.id}: ${err.message}`);
    res.status(500).json({ error: "Failed to rename workspace", details: err.message });
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

// ── Trash (Phase 4a) ────────────────────────────────────────────────
//
// The retention sweep is the one thing Callboard deletes without being asked.
// These two make it inspectable and undoable.

workspacesRouter.get("/trash", (req, res) => {
  // #swagger.tags = ['Workspaces']
  // #swagger.summary = 'List quarantined worktrees'
  // #swagger.description = 'Read-only listing of ~/.callboard/trash: every quarantined worktree, where it came from, the branch and repository needed to restore it, when it was quarantined and when the 30-day retention sweep would delete it. Ages come from each entry\'s own manifest, exactly as the sweep reads them, never from directory mtime (rename does not update it). An entry the sweep will never take — no readable manifest, or no usable timestamp — reports `sweepBlocked` instead of an expiry, because unknowns are kept forever by design. Writes nothing and sweeps nothing.'
  /* #swagger.parameters['includeDiskUsage'] = { in: 'query', type: 'string', description: 'Pass "true" to measure each entry with du -sk. Off by default. The whole listing shares one wall-clock budget; entries past it carry an error saying so and the response carries a diskUsageNote.' } */
  /* #swagger.responses[200] = { description: "Trash entries, soonest to expire first" } */
  try {
    res.json(listTrash({ includeDiskUsage: req.query.includeDiskUsage === "true" }));
  } catch (err: any) {
    log.error(`Error listing trash: ${err.message}`);
    res.status(500).json({ error: "Failed to list trash", details: err.message });
  }
});

workspacesRouter.post("/trash/:entry/restore", (req, res) => {
  // #swagger.tags = ['Workspaces']
  // #swagger.summary = 'Restore a quarantined worktree'
  // #swagger.description = 'Recreate the checkout with the manifest\'s own recipe ("git worktree add <path> <branch>") and copy back everything git does not track — the .env, the local databases, the ignored build output that travelled into the trash with the directory. The trash entry is NOT deleted: a restore copies out and leaves the quarantined directory intact, so a restore that goes wrong loses nothing. Refuses outright if anything already exists at the original path; a directory that has come back is not written over. The copy never overwrites a file git just checked out — such names are skipped and reported.'
  /* #swagger.parameters['entry'] = { in: 'path', required: true, type: 'string', description: 'Directory name under the trash root, as returned by GET /trash.' } */
  /* #swagger.responses[200] = { description: "Restore outcome; ok:false carries a failure code and detail" } */
  try {
    const result = restoreTrashEntry(req.params.entry);
    // A refusal is an outcome, not a transport error: the caller wants the code
    // and the sentence, and every refusal leaves the trash entry intact.
    res.status(result.ok ? 200 : 409).json(result);
  } catch (err: any) {
    log.error(`Error restoring trash entry ${req.params.entry}: ${err.message}`);
    res.status(500).json({ error: "Failed to restore trash entry", details: err.message });
  }
});
