/**
 * Connection management API routes.
 *
 * Provides endpoints for listing connection templates, toggling
 * connections, managing secrets, and managing caller aliases —
 * all for local mode.
 *
 * All connection-scoped endpoints accept an optional `caller` parameter
 * (query param or body field) to specify which caller alias to operate on.
 * Defaults to "default" when omitted.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import {
  listConnectionsWithStatus,
  getConnectionStatus,
  setConnectionEnabled,
  setSecrets,
  listCallerAliases,
  createCallerAlias,
  deleteCallerAlias,
  listRemoteConnections,
} from "../services/connection-manager.js";
import { getAgentSettings, getActiveMcpConfigDir } from "../services/agent-settings.js";
import { isProxyConfigured, getConfiguredAliases } from "../services/proxy-singleton.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("connections-routes");

export const connectionsRouter = Router();

// ── Caller alias management ─────────────────────────────────────────

/**
 * GET /api/connections/callers
 *
 * List all configured caller aliases.
 */
// #swagger.tags = ['Connections']
// #swagger.summary = 'List caller aliases'
/* #swagger.responses[200] = { description: "List of caller aliases" } */
connectionsRouter.get("/callers", (_req: Request, res: Response): void => {
  try {
    const settings = getAgentSettings();
    const localActive = settings.proxyMode === "local" && !!getActiveMcpConfigDir();
    const remoteActive = settings.proxyMode === "remote" && isProxyConfigured();

    if (localActive) {
      const callers = listCallerAliases();
      res.json({ callers });
      return;
    }

    if (remoteActive) {
      // In remote mode, callers are key aliases (read-only, no create/delete)
      const aliases = getConfiguredAliases();
      const callers = aliases.map((alias) => ({
        alias,
        connectionCount: 0, // Unknown until routes are fetched
      }));
      res.json({ callers });
      return;
    }

    res.json({ callers: [] });
  } catch (err: any) {
    log.error(`Error listing caller aliases: ${err.message}`);
    res.status(500).json({ error: "Failed to list caller aliases" });
  }
});

/**
 * POST /api/connections/callers
 *
 * Create a new caller alias.
 * Body: { alias: string, name?: string }
 */
// #swagger.tags = ['Connections']
// #swagger.summary = 'Create a new caller alias'
/* #swagger.requestBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["alias"],
        properties: {
          alias: { type: "string" },
          name: { type: "string" }
        }
      }
    }
  }
} */
/* #swagger.responses[200] = { description: "Caller created" } */
/* #swagger.responses[400] = { description: "Invalid request" } */
connectionsRouter.post("/callers", (req: Request, res: Response): void => {
  const { alias, name } = req.body;

  if (!alias || typeof alias !== "string") {
    res.status(400).json({ error: "alias is required and must be a string" });
    return;
  }

  // Validate alias format (alphanumeric, hyphens, underscores)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(alias)) {
    res.status(400).json({
      error: "alias must start with a letter or number and contain only letters, numbers, hyphens, and underscores",
    });
    return;
  }

  try {
    const caller = createCallerAlias(alias, name);
    res.json({ caller });
  } catch (err: any) {
    if (err.message.includes("already exists")) {
      res.status(409).json({ error: err.message });
    } else {
      log.error(`Error creating caller alias: ${err.message}`);
      res.status(500).json({ error: "Failed to create caller alias" });
    }
  }
});

/**
 * DELETE /api/connections/callers/:callerAlias
 *
 * Delete a caller alias and its associated env vars.
 */
// #swagger.tags = ['Connections']
// #swagger.summary = 'Delete a caller alias'
/* #swagger.responses[200] = { description: "Caller deleted" } */
/* #swagger.responses[400] = { description: "Cannot delete default caller" } */
/* #swagger.responses[404] = { description: "Caller not found" } */
connectionsRouter.delete("/callers/:callerAlias", async (req: Request, res: Response): Promise<void> => {
  const { callerAlias } = req.params;
  try {
    await deleteCallerAlias(callerAlias);
    res.json({ deleted: callerAlias });
  } catch (err: any) {
    if (err.message.includes("Cannot delete")) {
      res.status(400).json({ error: err.message });
    } else if (err.message.includes("not found")) {
      res.status(404).json({ error: err.message });
    } else {
      log.error(`Error deleting caller alias: ${err.message}`);
      res.status(500).json({ error: "Failed to delete caller alias" });
    }
  }
});

// ── Connection template endpoints ───────────────────────────────────

/**
 * GET /api/connections
 *
 * List all connection templates with runtime status (enabled, secrets set).
 * Query: ?caller=X (default: "default")
 */
