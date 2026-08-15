/**
 * Agent settings routes.
 *
 *   GET  /api/agent-settings                  — get current settings
 *   PUT  /api/agent-settings                  — update settings
 *   GET  /api/agent-settings/key-aliases      — discover key aliases from MCP config dir
 *   POST /api/agent-settings/test-connection  — test remote proxy connection
 *   GET  /api/agent-settings/daemon-status    — drawlatch daemon URL/health/enrollment
 *   POST /api/agent-settings/import-bundle     — import a drawlatch caller credential bundle
 *   PUT  /api/agent-settings/default-caller    — set/clear the default caller for regular sessions
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type { ModelAlias } from "shared/types/index.js";
import { validateModelAliases } from "shared/types/index.js";
import {
  getAgentSettings,
  updateAgentSettings,
  discoverKeyAliases,
  listEnrolledCallers,
  deleteEnrolledCaller,
  setDefaultCaller,
} from "../services/agent-settings.js";
import { DEFAULT_MCP_LOCAL_DIR, DEFAULT_MCP_REMOTE_DIR } from "../utils/paths.js";
import { switchProxyMode, testRemoteConnection, getConfiguredAliases, resetAllClients, resetClient } from "../services/proxy-singleton.js";
import { CALLER_ALIAS_REGEX } from "@wolpertingerlabs/drawlatch/remote/caller-bootstrap";
import { getLocalDaemonStatus, fetchDaemonHealth } from "../services/local-daemon.js";
import { isPasswordConfigured } from "../auth.js";
import { getClientKey } from "../utils/client-ip.js";
import { parseAllowlist, validateAllowlistEntry, isIpAllowed, isPrivateOrLoopback } from "../utils/ip-allowlist.js";
import { startWebTunnel, stopWebTunnel, getWebTunnelStatus, isCloudflaredAvailable, resolveCallboardPort } from "../services/web-tunnel.js";
import { importBundle, BundleImportError } from "../services/bundle-import.js";
import { refreshSdkInfoCache } from "../services/sdk-info.js";
import { refreshCodexModelsCache } from "../services/codex-models.js";
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
    proxyMode,
    remoteServerUrl,
    tunnelEnabled,
    remoteAccessEnabled,
    remoteAccessMode,
    cloudflaredToken,
    remoteAccessHostname,
    remoteAccessIpAllowlist,
    apiBaseUrl,
    apiKey,
    authToken,
    model,
    defaultOpusModel,
    defaultSonnetModel,
    defaultHaikuModel,
    subagentModel,
    claudeCodeUseOpenRouter,
    claudeCodeOpenRouterApiKey,
    claudeCodeOpenRouterBaseUrl,
    claudeCodeOpenRouterModel,
    claudeCodeOpenRouterOpusModel,
    claudeCodeOpenRouterSonnetModel,
    claudeCodeOpenRouterHaikuModel,
    claudeCodeOpenRouterSubagentModel,
    openRouterApiKey,
    openRouterBaseUrl,
    openRouterUtilityCompletions,
    openRouterUtilityHaikuModel,
    openRouterUtilitySonnetModel,
    openRouterUtilityOpusModel,
    openRouterModelAliases,
    modelAliases,
    codexAuthMode,
    codexApiKey,
    codexBaseUrl,
    codexModel,
    codexHome,
    codexSandboxMode,
    codexUseOpenRouter,
    codexOpenRouterApiKey,
    acpUseOpenRouter,
    acpOpenRouterApiKey,
    codexOpenRouterBaseUrl,
    codexOpenRouterModel,
    clineProviderId,
    clineModel,
    clineApiKey,
    clineBaseUrl,
    clineMaxIterations,
    piProviderId,
    piModel,
    piApiKey,
    piBaseUrl,
    maxCallbackChainDepth,
    maxPendingCallbacks,
  } = req.body;

  // Empty strings clear an override; undefined leaves the field untouched.
  const normalize = (v: unknown): string | undefined => (typeof v === "string" ? (v.trim() === "" ? undefined : v.trim()) : undefined);

  // Numeric counterpart — accepts numbers or numeric strings, clears on
  // empty or non-finite input (NaN, Infinity). Negative inputs are clamped
  // to 0 rather than 400ing: every consumer treats 0 as a meaningful floor.
  const normalizeNumber = (v: unknown): number | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "string" && v.trim() === "") return undefined;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(0, n);
  };

  // Non-negative integer counterpart for callback loop-safety caps.
  const normalizeCount = (v: unknown): number | undefined => {
    const n = normalizeNumber(v);
    return n === undefined ? undefined : Math.floor(n);
  };

  // Boolean toggle — coerces truthy/falsey; `false` is preserved (clears the
  // flag) so a deliberate "off" persists rather than leaving a stale `true`.
  const normalizeBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

  // Sanitize the OpenRouter model alias map. Returns undefined when the map
  // ends up empty (clears the setting), or a string error for invalid input
  // the user must fix (the UI surfaces it inline).
  const normalizeAliases = (v: unknown): { aliases?: Record<string, string>; error?: string } => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return { error: "openRouterModelAliases must be an object mapping alias names to model slugs" };
    }
    const aliases: Record<string, string> = {};
    const seenNames = new Set<string>();
    for (const [rawAlias, rawTarget] of Object.entries(v)) {
      const alias = rawAlias.trim();
      const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
      if (!alias || !target) continue; // blank rows are dropped, not errors
      const key = alias.toLowerCase();
      if (seenNames.has(key)) {
        return { error: `Duplicate alias name (case-insensitive): "${alias}"` };
      }
      seenNames.add(key);
      aliases[alias] = target;
    }
    // Resolution is intentionally one hop — an alias pointing at another
    // alias would either chain or cycle, so reject it at write time.
    for (const [alias, target] of Object.entries(aliases)) {
      if (seenNames.has(target.toLowerCase())) {
        return { error: `Alias "${alias}" points to another alias ("${target}") — targets must be real model slugs` };
      }
    }
    return { aliases: Object.keys(aliases).length > 0 ? aliases : undefined };
  };

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
    subagentModel !== undefined ||
    claudeCodeUseOpenRouter !== undefined ||
    claudeCodeOpenRouterApiKey !== undefined ||
    claudeCodeOpenRouterBaseUrl !== undefined ||
    claudeCodeOpenRouterModel !== undefined ||
    claudeCodeOpenRouterOpusModel !== undefined ||
    claudeCodeOpenRouterSonnetModel !== undefined ||
    claudeCodeOpenRouterHaikuModel !== undefined ||
    claudeCodeOpenRouterSubagentModel !== undefined;

  const codexFieldsTouched =
    codexAuthMode !== undefined ||
    codexApiKey !== undefined ||
    codexBaseUrl !== undefined ||
    codexHome !== undefined ||
    codexUseOpenRouter !== undefined ||
    codexOpenRouterApiKey !== undefined ||
    acpUseOpenRouter !== undefined ||
    acpOpenRouterApiKey !== undefined ||
    codexOpenRouterBaseUrl !== undefined ||
    codexOpenRouterModel !== undefined ||
    clineProviderId !== undefined ||
    clineModel !== undefined ||
    clineApiKey !== undefined ||
    clineBaseUrl !== undefined ||
    clineMaxIterations !== undefined;

  // Validate the alias map up front so bad input 400s before anything is written.
  let normalizedAliases: Record<string, string> | undefined;
  if (openRouterModelAliases !== undefined) {
    const result = normalizeAliases(openRouterModelAliases);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    normalizedAliases = result.aliases;
  }

  let normalizedModelAliases: ModelAlias[] | undefined;
  if (modelAliases !== undefined) {
    const { value, errors } = validateModelAliases(modelAliases);
    if (errors.length > 0) {
      res.status(400).json({ error: errors.join("; ") });
      return;
    }
    normalizedModelAliases = value.length > 0 ? value : undefined;
  }

  // Codex enum fields — validate against the allowed values; an unrecognized
  // value clears the override (falls back to the default at consume time).
  const normalizeCodexAuthMode = (v: unknown): "subscription" | "api-key" | undefined => (v === "subscription" || v === "api-key" ? v : undefined);
  const normalizeCodexSandboxMode = (v: unknown): "read-only" | "workspace-write" | "danger-full-access" | undefined =>
    v === "read-only" || v === "workspace-write" || v === "danger-full-access" ? v : undefined;

  const normalizeRemoteMode = (v: unknown): "quick" | "named" | undefined => (v === "quick" || v === "named" ? v : undefined);

  // Proxy mode is a closed enum — anything else clears the override (which
  // reads back as "local", the documented default).
  const normalizeProxyMode = (v: unknown): "local" | "remote" | undefined => (v === "local" || v === "remote" ? v : undefined);

  // ── Remote-access (public tunnel) gate ───────────────────────────────
  // Enabling exposes callboard to the internet — the login password becomes the
  // only barrier. Block the enable if no password is configured (the UI mirrors
  // this, but the server is the real gate). Only fires when the request itself
  // asks to enable; unrelated saves while already-enabled are untouched.
  const remoteFieldsTouched =
    remoteAccessEnabled !== undefined || remoteAccessMode !== undefined || cloudflaredToken !== undefined || remoteAccessHostname !== undefined;
  if (remoteAccessEnabled === true && !isPasswordConfigured()) {
    res.status(400).json({
      error: "Set a login password before enabling remote access — it makes callboard reachable from the public internet.",
    });
    return;
  }

  // ── Remote-access IP allowlist ───────────────────────────────────────
  // Validate entries and guard against a remote saver locking themselves out.
  // Local/LAN savers are exempt (they're never gated by the allowlist anyway).
  let normalizedAllowlist: string[] | undefined;
  if (remoteAccessIpAllowlist !== undefined) {
    normalizedAllowlist = parseAllowlist(remoteAccessIpAllowlist);
    const bad = normalizedAllowlist.find((e) => !validateAllowlistEntry(e));
    if (bad) {
      res.status(400).json({ error: `Invalid IP or CIDR in allowlist: "${bad}"` });
      return;
    }
    const saverIp = getClientKey(req);
    if (normalizedAllowlist.length > 0 && !isPrivateOrLoopback(saverIp) && !isIpAllowed(saverIp, normalizedAllowlist)) {
      res.status(400).json({ error: `Add your current IP (${saverIp}) to the allowlist before saving, or you'll lose access through the tunnel.` });
      return;
    }
  }

  try {
    const before = getAgentSettings();
    const updated = updateAgentSettings({
      // These three MUST stay behind the `!== undefined` guard like every other
      // field: updateAgentSettings merges with a spread, so an explicit
      // `undefined` overwrites the stored value and JSON.stringify then drops
      // the key entirely. Passing them unconditionally meant every save from an
      // unrelated settings tab (API keys, model aliases, remote access…) erased
      // the drawlatch endpoint and silently reverted the daemon to local mode.
      ...(proxyMode !== undefined && { proxyMode: normalizeProxyMode(proxyMode) }),
      ...(remoteServerUrl !== undefined && { remoteServerUrl: normalize(remoteServerUrl) }),
      ...(tunnelEnabled !== undefined && { tunnelEnabled: normalizeBool(tunnelEnabled) }),
      ...(remoteAccessEnabled !== undefined && { remoteAccessEnabled: typeof remoteAccessEnabled === "boolean" ? remoteAccessEnabled : undefined }),
      ...(remoteAccessMode !== undefined && { remoteAccessMode: normalizeRemoteMode(remoteAccessMode) }),
      ...(cloudflaredToken !== undefined && { cloudflaredToken: normalize(cloudflaredToken) }),
      ...(remoteAccessHostname !== undefined && { remoteAccessHostname: normalize(remoteAccessHostname) }),
      ...(remoteAccessIpAllowlist !== undefined && { remoteAccessIpAllowlist: normalizedAllowlist }),
      ...(apiBaseUrl !== undefined && { apiBaseUrl: normalize(apiBaseUrl) }),
      ...(apiKey !== undefined && { apiKey: normalize(apiKey) }),
      ...(authToken !== undefined && { authToken: normalize(authToken) }),
      ...(model !== undefined && { model: normalize(model) }),
      ...(defaultOpusModel !== undefined && { defaultOpusModel: normalize(defaultOpusModel) }),
      ...(defaultSonnetModel !== undefined && { defaultSonnetModel: normalize(defaultSonnetModel) }),
      ...(defaultHaikuModel !== undefined && { defaultHaikuModel: normalize(defaultHaikuModel) }),
      ...(subagentModel !== undefined && { subagentModel: normalize(subagentModel) }),
      ...(claudeCodeUseOpenRouter !== undefined && { claudeCodeUseOpenRouter: normalizeBool(claudeCodeUseOpenRouter) }),
      ...(claudeCodeOpenRouterApiKey !== undefined && { claudeCodeOpenRouterApiKey: normalize(claudeCodeOpenRouterApiKey) }),
      ...(claudeCodeOpenRouterBaseUrl !== undefined && { claudeCodeOpenRouterBaseUrl: normalize(claudeCodeOpenRouterBaseUrl) }),
      ...(claudeCodeOpenRouterModel !== undefined && { claudeCodeOpenRouterModel: normalize(claudeCodeOpenRouterModel) }),
      ...(claudeCodeOpenRouterOpusModel !== undefined && { claudeCodeOpenRouterOpusModel: normalize(claudeCodeOpenRouterOpusModel) }),
      ...(claudeCodeOpenRouterSonnetModel !== undefined && { claudeCodeOpenRouterSonnetModel: normalize(claudeCodeOpenRouterSonnetModel) }),
      ...(claudeCodeOpenRouterHaikuModel !== undefined && { claudeCodeOpenRouterHaikuModel: normalize(claudeCodeOpenRouterHaikuModel) }),
      ...(claudeCodeOpenRouterSubagentModel !== undefined && { claudeCodeOpenRouterSubagentModel: normalize(claudeCodeOpenRouterSubagentModel) }),
      ...(openRouterApiKey !== undefined && { openRouterApiKey: normalize(openRouterApiKey) }),
      ...(openRouterBaseUrl !== undefined && { openRouterBaseUrl: normalize(openRouterBaseUrl) }),
      ...(openRouterUtilityCompletions !== undefined && { openRouterUtilityCompletions: normalizeBool(openRouterUtilityCompletions) }),
      ...(openRouterUtilityHaikuModel !== undefined && { openRouterUtilityHaikuModel: normalize(openRouterUtilityHaikuModel) }),
      ...(openRouterUtilitySonnetModel !== undefined && { openRouterUtilitySonnetModel: normalize(openRouterUtilitySonnetModel) }),
      ...(openRouterUtilityOpusModel !== undefined && { openRouterUtilityOpusModel: normalize(openRouterUtilityOpusModel) }),
      ...(openRouterModelAliases !== undefined && { openRouterModelAliases: normalizedAliases }),
      // Writing the unified registry retires the deprecated OR-only map (its
      // entries are already folded into the openrouter targets on load). Skip
      // the retire if the same request also explicitly set the legacy map.
      ...(modelAliases !== undefined && {
        modelAliases: normalizedModelAliases,
        ...(openRouterModelAliases === undefined && { openRouterModelAliases: undefined }),
      }),
      ...(codexAuthMode !== undefined && { codexAuthMode: normalizeCodexAuthMode(codexAuthMode) }),
      ...(codexApiKey !== undefined && { codexApiKey: normalize(codexApiKey) }),
      ...(codexBaseUrl !== undefined && { codexBaseUrl: normalize(codexBaseUrl) }),
      ...(codexModel !== undefined && { codexModel: normalize(codexModel) }),
      ...(codexHome !== undefined && { codexHome: normalize(codexHome) }),
      ...(codexSandboxMode !== undefined && { codexSandboxMode: normalizeCodexSandboxMode(codexSandboxMode) }),
      ...(codexUseOpenRouter !== undefined && { codexUseOpenRouter: normalizeBool(codexUseOpenRouter) }),
      ...(codexOpenRouterApiKey !== undefined && { codexOpenRouterApiKey: normalize(codexOpenRouterApiKey) }),
      ...(acpUseOpenRouter !== undefined && { acpUseOpenRouter: normalizeBool(acpUseOpenRouter) }),
      ...(acpOpenRouterApiKey !== undefined && { acpOpenRouterApiKey: normalize(acpOpenRouterApiKey) }),
      ...(codexOpenRouterBaseUrl !== undefined && { codexOpenRouterBaseUrl: normalize(codexOpenRouterBaseUrl) }),
      ...(codexOpenRouterModel !== undefined && { codexOpenRouterModel: normalize(codexOpenRouterModel) }),
      ...(clineProviderId !== undefined && { clineProviderId: normalize(clineProviderId) }),
      ...(clineModel !== undefined && { clineModel: normalize(clineModel) }),
      ...(clineApiKey !== undefined && { clineApiKey: normalize(clineApiKey) }),
      ...(clineBaseUrl !== undefined && { clineBaseUrl: normalize(clineBaseUrl) }),
      ...(clineMaxIterations !== undefined && { clineMaxIterations: normalizeCount(clineMaxIterations) }),
      // pi's credentials live here and nowhere else. Omitting these silently
      // drops the key the Settings form sent, and the pi block in claude.ts
      // then starts a session with no `apiKey` — pi falls through to its own
      // auth.json / $OPENROUTER_API_KEY lookup and ends the turn with
      // "No API key found for openrouter" before a single token streams.
      ...(piProviderId !== undefined && { piProviderId: normalize(piProviderId) }),
      ...(piModel !== undefined && { piModel: normalize(piModel) }),
      ...(piApiKey !== undefined && { piApiKey: normalize(piApiKey) }),
      ...(piBaseUrl !== undefined && { piBaseUrl: normalize(piBaseUrl) }),
      ...(maxCallbackChainDepth !== undefined && { maxCallbackChainDepth: normalizeCount(maxCallbackChainDepth) }),
      ...(maxPendingCallbacks !== undefined && { maxPendingCallbacks: normalizeCount(maxPendingCallbacks) }),
    });
    // Handle proxy mode switching — creates/destroys LocalProxy as needed and
    // resets cached ProxyClient instances. Only when the endpoint actually
    // moved: an unrelated settings save should never bounce the daemon or drop
    // the route cache.
    if (updated.proxyMode !== before.proxyMode || updated.remoteServerUrl !== before.remoteServerUrl) {
      await switchProxyMode(updated.proxyMode);
    }

    // Apply remote-access tunnel changes live (only when a relevant field was
    // touched, so an unrelated settings save never tears down a healthy tunnel).
    if (remoteFieldsTouched) {
      if (updated.remoteAccessEnabled) {
        // Fire-and-forget: quick tunnels can take several seconds to surface a
        // URL. The client polls /remote-access-status for the result.
        void startWebTunnel({
          port: resolveCallboardPort(),
          host: "127.0.0.1",
          mode: updated.remoteAccessMode === "named" ? "named" : "quick",
          token: updated.cloudflaredToken,
          hostname: updated.remoteAccessHostname,
        }).catch((err) => log.error(`Remote-access tunnel start failed: ${err.message}`));
      } else {
        await stopWebTunnel().catch((err) => log.error(`Remote-access tunnel stop failed: ${err.message}`));
      }
    }
    if (apiFieldsTouched) {
      // Kick off a refresh so the About tab and any subsequent sessions see
      // the updated account / models. Don't await — the client gets back
      // quickly and the next poll of /api/system-info will pick it up.
      refreshSdkInfoCache().catch((err) => log.warn(`SDK info refresh failed: ${err.message}`));
    }
    if (codexFieldsTouched) {
      // Codex's live catalog is tied to the configured auth/home env. Refresh
      // after settings writes so subsequent pickers/tool calls see the new view.
      refreshCodexModelsCache().catch((err) => log.warn(`Codex model refresh failed: ${err.message}`));
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

  // Pick the caller to authenticate the test handshake with: the explicitly
  // requested alias, otherwise the first remote-enrolled caller. We never fall
  // back to a hardcoded "default" — a connection test should exercise a real,
  // imported credential (or tell the user there isn't one yet).
  let testAlias = typeof alias === "string" && alias.trim() ? alias.trim() : undefined;
  if (!testAlias) {
    testAlias = discoverKeyAliases("remote")
      .filter((a) => a.hasSigningPub && a.hasExchangePub)
      .map((a) => a.alias)[0];
  }
  if (!testAlias) {
    res.status(400).json({ error: "No enrolled caller to test with — import a caller bundle first." });
    return;
  }

  try {
    const result = await testRemoteConnection(url, testAlias);
    res.json(result);
  } catch (err: any) {
    log.error(`Error testing connection: ${err.message}`);
    res.status(500).json({ error: "Failed to test connection" });
  }
});

/**
 * GET /api/agent-settings/daemon-status — drawlatch daemon connectivity.
 *
 * Reports the endpoint URL, whether it's reachable (/health), whether callboard
 * supervises it (managed-local), and the dashboard URL to deep-link into.
 * Connection/secret/listener management all live in that dashboard now.
 */
