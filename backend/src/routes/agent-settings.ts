/**
 * Agent settings routes.
 *
 *   GET  /api/agent-settings              — get current settings
 *   PUT  /api/agent-settings              — update settings
 *   GET  /api/agent-settings/key-aliases  — discover key aliases from MCP config dir
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { getAgentSettings, updateAgentSettings, discoverKeyAliases } from "../services/agent-settings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent-settings-routes");

export const agentSettingsRouter = Router();

/** GET /api/agent-settings — get current agent settings */
agentSettingsRouter.get("/", (_req: Request, res: Response): void => {
  try {
    const settings = getAgentSettings();
    res.json(settings);
  } catch (err: any) {
    log.error(`Error getting agent settings: ${err.message}`);
    res.status(500).json({ error: "Failed to get agent settings" });
  }
});

/** PUT /api/agent-settings — update agent settings */
agentSettingsRouter.put("/", (req: Request, res: Response): void => {
  const { mcpConfigDir } = req.body;
  try {
    const updated = updateAgentSettings({ mcpConfigDir: mcpConfigDir ?? undefined });
    res.json(updated);
  } catch (err: any) {
    log.error(`Error updating agent settings: ${err.message}`);
    res.status(500).json({ error: "Failed to update agent settings" });
  }
});

/** GET /api/agent-settings/key-aliases — discover available key aliases */
agentSettingsRouter.get("/key-aliases", (_req: Request, res: Response): void => {
  try {
    const aliases = discoverKeyAliases();
    res.json({ aliases });
  } catch (err: any) {
    log.error(`Error discovering key aliases: ${err.message}`);
    res.status(500).json({ error: "Failed to discover key aliases" });
  }
});
