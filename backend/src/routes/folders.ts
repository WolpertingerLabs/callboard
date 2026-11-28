import { Router, type Request, type Response } from "express";
import { folderService } from "../services/folder-service.js";
import { requireSessionAuth } from "../auth.js";
import { getAgentSettings } from "../services/agent-settings.js";
import {
  decideRepoConfig,
  isFolderTrusted,
  normalizeClaudeProjectHooksMode,
  readTrustedFolders,
  scanRepoExecutableConfig,
  trustFolder,
  untrustFolder,
} from "../services/repo-config-trust.js";

export const foldersRouter = Router();

// Browse directories and files in a given path
foldersRouter.get("/browse", async (req, res) => {
  // #swagger.tags = ['Folders']
  // #swagger.summary = 'Browse directory'
  // #swagger.description = 'List files and subdirectories at the given path.'
  /* #swagger.parameters['path'] = { in: 'query', required: true, type: 'string', description: 'Absolute path to browse' } */
  /* #swagger.parameters['showHidden'] = { in: 'query', type: 'boolean', description: 'Include hidden files (default: false)' } */
  /* #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Max entries to return (default: 500)' } */
  /* #swagger.responses[200] = { description: "Directory listing" } */
  /* #swagger.responses[400] = { description: "Missing path parameter" } */
  try {
    const path = req.query.path as string;
    const showHidden = req.query.showHidden === "true";
    const limit = parseInt(req.query.limit as string) || 500;

    if (!path) {
      return res.status(400).json({ error: "path query parameter is required" });
    }

    const result = await folderService.browseDirectory(path, showHidden, limit);
    res.json(result);
  } catch (err: any) {
    console.error("Error browsing directory:", err);
    res.status(500).json({ error: "Failed to browse directory", details: err.message });
  }
});

// Validate if a path exists and is accessible
foldersRouter.get("/validate", async (req, res) => {
  // #swagger.tags = ['Folders']
  // #swagger.summary = 'Validate path'
  // #swagger.description = 'Check if a path exists and is accessible.'
  /* #swagger.parameters['path'] = { in: 'query', required: true, type: 'string', description: 'Path to validate' } */
  /* #swagger.responses[200] = { description: "Validation result" } */
  /* #swagger.responses[400] = { description: "Missing path parameter" } */
  try {
    const path = req.query.path as string;

    if (!path) {
      return res.status(400).json({ error: "path query parameter is required" });
    }

    const result = await folderService.validatePath(path);
    res.json(result);
  } catch (err: any) {
    console.error("Error validating path:", err);
    res.status(500).json({ error: "Failed to validate path", details: err.message });
  }
});

// Get suggested directories for quick access
foldersRouter.get("/suggestions", async (req, res) => {
  // #swagger.tags = ['Folders']
  // #swagger.summary = 'Get folder suggestions'
  // #swagger.description = 'Returns suggested directories for quick access (e.g., home, common project dirs).'
  /* #swagger.responses[200] = { description: "Array of suggested directory paths" } */
  try {
    const suggestions = folderService.getSuggestions();
    res.json({ suggestions });
  } catch (err: any) {
    console.error("Error getting suggestions:", err);
    res.status(500).json({ error: "Failed to get suggestions", details: err.message });
  }
});

// Get recently used directories derived from chat history
foldersRouter.get("/recent", async (req, res) => {
  // #swagger.tags = ['Folders']
  // #swagger.summary = 'Get recent folders'
  // #swagger.description = 'Returns recently used project directories derived from chat history.'
  /* #swagger.parameters['limit'] = { in: 'query', type: 'integer', description: 'Max folders to return (default: 10)' } */
  /* #swagger.responses[200] = { description: "Array of recent folder paths" } */
  try {
    const limit = parseInt(req.query.limit as string) || 10;
    const recent = folderService.getRecentFolders(limit);
    res.json({ recent });
  } catch (err: any) {
    console.error("Error getting recent folders:", err);
    res.status(500).json({ error: "Failed to get recent folders", details: err.message });
  }
});

// Clear cache (useful for development/testing)
foldersRouter.post("/clear-cache", (req, res) => {
  // #swagger.tags = ['Folders']
  // #swagger.summary = 'Clear folder cache'
  // #swagger.description = 'Clear the folder browsing cache. Useful for development and testing.'
  /* #swagger.responses[200] = { description: "Cache cleared" } */
  try {
    folderService.clearCache();
    res.json({ ok: true, message: "Cache cleared" });
  } catch (err: any) {
    console.error("Error clearing cache:", err);
    res.status(500).json({ error: "Failed to clear cache", details: err.message });
  }
});

// ── Repository Claude config trust (H-02, services/repo-config-trust.ts) ─────
// Keyed on the folder, never a workspace: trust is about what is in the
// directory. Reading is open to any authenticated caller; granting or revoking
// trust is session-only (a logged-in human), so a bearer key can't do it. There
// is deliberately no callboard-tools MCP tool for it either: an agent must not
// be able to trust the folder it is about to run in.

function folderParam(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().startsWith("/") ? v.trim() : undefined;
}

foldersRouter.get("/repo-config", (req: Request, res: Response) => {
  // #swagger.tags = ['Folders']
  // #swagger.summary = 'Repository Claude config status'
  // #swagger.description = 'What executable Claude config (hooks, statusLine, credential helpers, .mcp.json servers) a folder defines, whether it is trusted, and — given a codeExecution level — whether a Claude Code session there would run it.'
  /* #swagger.parameters['folder'] = { in: 'query', required: true, type: 'string', description: 'Absolute folder path' } */
  /* #swagger.parameters['codeExecution'] = { in: 'query', type: 'string', description: 'allow | ask | deny; include a decision for that level' } */
  const folder = folderParam(req.query.folder);
  if (!folder) return res.status(400).json({ error: "folder query parameter (an absolute path) is required" });
  const mode = normalizeClaudeProjectHooksMode(getAgentSettings().claudeProjectHooks);
  const trust = isFolderTrusted(folder);
  const ce = req.query.codeExecution;
  const codeExecution = ce === "allow" || ce === "ask" || ce === "deny" ? ce : undefined;
  res.json({
    folder,
    trusted: trust.trusted,
    ...(trust.root && { trustRoot: trust.root }),
    mode,
    defines: scanRepoExecutableConfig(folder),
    ...(codeExecution && { decision: decideRepoConfig({ cwd: folder, codeExecution, mode }) }),
  });
});

foldersRouter.get("/trusted", (_req: Request, res: Response) => {
  // #swagger.tags = ['Folders']
  // #swagger.summary = 'List trusted folders'
  res.json({ folders: readTrustedFolders() });
});

foldersRouter.post("/trust", requireSessionAuth, (req: Request, res: Response) => {
  // #swagger.tags = ['Folders']
  // #swagger.summary = 'Trust a folder'
  // #swagger.description = 'Let Claude Code chats with Code execution Allow run this folder\'s own hooks, helpers and .mcp.json servers. Logged-in sessions only.'
  const folder = folderParam(req.body?.folder);
  if (!folder) return res.status(400).json({ error: "folder (an absolute path) is required" });
  try {
    res.json({ folder: trustFolder(folder) });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

foldersRouter.delete("/trust", requireSessionAuth, (req: Request, res: Response) => {
  // #swagger.tags = ['Folders']
  // #swagger.summary = 'Stop trusting a folder'
  const folder = folderParam(req.body?.folder) ?? folderParam(req.query.folder);
  if (!folder) return res.status(400).json({ error: "folder (an absolute path) is required" });
  try {
    res.json({ removed: untrustFolder(folder) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