agentSettingsRouter.get("/daemon-status", async (_req: Request, res: Response): Promise<void> => {
  try {
    const settings = getAgentSettings();
    const mode = settings.proxyMode === "remote" ? "remote" : "local";

    if (mode === "remote") {
      const url = settings.remoteServerUrl;
      const health = url ? await fetchDaemonHealth(url, 3000) : null;
      res.json({
        mode,
        url: url ?? null,
        managed: false,
        reachable: health !== null,
        health,
        dashboardUrl: url ?? null,
        enrolledAliases: getConfiguredAliases(),
      });
      return;
    }

    const status = await getLocalDaemonStatus();
    res.json({
      mode,
      url: status.url,
      managed: status.managed,
      reachable: status.health !== null,
      health: status.health,
      ...(status.pid ? { pid: status.pid } : {}),
      dashboardUrl: status.url,
      enrolledAliases: getConfiguredAliases(),
    });
  } catch (err: any) {
    log.error(`Error getting daemon status: ${err.message}`);
    res.status(500).json({ error: "Failed to get daemon status" });
  }
});

/**
 * GET /api/agent-settings/remote-access-status — public-tunnel status.
 *
 * Reports whether the cloudflared remote-access tunnel is up, its public URL,
 * and whether the `cloudflared` binary is installed (refreshed here so the UI
 * can show the install hint before the tunnel is ever started). Distinct from
 * /daemon-status, which reports the drawlatch webhook daemon.
 */
