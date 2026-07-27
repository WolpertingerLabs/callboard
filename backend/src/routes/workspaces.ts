/**
 * Workspace routes — the minimum surface that makes the Phase 2 lifecycle
 * reachable. Two endpoints: see the workspaces (with the removability verdict
 * for each, so a refusal is legible), and archive one.
 *
 * Deliberately not here: create, rename, delete, and anything that adopts a
 * pre-existing worktree. Workspaces are still written only by the chat-start
 * path, and adoption is its own task with a user-confirmation flow.
 *
 * @see plans/workspace-object.md — Phase 2
 */
import { Router } from "express";
import { archiveWorkspace, listWorkspacesWithRemovability } from "../services/workspace-service.js";
import { getWorkspace } from "../services/workspace-store.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspaces-route");

export const workspacesRouter = Router();

// List workspaces, each with why its worktree may or may not be removed
workspacesRouter.get("/", (req, res) => {
  // #swagger.tags = ['Workspaces']
  // #swagger.summary = 'List workspaces'
  // #swagger.description = 'List workspaces with a removability verdict for each — whether its worktree can be removed, and every reason it cannot.'
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

// Archive a workspace: cascade to its chats, then remove the worktree if — and
// only if — it is owned, token-verified, unreferenced and clean.
workspacesRouter.post("/:id/archive", async (req, res) => {
  // #swagger.tags = ['Workspaces']
  // #swagger.summary = 'Archive a workspace'
  // #swagger.description = 'Interrupt and archive the chats of the workspace, mark the workspace archived, and remove its git worktree only when Callboard created it, its identity token verifies, no other active workspace shares the directory, and the worktree is clean (no uncommitted changes, no untracked files, no commits that exist nowhere else). A worktree is never force-removed; refusals are returned as blockers.'
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