// #swagger.tags = ['Connections']
// #swagger.summary = 'List all connection templates with status'
/* #swagger.responses[200] = { description: "Connection templates with status" } */
connectionsRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  try {
    const settings = getAgentSettings();
    const localModeActive = settings.proxyMode === "local" && !!getActiveMcpConfigDir();
    const remoteModeActive = settings.proxyMode === "remote" && isProxyConfigured();

    if (localModeActive) {
      const callerAlias = (req.query.caller as string) || "default";
      const templates = listConnectionsWithStatus(callerAlias);
      const callers = listCallerAliases();
      res.json({ templates, callers, localModeActive: true, remoteModeActive: false });
      return;
    }

    if (remoteModeActive) {
      const callerAlias = (req.query.caller as string) || undefined;
      const { templates, callers } = await listRemoteConnections(callerAlias);
      res.json({ templates, callers, localModeActive: false, remoteModeActive: true });
      return;
    }

    // Neither mode is active
    res.json({ templates: [], callers: [], localModeActive: false, remoteModeActive: false });
  } catch (err: any) {
    log.error(`Error listing connections: ${err.message}`);
    res.status(500).json({ error: "Failed to list connections" });
  }
});

/**
 * POST /api/connections/:alias/enable
 *
 * Enable or disable a connection for a specific caller.
 * Body: { enabled: boolean, caller?: string }
 */
// #swagger.tags = ['Connections']
// #swagger.summary = 'Enable or disable a connection'
/* #swagger.requestBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["enabled"],
        properties: {
          enabled: { type: "boolean" },
          caller: { type: "string" }
        }
      }
    }
  }
} */
/* #swagger.responses[200] = { description: "Connection toggled" } */
/* #swagger.responses[400] = { description: "Invalid request" } */
connectionsRouter.post("/:alias/enable", async (req: Request, res: Response): Promise<void> => {
  const { alias } = req.params;
  const { enabled, caller } = req.body;
  const callerAlias = caller || "default";

  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }

  try {
    await setConnectionEnabled(alias, enabled, callerAlias);
    res.json({ alias, enabled });
  } catch (err: any) {
    log.error(`Error toggling connection ${alias}: ${err.message}`);
    res.status(500).json({ error: "Failed to toggle connection" });
  }
});

/**
 * PUT /api/connections/:alias/secrets
 *
 * Set secrets for a connection, scoped to a specific caller.
 * Body: { secrets: { SECRET_NAME: "value", ... }, caller?: string }
 * An empty string value deletes the secret.
 */
// #swagger.tags = ['Connections']
// #swagger.summary = 'Set secrets for a connection'
/* #swagger.requestBody = {
  required: true,
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["secrets"],
        properties: {
          secrets: { type: "object", additionalProperties: { type: "string" } },
          caller: { type: "string" }
        }
      }
    }
  }
} */
/* #swagger.responses[200] = { description: "Secrets updated" } */
/* #swagger.responses[400] = { description: "Invalid request" } */
connectionsRouter.put("/:alias/secrets", async (req: Request, res: Response): Promise<void> => {
  const { secrets, caller } = req.body;
  const callerAlias = caller || "default";

  if (!secrets || typeof secrets !== "object") {
    res.status(400).json({ error: "secrets must be an object" });
    return;
  }

  try {
    const status = await setSecrets(secrets, callerAlias);
    res.json({ secretsSet: status });
  } catch (err: any) {
    log.error(`Error setting secrets for ${req.params.alias}: ${err.message}`);
    res.status(500).json({ error: "Failed to set secrets" });
  }
});

/**
 * GET /api/connections/:alias/secrets
 *
 * Check which secrets are set for a connection (never returns actual values).
 * Query: ?caller=X (default: "default")
 * Returns { secretsSet: { SECRET_NAME: boolean, ... } }
 */
// #swagger.tags = ['Connections']
// #swagger.summary = 'Check which secrets are set for a connection'
/* #swagger.responses[200] = { description: "Secret status" } */
/* #swagger.responses[404] = { description: "Connection not found" } */
connectionsRouter.get("/:alias/secrets", (req: Request, res: Response): void => {
  try {
    const callerAlias = (req.query.caller as string) || "default";
    const status = getConnectionStatus(req.params.alias, callerAlias);
    if (!status) {
      res.status(404).json({ error: "Connection template not found" });
      return;
    }
    res.json({
      secretsSet: {
        ...status.requiredSecretsSet,
        ...status.optionalSecretsSet,
      },
    });
  } catch (err: any) {
    log.error(`Error checking secrets for ${req.params.alias}: ${err.message}`);
    res.status(500).json({ error: "Failed to check secrets" });
  }
});