agentSettingsRouter.get("/remote-access-status", async (req: Request, res: Response): Promise<void> => {
  try {
    const status = getWebTunnelStatus();
    if (status.available === null) {
      status.available = await isCloudflaredAvailable();
    }
    // callerIp lets the allowlist UI offer an "Add my IP" shortcut. Behind the
    // tunnel this is the real remote client (CF-Connecting-IP); locally it's the
    // socket address. See utils/client-ip.ts.
    res.json({ ...status, callerIp: getClientKey(req) });
  } catch (err: any) {
    log.error(`Error getting remote-access status: ${err.message}`);
    res.status(500).json({ error: "Failed to get remote-access status" });
  }
});

/**
 * GET /api/agent-settings/callers — enrolled callers for the proxy management panel.
 *
 * Each caller is enriched with its fingerprint (recomputed from the stored
 * public keys) and the agents bound to it, so the UI can show what each alias
 * is and block deletion of in-use credentials. Mode defaults to the active one;
 * pass ?proxyMode=remote to inspect a specific key store.
 */
agentSettingsRouter.get("/callers", (req: Request, res: Response): void => {
  try {
    const proxyMode = req.query.proxyMode === "remote" || req.query.proxyMode === "local" ? req.query.proxyMode : undefined;
    res.json({ callers: listEnrolledCallers(proxyMode) });
  } catch (err: any) {
    log.error(`Error listing enrolled callers: ${err.message}`);
    res.status(500).json({ error: "Failed to list enrolled callers" });
  }
});

