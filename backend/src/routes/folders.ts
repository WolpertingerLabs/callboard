import { Router } from "express";
import { folderService } from "../services/folder-service.js";

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
