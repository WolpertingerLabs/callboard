import { Router } from "express";
import { getGitBranches, getGitWorktrees, removeWorktree, validateFolderPath } from "../utils/git.js";

export const gitRouter = Router();

/**
 * List local branches for a git repository.
 * Returns branches sorted alphabetically with the current branch first.
 */
gitRouter.get("/branches", (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'List git branches'
  // #swagger.description = 'Returns local branches for a git repository, sorted alphabetically with the current branch first.'
  /* #swagger.parameters['folder'] = { in: 'query', required: true, type: 'string', description: 'Absolute path to the git repository' } */
  /* #swagger.responses[200] = { description: "Array of branch objects" } */
  /* #swagger.responses[400] = { description: "Missing or invalid folder" } */
  const rawFolder = req.query.folder as string;
  if (!rawFolder) return res.status(400).json({ error: "folder query param is required" });

  let folder: string;
  try {
    folder = validateFolderPath(rawFolder);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const branches = getGitBranches(folder);
    res.json({ branches });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to list branches", details: err.message });
  }
});

/**
 * List all git worktrees for a repository.
 */
gitRouter.get("/worktrees", (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'List git worktrees'
  // #swagger.description = 'Returns all git worktrees for a repository.'
  /* #swagger.parameters['folder'] = { in: 'query', required: true, type: 'string', description: 'Absolute path to the git repository' } */
  /* #swagger.responses[200] = { description: "Array of worktree objects" } */
  /* #swagger.responses[400] = { description: "Missing or invalid folder" } */
  const rawFolder = req.query.folder as string;
  if (!rawFolder) return res.status(400).json({ error: "folder query param is required" });

  let folder: string;
  try {
    folder = validateFolderPath(rawFolder);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const worktrees = getGitWorktrees(folder);
    res.json({ worktrees });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to list worktrees", details: err.message });
  }
});

/**
 * Remove a git worktree and prune stale references.
 */
gitRouter.delete("/worktrees", (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'Remove a worktree'
  // #swagger.description = 'Remove a git worktree and prune stale references.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["folder", "worktreePath"],
          properties: {
            folder: { type: "string", description: "Absolute path to the main git repository" },
            worktreePath: { type: "string", description: "Path to the worktree to remove" },
            force: { type: "boolean", description: "Force removal even with uncommitted changes" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Worktree removed" } */
  /* #swagger.responses[400] = { description: "Missing required fields or invalid folder" } */
  const { folder: rawFolder, worktreePath, force } = req.body;
  if (!rawFolder) return res.status(400).json({ error: "folder is required" });
  if (!worktreePath) return res.status(400).json({ error: "worktreePath is required" });

  let folder: string;
  try {
    folder = validateFolderPath(rawFolder);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    removeWorktree(folder, worktreePath, !!force);
    res.json({ ok: true, removed: worktreePath });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to remove worktree", details: err.message });
  }
});