/**
 * DELETE /api/agent-settings/callers/:alias — remove an enrolled caller.
 *
 * Refuses (409) when one or more agents are bound to the caller — deletion is
 * gated on zero associated agents. On success the caller's key dir is removed
 * and its cached proxy client is dropped. Mode defaults to the active one.
 */
agentSettingsRouter.delete("/callers/:alias", (req: Request, res: Response): void => {
  const { alias } = req.params;
  if (!CALLER_ALIAS_REGEX.test(alias)) {
    res.status(400).json({ error: "Invalid caller alias" });
    return;
  }
  const proxyMode = req.query.proxyMode === "remote" || req.query.proxyMode === "local" ? req.query.proxyMode : undefined;

  try {
    const result = deleteEnrolledCaller(alias, proxyMode);
    if (result.status === "not_found") {
      res.status(404).json({ error: `No enrolled caller "${alias}"` });
      return;
    }
    if (result.status === "in_use") {
      res.status(409).json({
        error: `Caller "${alias}" is in use by ${result.agents?.length ?? 0} agent(s). Reassign them before deleting.`,
        agents: result.agents,
      });
      return;
    }
    resetClient(alias);
    res.json({ status: "deleted", alias });
  } catch (err: any) {
    log.error(`Error deleting enrolled caller "${alias}": ${err.message}`);
    res.status(500).json({ error: "Failed to delete enrolled caller" });
  }
});

