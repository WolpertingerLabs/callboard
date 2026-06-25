import { Router } from "express";
import {
  getGitBranches,
  getGitDiffStructured,
  getGitFileDiff,
  readRepoFile,
  validateFilename,
  validateFolderPath,
} from "../utils/git.js";
import { generateBranchName } from "../services/quick-completion.js";
import type { AgentProviderKind } from "../agents/ports/AgentProvider.js";

export const gitRouter = Router();

/** Providers a quick completion may be asked to run on. Mirrors the route-level
 *  guard in stream.ts — kept local so this utility route validates the free-form
 *  `provider` field instead of trusting it. */
const VALID_QC_PROVIDERS: ReadonlySet<AgentProviderKind> = new Set([
  "claude-code",
  "openrouter",
  "codex",
]);

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
            prompt: { type: "string", description: "Natural language description to generate a branch name from" },
            provider: { type: "string", enum: ["claude-code", "openrouter", "codex"], description: "Optional chat harness to generate the branch name on. Omit to use the default fallback (OpenRouter if configured, else Claude Code)." }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Generated branch name" } */
  /* #swagger.responses[400] = { description: "Missing prompt" } */
  /* #swagger.responses[500] = { description: "Failed to generate branch name" } */
  const { prompt, provider } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  // Forward the chat's harness when the request carries one (validated), so the
  // branch name is generated on the same provider; otherwise quick-completion's
  // default fallback resolution applies.
  const qcProvider =
    typeof provider === "string" && VALID_QC_PROVIDERS.has(provider as AgentProviderKind)
      ? (provider as AgentProviderKind)
      : undefined;

  try {
    const branchName = await generateBranchName(prompt, qcProvider);
    if (!branchName) {
      return res.status(500).json({ error: "Failed to generate branch name" });
    }
    res.json({ branchName });
  } catch (err: any) {
    res.status(500).json({ error: "Failed to generate branch name", details: err.message });
  }
});
