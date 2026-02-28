import { Router } from "express";
import {
  getGitBranches,
  getGitDiffStructured,
  getGitFileDiff,
  getGitWorktrees,
  readRepoFile,
  removeWorktree,
  validateFilename,
  validateFolderPath,
} from "../utils/git.js";
import { generateBranchName } from "../services/quick-completion.js";

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

/**
 * Get structured git diff with file metadata, untracked files, and large file gating.
 */
gitRouter.get("/diff", (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'Get structured git diff'
  // #swagger.description = 'Returns per-file diff data including untracked files, with large file gating.'
  /* #swagger.parameters['folder'] = { in: 'query', required: true, type: 'string', description: 'Absolute path to the git repository' } */
  /* #swagger.responses[200] = { description: "Structured diff response with files array" } */
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
    const files = getGitDiffStructured(folder);
    res.json({ files });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to get diff", details: err.message });
  }
});

/**
 * Get the diff for a single file on demand (for large files).
 */
gitRouter.get("/diff/file", (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'Get single file diff'
  // #swagger.description = 'Returns the diff for a single file, used for on-demand loading of large files.'
  /* #swagger.parameters['folder'] = { in: 'query', required: true, type: 'string' } */
  /* #swagger.parameters['filename'] = { in: 'query', required: true, type: 'string' } */
  const rawFolder = req.query.folder as string;
  const filename = req.query.filename as string;

  if (!rawFolder) return res.status(400).json({ error: "folder query param is required" });
  if (!filename) return res.status(400).json({ error: "filename query param is required" });

  let folder: string;
  try {
    folder = validateFolderPath(rawFolder);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    validateFilename(filename);
    const result = getGitFileDiff(folder, filename);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: "Failed to get file diff", details: err.message });
  }
});

/**
 * Serve raw file content for media previews (images, videos).
 */
gitRouter.get("/diff/file/raw", (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'Get raw file content'
  // #swagger.description = 'Serves raw file bytes for media previews in the diff view.'
  /* #swagger.parameters['folder'] = { in: 'query', required: true, type: 'string' } */
  /* #swagger.parameters['filename'] = { in: 'query', required: true, type: 'string' } */
  const rawFolder = req.query.folder as string;
  const filename = req.query.filename as string;

  if (!rawFolder) return res.status(400).json({ error: "folder query param is required" });
  if (!filename) return res.status(400).json({ error: "filename query param is required" });

  let folder: string;
  try {
    folder = validateFolderPath(rawFolder);
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }

  try {
    validateFilename(filename);
    const { buffer, contentType } = readRepoFile(folder, filename);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-cache");
    res.end(buffer);
  } catch (err: any) {
    if (err.message === "File not found") {
      return res.status(404).json({ error: "File not found" });
    }
    res.status(500).json({ error: "Failed to read file", details: err.message });
  }
});

/**
 * Generate a git-safe branch name from a natural language prompt.
 * Uses AI to produce a <type>/<kebab-case-description> format branch name.
 */
gitRouter.post("/generate-branch-name", async (req, res) => {
  // #swagger.tags = ['Git']
  // #swagger.summary = 'Generate a branch name from a prompt'
  // #swagger.description = 'Uses AI to generate a git-safe branch name from a natural language request.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["prompt"],
          properties: {
            prompt: { type: "string", description: "Natural language description to generate a branch name from" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Generated branch name" } */
  /* #swagger.responses[400] = { description: "Missing prompt" } */
  /* #swagger.responses[500] = { description: "Failed to generate branch name" } */
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  try {
    const branchName = await generateBranchName(prompt);
    if (!branchName) {
      return res.status(500).json({ error: "Failed to generate branch name" });
    }
    res.json({ branchName });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to generate branch name", details: err.message });
  }
});