/**
 * PUT /api/agent-settings/default-caller — set/clear the default caller.
 *
 * Regular (non-agent) sessions borrow this caller for their drawlatch identity.
 * Body: { alias: string | null } — a caller alias to make default, or null/""
 * to explicitly clear it (regular sessions then get no proxy access). Mode
 * defaults to the active one; pass ?proxyMode=remote to target a key store.
 * Rejects (404) when a non-empty alias is not an enrolled caller.
 */
agentSettingsRouter.put("/default-caller", (req: Request, res: Response): void => {
  const { alias } = req.body ?? {};
  if (alias !== null && alias !== undefined && typeof alias !== "string") {
    res.status(400).json({ error: "alias must be a string or null" });
    return;
  }
  if (typeof alias === "string" && alias !== "" && !CALLER_ALIAS_REGEX.test(alias)) {
    res.status(400).json({ error: "Invalid caller alias" });
    return;
  }
  const proxyMode = req.query.proxyMode === "remote" || req.query.proxyMode === "local" ? req.query.proxyMode : undefined;

  try {
    setDefaultCaller(alias ?? null, proxyMode);
    res.json({ status: "ok", alias: alias || null });
  } catch (err: any) {
    // setDefaultCaller throws when the alias isn't an enrolled caller.
    res.status(404).json({ error: err.message || "Failed to set default caller" });
  }
});

