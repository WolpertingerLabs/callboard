/**
 * Agent settings routes.
 *
 *   GET  /api/agent-settings                  — get current settings
 *   PUT  /api/agent-settings                  — update settings
 *   GET  /api/agent-settings/key-aliases      — discover key aliases from MCP config dir
 *   POST /api/agent-settings/test-connection  — test remote proxy connection
 *   GET  /api/agent-settings/tunnel-status    — get cloudflared tunnel status
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { getAgentSettings, updateAgentSettings, discoverKeyAliases } from "../services/agent-settings.js";
import { DEFAULT_MCP_LOCAL_DIR, DEFAULT_MCP_REMOTE_DIR } from "../utils/paths.js";
import { switchProxyMode } from "../services/proxy-singleton.js";
import { testRemoteConnection } from "../services/proxy-singleton.js";
import { getTunnelStatusFull } from "../services/tunnel-manager.js";
import { initSync, completeSync, cancelSync, SyncClientError } from "../services/sync-manager.js";
import { refreshSdkInfoCache } from "../services/sdk-info.js";
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
agentSettingsRouter.put("/", async (req: Request, res: Response): Promise<void> => {
  const {
    mcpConfigDir,
    localMcpConfigDir,
    remoteMcpConfigDir,
    proxyMode,
    remoteServerUrl,
    tunnelEnabled,
    apiBaseUrl,
    apiKey,
    authToken,
    model,
    defaultOpusModel,
    defaultSonnetModel,
    defaultHaikuModel,
    subagentModel,
  } = req.body;

  // Empty strings clear an override; undefined leaves the field untouched.
  const normalize = (v: unknown): string | undefined => (typeof v === "string" ? (v.trim() === "" ? undefined : v.trim()) : undefined);

  // Track whether any API / auth / model override field was included so we
  // know to refresh the SDK info cache (account + supported models).
  const apiFieldsTouched =
    apiBaseUrl !== undefined ||
    apiKey !== undefined ||
    authToken !== undefined ||
    model !== undefined ||
    defaultOpusModel !== undefined ||
    defaultSonnetModel !== undefined ||
    defaultHaikuModel !== undefined ||
    subagentModel !== undefined;

  try {
    const updated = updateAgentSettings({
      mcpConfigDir: mcpConfigDir ?? undefined,
      localMcpConfigDir: localMcpConfigDir ?? undefined,
      remoteMcpConfigDir: remoteMcpConfigDir ?? undefined,
      proxyMode: proxyMode ?? undefined,
      remoteServerUrl: remoteServerUrl ?? undefined,
      tunnelEnabled: tunnelEnabled ?? undefined,
      ...(apiBaseUrl !== undefined && { apiBaseUrl: normalize(apiBaseUrl) }),
      ...(apiKey !== undefined && { apiKey: normalize(apiKey) }),
      ...(authToken !== undefined && { authToken: normalize(authToken) }),
      ...(model !== undefined && { model: normalize(model) }),
      ...(defaultOpusModel !== undefined && { defaultOpusModel: normalize(defaultOpusModel) }),
      ...(defaultSonnetModel !== undefined && { defaultSonnetModel: normalize(defaultSonnetModel) }),
      ...(defaultHaikuModel !== undefined && { defaultHaikuModel: normalize(defaultHaikuModel) }),
      ...(subagentModel !== undefined && { subagentModel: normalize(subagentModel) }),
    });
    // Handle proxy mode switching — creates/destroys LocalProxy as needed
    // and resets cached remote ProxyClient instances
    await switchProxyMode(updated.proxyMode);
    if (apiFieldsTouched) {
      // Kick off a refresh so the About tab and any subsequent sessions see
      // the updated account / models. Don't await — the client gets back
      // quickly and the next poll of /api/system-info will pick it up.
      refreshSdkInfoCache().catch((err) => log.warn(`SDK info refresh failed: ${err.message}`));
    }
    res.json(updated);
  } catch (err: any) {
    log.error(`Error updating agent settings: ${err.message}`);
    res.status(500).json({ error: "Failed to update agent settings" });
  }
});

/** GET /api/agent-settings/key-aliases — discover available key aliases */
agentSettingsRouter.get("/key-aliases", (req: Request, res: Response): void => {
  try {
    const proxyMode = req.query.proxyMode as "local" | "remote" | undefined;
    const aliases = discoverKeyAliases(proxyMode);
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

/** GET /api/agent-settings/tunnel-status — get cloudflared tunnel status */
agentSettingsRouter.get("/tunnel-status", async (_req: Request, res: Response): Promise<void> => {
  try {
    const status = await getTunnelStatusFull();
    res.json(status);
  } catch (err: any) {
    log.error(`Error getting tunnel status: ${err.message}`);
    res.status(500).json({ error: "Failed to get tunnel status" });
  }
});

// ── Sync (key exchange) endpoints ────────────────────────────────────

/** POST /api/agent-settings/sync/start — initiate key exchange with a remote drawlatch server */
agentSettingsRouter.post("/sync/start", async (req: Request, res: Response): Promise<void> => {
  const { remoteUrl, inviteCode, encryptionKey, callerAlias } = req.body;
  if (!remoteUrl || !inviteCode || !encryptionKey || !callerAlias) {
    res.status(400).json({ error: "remoteUrl, inviteCode, encryptionKey, and callerAlias are required" });
    return;
  }

  try {
    const result = await initSync({ remoteUrl, inviteCode, encryptionKey, callerAlias });
    res.json(result);
  } catch (err: any) {
    log.error(`Error starting sync: ${err.message}`);
    res.status(500).json({ error: err.message || "Failed to start sync" });
  }
});

/** POST /api/agent-settings/sync/complete — complete the pending key exchange */
agentSettingsRouter.post("/sync/complete", async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await completeSync();
    res.json(result);
  } catch (err: any) {
    log.error(`Error completing sync: ${err.message}`);
    if (err instanceof SyncClientError) {
      const statusMap: Record<string, number> = {
        NO_ACTIVE_SESSION: 404,
        CODE_MISMATCH: 403,
        SESSION_EXPIRED: 410,
        ALREADY_COMPLETED: 409,
        DECRYPTION_FAILED: 400,
        INVALID_PAYLOAD: 400,
      };
      res.status(statusMap[err.code] || 502).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: err.message || "Failed to complete sync" });
  }
});

/** POST /api/agent-settings/sync/cancel — cancel a pending key exchange */
agentSettingsRouter.post("/sync/cancel", (_req: Request, res: Response): void => {
  cancelSync();
  res.json({ ok: true });
});
