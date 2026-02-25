/**
 * Agent settings routes.
 *
 *   GET  /api/agent-settings                  — get current settings
 *   PUT  /api/agent-settings                  — update settings
 *   GET  /api/agent-settings/key-aliases      — discover key aliases from MCP config dir
 *   POST /api/agent-settings/test-connection  — test remote proxy connection
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { getAgentSettings, updateAgentSettings, discoverKeyAliases } from "../services/agent-settings.js";
import { DEFAULT_MCP_LOCAL_DIR, DEFAULT_MCP_REMOTE_DIR } from "../utils/paths.js";
import { resetAllClients } from "../services/proxy-singleton.js";
import { testRemoteConnection } from "../services/proxy-singleton.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent-settings-routes");

export const agentSettingsRouter = Router();

/** GET /api/agent-settings — get current agent settings */
agentSettingsRouter.get("/", (_req: Request, res: Response): void => {
  try {
    const settings = getAgentSettings();
    res.json({ ...settings, defaultLocalMcpConfigDir: DEFAULT_MCP_LOCAL_DIR, defaultRemoteMcpConfigDir: DEFAULT_MCP_REMOTE_DIR });
  } catch (err: any) {
    log.error(`Error getting agent settings: ${err.message}`);
    res.status(500).json({ error: "Failed to get agent settings" });
  }
});

/** PUT /api/agent-settings — update agent settings */
agentSettingsRouter.put("/", (req: Request, res: Response): void => {
  const { mcpConfigDir, localMcpConfigDir, remoteMcpConfigDir, proxyMode, remoteServerUrl } = req.body;
  try {
    const updated = updateAgentSettings({
      mcpConfigDir: mcpConfigDir ?? undefined,
      localMcpConfigDir: localMcpConfigDir ?? undefined,
      remoteMcpConfigDir: remoteMcpConfigDir ?? undefined,
      proxyMode: proxyMode ?? undefined,
      remoteServerUrl: remoteServerUrl ?? undefined,
    });
    // Clear cached proxy clients so they pick up new URL / mode / keys
    resetAllClients();
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

/** POST /api/agent-settings/test-connection — test remote proxy server connection */
agentSettingsRouter.post("/test-connection", async (req: Request, res: Response): Promise<void> => {
  const { url, alias } = req.body;
  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }

  try {
    const result = await testRemoteConnection(url, alias || "default");
    res.json(result);
  } catch (err: any) {
    log.error(`Error testing connection: ${err.message}`);
    res.status(500).json({ error: "Failed to test connection" });
  }
});
