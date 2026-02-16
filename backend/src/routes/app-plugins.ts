import { Router } from "express";
import {
  getAllAppPluginsData,
  addScanRoot,
  removeScanRoot,
  rescanRoot,
  rescanAll,
  setPluginEnabled,
  setMcpServerEnabled,
  setMcpServerEnv,
} from "../services/app-plugins.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("app-plugins-routes");

export const appPluginsRouter = Router();

// Get all app-wide plugins data (scan roots, plugins, MCP servers)
appPluginsRouter.get("/", (req, res) => {
  // #swagger.tags = ['App Plugins']
  // #swagger.summary = 'Get app-wide plugins data'
  // #swagger.description = 'Returns scan roots, all discovered plugins, and MCP servers with their enabled states.'
  /* #swagger.responses[200] = { description: "App-wide plugins data" } */
  try {
    const data = getAllAppPluginsData();
    res.json(data);
  } catch (err: any) {
    log.error(`Error getting app plugins data: ${err.message}`);
    res.status(500).json({ error: "Failed to get app plugins data", details: err.message });
  }
});

// Scan a directory for plugins and add as a scan root
appPluginsRouter.post("/scan", (req, res) => {
  // #swagger.tags = ['App Plugins']
  // #swagger.summary = 'Scan directory for plugins'
  // #swagger.description = 'Recursively scans the given directory for .claude-plugin/marketplace.json files and .mcp.json configs. Adds the directory as a scan root.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["directory"],
          properties: {
            directory: { type: "string", description: "Absolute path to scan for plugins" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Scan result with discovered plugins and MCP servers" } */
  /* #swagger.responses[400] = { description: "Missing or invalid directory" } */
  const { directory } = req.body;

  if (!directory || typeof directory !== "string") {
    return res.status(400).json({ error: "directory is required" });
  }

  try {
    const result = addScanRoot(directory);
    res.json(result);
  } catch (err: any) {
    log.error(`Error scanning directory ${directory}: ${err.message}`);
    res.status(500).json({ error: "Failed to scan directory", details: err.message });
  }
});

// Re-scan one or all scan roots
appPluginsRouter.post("/rescan", (req, res) => {
  // #swagger.tags = ['App Plugins']
  // #swagger.summary = 'Re-scan plugin directories'
  // #swagger.description = 'Re-scans a specific scan root or all registered roots. Preserves enabled states for previously discovered items.'
  /* #swagger.requestBody = {
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            directory: { type: "string", description: "Specific scan root to rescan (omit for all)" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Updated app plugins data" } */
  const { directory } = req.body || {};

  try {
    if (directory) {
      rescanRoot(directory);
    } else {
      rescanAll();
    }
    const data = getAllAppPluginsData();
    res.json(data);
  } catch (err: any) {
    log.error(`Error rescanning: ${err.message}`);
    res.status(500).json({ error: "Failed to rescan", details: err.message });
  }
});

// Remove a scan root and its associated plugins/MCP servers
appPluginsRouter.delete("/scan-root", (req, res) => {
  // #swagger.tags = ['App Plugins']
  // #swagger.summary = 'Remove scan root'
  // #swagger.description = 'Removes a scan root directory and all plugins/MCP servers discovered from it.'
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["directory"],
          properties: {
            directory: { type: "string", description: "Scan root path to remove" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Scan root removed" } */
  /* #swagger.responses[400] = { description: "Missing directory" } */
  const { directory } = req.body;

  if (!directory || typeof directory !== "string") {
    return res.status(400).json({ error: "directory is required" });
  }

  try {
    removeScanRoot(directory);
    res.json({ ok: true });
  } catch (err: any) {
    log.error(`Error removing scan root ${directory}: ${err.message}`);
    res.status(500).json({ error: "Failed to remove scan root", details: err.message });
  }
});

// Toggle a plugin's enabled state
appPluginsRouter.patch("/plugins/:id", (req, res) => {
  // #swagger.tags = ['App Plugins']
  // #swagger.summary = 'Toggle plugin enabled state'
  // #swagger.description = 'Enable or disable an app-wide plugin. Disabling a plugin also disables its associated MCP servers.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'Plugin ID' } */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["enabled"],
          properties: {
            enabled: { type: "boolean", description: "Whether the plugin should be enabled" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "Plugin state updated" } */
  /* #swagger.responses[404] = { description: "Plugin not found" } */
  const { enabled } = req.body;

  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled (boolean) is required" });
  }

  try {
    setPluginEnabled(req.params.id, enabled);
    res.json({ ok: true });
  } catch (err: any) {
    if (err.message.includes("not found")) {
      return res.status(404).json({ error: err.message });
    }
    log.error(`Error toggling plugin ${req.params.id}: ${err.message}`);
    res.status(500).json({ error: "Failed to toggle plugin", details: err.message });
  }
});

// Toggle an MCP server's enabled state
appPluginsRouter.patch("/mcp-servers/:id", (req, res) => {
  // #swagger.tags = ['App Plugins']
  // #swagger.summary = 'Toggle MCP server enabled state'
  // #swagger.description = 'Enable or disable an MCP server.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'MCP server ID' } */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["enabled"],
          properties: {
            enabled: { type: "boolean", description: "Whether the MCP server should be enabled" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "MCP server state updated" } */
  /* #swagger.responses[404] = { description: "MCP server not found" } */
  const { enabled } = req.body;

  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled (boolean) is required" });
  }

  try {
    setMcpServerEnabled(req.params.id, enabled);
    res.json({ ok: true });
  } catch (err: any) {
    if (err.message.includes("not found")) {
      return res.status(404).json({ error: err.message });
    }
    log.error(`Error toggling MCP server ${req.params.id}: ${err.message}`);
    res.status(500).json({ error: "Failed to toggle MCP server", details: err.message });
  }
});

// Update an MCP server's environment variables
appPluginsRouter.patch("/mcp-servers/:id/env", (req, res) => {
  // #swagger.tags = ['App Plugins']
  // #swagger.summary = 'Update MCP server environment variables'
  // #swagger.description = 'Set or override environment variables for an MCP server. Values are persisted and used when the server is started.'
  /* #swagger.parameters['id'] = { in: 'path', required: true, type: 'string', description: 'MCP server ID' } */
  /* #swagger.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["env"],
          properties: {
            env: { type: "object", description: "Key-value pairs of environment variables" }
          }
        }
      }
    }
  } */
  /* #swagger.responses[200] = { description: "MCP server env updated" } */
  /* #swagger.responses[404] = { description: "MCP server not found" } */
  const { env } = req.body;

  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return res.status(400).json({ error: "env (object) is required" });
  }

  try {
    setMcpServerEnv(req.params.id, env);
    res.json({ ok: true });
  } catch (err: any) {
    if (err.message.includes("not found")) {
      return res.status(404).json({ error: err.message });
    }
    log.error(`Error updating MCP server env ${req.params.id}: ${err.message}`);
    res.status(500).json({ error: "Failed to update MCP server env", details: err.message });
  }
});
