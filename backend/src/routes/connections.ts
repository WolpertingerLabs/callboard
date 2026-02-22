/**
 * Connection management API routes.
 *
 * Provides endpoints for listing connection templates, toggling
 * connections, and managing secrets — all for local mode.
 */
import { Router } from "express";
import type { Request, Response } from "express";
import {
  listConnectionsWithStatus,
  getConnectionStatus,
  setConnectionEnabled,
  setSecrets,
} from "../services/connection-manager.js";
import { getAgentSettings } from "../services/agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("connections-routes");

export const connectionsRouter = Router();

/**
 * GET /api/connections
 *
 * List all connection templates with runtime status (enabled, secrets set).
 */
// #swagger.tags = ['Connections']
// #swagger.summary = 'List all connection templates with status'
/* #swagger.responses[200] = { description: "Connection templates with status" } */
connectionsRouter.get("/", (_req: Request, res: Response): void => {
  try {
    const settings = getAgentSettings();
    const localModeActive =
      settings.proxyMode === "local" && !!settings.mcpConfigDir;

    if (!localModeActive) {
      res.json({ templates: [], localModeActive: false });
      return;
    }

    const templates = listConnectionsWithStatus();
    res.json({ templates, localModeActive: true });
  } catch (err: any) {
    log.error(`Error listing connections: ${err.message}`);
    res.status(500).json({ error: "Failed to list connections" });
  }
});

/**
 * POST /api/connections/:alias/enable
 *
 * Enable or disable a connection for the default caller.
 * Body: { enabled: boolean }
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
          enabled: { type: "boolean" }
        }
      }
    }
  }
} */
/* #swagger.responses[200] = { description: "Connection toggled" } */
/* #swagger.responses[400] = { description: "Invalid request" } */
connectionsRouter.post(
  "/:alias/enable",
  async (req: Request, res: Response): Promise<void> => {
    const { alias } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }

    try {
      await setConnectionEnabled(alias, enabled);
      res.json({ alias, enabled });
    } catch (err: any) {
      log.error(`Error toggling connection ${alias}: ${err.message}`);
      res.status(500).json({ error: "Failed to toggle connection" });
    }
  },
);

/**
 * PUT /api/connections/:alias/secrets
 *
 * Set secrets for a connection.
 * Body: { secrets: { SECRET_NAME: "value", ... } }
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
          secrets: { type: "object", additionalProperties: { type: "string" } }
        }
      }
    }
  }
} */
/* #swagger.responses[200] = { description: "Secrets updated" } */
/* #swagger.responses[400] = { description: "Invalid request" } */
connectionsRouter.put(
  "/:alias/secrets",
  async (req: Request, res: Response): Promise<void> => {
    const { secrets } = req.body;

    if (!secrets || typeof secrets !== "object") {
      res.status(400).json({ error: "secrets must be an object" });
      return;
    }

    try {
      const status = await setSecrets(secrets);
      res.json({ secretsSet: status });
    } catch (err: any) {
      log.error(`Error setting secrets for ${req.params.alias}: ${err.message}`);
      res.status(500).json({ error: "Failed to set secrets" });
    }
  },
);

/**
 * GET /api/connections/:alias/secrets
 *
 * Check which secrets are set for a connection (never returns actual values).
 * Returns { secretsSet: { SECRET_NAME: boolean, ... } }
 */
// #swagger.tags = ['Connections']
// #swagger.summary = 'Check which secrets are set for a connection'
/* #swagger.responses[200] = { description: "Secret status" } */
/* #swagger.responses[404] = { description: "Connection not found" } */
connectionsRouter.get("/:alias/secrets", (req: Request, res: Response): void => {
  try {
    const status = getConnectionStatus(req.params.alias);
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