/**
 * POST /api/agent-settings/import-bundle — import a drawlatch caller credential bundle.
 *
 * drawlatch issues `{alias}.drawlatch-caller.json` bundles (the AWS IAM
 * access-key model — the keypair is a capability minted to access drawlatch).
 * The bundle pins one endpoint + one server key; callboard confirms the server
 * key with the user (in the UI, before this route is hit) then unpacks the key
 * files into the active config dir. The bundle's endpoint is intentionally NOT
 * applied as `remoteServerUrl` for now — cloudflared endpoints are ephemeral, so
 * the user sets the Server URL manually (see the disabled pin below).
 *
 * Body: { bundle: object, passphrase?: string }. The passphrase is required
 * only when the bundle's private keys are passphrase-wrapped (422 otherwise).
 */
agentSettingsRouter.post("/import-bundle", async (req: Request, res: Response): Promise<void> => {
  const { bundle, passphrase } = req.body ?? {};
  if (bundle === undefined || bundle === null) {
    res.status(400).json({ error: "bundle is required" });
    return;
  }

  try {
    // Unpack + validate (decrypts wrapped private keys when a passphrase is given).
    const result = importBundle(bundle, typeof passphrase === "string" ? passphrase : undefined);

    // Endpoint-from-bundle pinning is DISABLED for now. cloudflared tunnel URLs
    // for callboard<->drawlatch connections are ephemeral and not guaranteed to
    // persist across machines/restarts, so we don't auto-pin the bundle's
    // endpoint as `remoteServerUrl` — the user sets the Server URL manually in
    // Proxy Settings. The bundle still carries `endpointUrl` (and server-key
    // pinning still happens via the imported key files); we just ignore it here.
    // Re-enable once endpoints are stable/long-lived:
    // updateAgentSettings({ remoteServerUrl: result.endpointUrl });

    // Refresh the ProxyClient singleton so the new alias + endpoint are picked
    // up immediately (the next getProxy() re-scans discoverKeyAliases()).
    resetAllClients();

    const aliases = discoverKeyAliases();
    res.json({
      alias: result.alias,
      fingerprint: result.fingerprint,
      serverKeyFingerprint: result.serverKeyFingerprint,
      endpointUrl: result.endpointUrl,
      aliases,
    });
  } catch (err: any) {
    if (err instanceof BundleImportError) {
      // Validation / passphrase errors are user-facing — surface the message.
      res.status(err.status).json({ error: err.message });
      return;
    }
    log.error(`Error importing caller bundle: ${err.message}`);
    res.status(500).json({ error: "Failed to import caller bundle" });
  }
});
