/**
 * Agent settings routes.
 *
 *   GET  /api/agent-settings                  — get current settings
 *   PUT  /api/agent-settings                  — update settings
 *   GET  /api/agent-settings/key-aliases      — discover key aliases from MCP config dir
 *   POST /api/agent-settings/test-connection  — test remote proxy connection
 *   GET  /api/agent-settings/daemon-status    — drawlatch daemon URL/health/enrollment
 *   POST /api/agent-settings/import-bundle     — import a drawlatch caller credential bundle
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type { OpenRouterServerToolConfig, OpenRouterParamProfile } from "shared/types/index.js";
import { validateServerTools, validateParamProfile } from "shared/types/index.js";
import { getAgentSettings, updateAgentSettings, discoverKeyAliases, listEnrolledCallers, deleteEnrolledCaller } from "../services/agent-settings.js";
import { DEFAULT_MCP_LOCAL_DIR, DEFAULT_MCP_REMOTE_DIR } from "../utils/paths.js";
import { switchProxyMode, testRemoteConnection, getConfiguredAliases, resetAllClients, resetClient } from "../services/proxy-singleton.js";
import { CALLER_ALIAS_REGEX } from "@wolpertingerlabs/drawlatch/remote/caller-bootstrap";
import { getLocalDaemonStatus, fetchDaemonHealth } from "../services/local-daemon.js";
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
    apiBaseUrl,
    apiKey,
    authToken,
    model,
    defaultOpusModel,
    defaultSonnetModel,
    defaultHaikuModel,
    subagentModel,
    openRouterApiKey,
    openRouterBaseUrl,
    openRouterModel,
    openRouterLogsRoot,
    openRouterMaxBudgetUsd,
    openRouterModelAliases,
    openRouterServerTools,
    openRouterModelParamsDefault,
    openRouterModelParamProfiles,
    codexAuthMode,
    codexApiKey,
    codexBaseUrl,
    codexModel,
    codexHome,
    codexSandboxMode,
    maxCallbackChainDepth,
    maxPendingCallbacks,
  } = req.body;

  // Empty strings clear an override; undefined leaves the field untouched.
  const normalize = (v: unknown): string | undefined => (typeof v === "string" ? (v.trim() === "" ? undefined : v.trim()) : undefined);

  // Numeric counterpart — accepts numbers or numeric strings, clears on
  // empty or non-finite input (NaN, Infinity). Negative inputs are clamped
  // to 0, which the OR library treats as "stop immediately" (a useful
  // boundary condition for a kill-switch rather than a 400).
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
    subagentModel !== undefined;

  const codexFieldsTouched = codexAuthMode !== undefined || codexApiKey !== undefined || codexBaseUrl !== undefined || codexHome !== undefined;

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

  // Validate the OpenRouter server-tools list. An explicit empty array is
  // meaningful ("disable all server tools") and must be preserved — only an
  // absent field leaves the setting untouched, so this stays in the
  // conditional spread below rather than coercing [] to undefined.
  let normalizedServerTools: OpenRouterServerToolConfig[] | undefined;
  if (openRouterServerTools !== undefined) {
    if (!Array.isArray(openRouterServerTools)) {
      res.status(400).json({ error: "openRouterServerTools must be an array of server-tool configs" });
      return;
    }
    const { value, errors } = validateServerTools(openRouterServerTools);
    if (errors.length > 0) {
      res.status(400).json({ error: errors.join("; ") });
      return;
    }
    normalizedServerTools = value;
  }

  // Validate the global model-param default profile. An empty validated
  // profile ({}) clears the override (persisted as undefined).
  let normalizedParamsDefault: OpenRouterParamProfile | undefined;
  if (openRouterModelParamsDefault !== undefined) {
    const { value, errors } = validateParamProfile(openRouterModelParamsDefault);
    if (errors.length > 0) {
      res.status(400).json({ error: errors.join("; ") });
      return;
    }
    normalizedParamsDefault = Object.keys(value).length > 0 ? value : undefined;
  }

  // Validate each per-model param profile, prefixing errors with the slug.
  // Slugs whose validated profile is empty are dropped; an all-empty record
  // clears the setting (persisted as undefined).
  let normalizedParamProfiles: Record<string, OpenRouterParamProfile> | undefined;
  if (openRouterModelParamProfiles !== undefined) {
    if (typeof openRouterModelParamProfiles !== "object" || openRouterModelParamProfiles === null || Array.isArray(openRouterModelParamProfiles)) {
      res.status(400).json({ error: "openRouterModelParamProfiles must be an object mapping model slugs to param profiles" });
      return;
    }
    const cleaned: Record<string, OpenRouterParamProfile> = {};
    const errors: string[] = [];
    for (const [slug, profile] of Object.entries(openRouterModelParamProfiles as Record<string, OpenRouterParamProfile>)) {
      const { value, errors: pErrors } = validateParamProfile(profile);
      errors.push(...pErrors.map((e) => `${slug}: ${e}`));
      if (Object.keys(value).length > 0) cleaned[slug] = value;
    }
    if (errors.length > 0) {
      res.status(400).json({ error: errors.join("; ") });
      return;
    }
    normalizedParamProfiles = Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  // Codex enum fields — validate against the allowed values; an unrecognized
  // value clears the override (falls back to the default at consume time).
  const normalizeCodexAuthMode = (v: unknown): "subscription" | "api-key" | undefined => (v === "subscription" || v === "api-key" ? v : undefined);
  const normalizeCodexSandboxMode = (v: unknown): "read-only" | "workspace-write" | "danger-full-access" | undefined =>
    v === "read-only" || v === "workspace-write" || v === "danger-full-access" ? v : undefined;

  try {
    const updated = updateAgentSettings({
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
      ...(openRouterApiKey !== undefined && { openRouterApiKey: normalize(openRouterApiKey) }),
      ...(openRouterBaseUrl !== undefined && { openRouterBaseUrl: normalize(openRouterBaseUrl) }),
      ...(openRouterModel !== undefined && { openRouterModel: normalize(openRouterModel) }),
      ...(openRouterLogsRoot !== undefined && { openRouterLogsRoot: normalize(openRouterLogsRoot) }),
      ...(openRouterMaxBudgetUsd !== undefined && { openRouterMaxBudgetUsd: normalizeNumber(openRouterMaxBudgetUsd) }),
      ...(openRouterModelAliases !== undefined && { openRouterModelAliases: normalizedAliases }),
      ...(openRouterServerTools !== undefined && { openRouterServerTools: normalizedServerTools }),
      ...(openRouterModelParamsDefault !== undefined && { openRouterModelParamsDefault: normalizedParamsDefault }),
      ...(openRouterModelParamProfiles !== undefined && { openRouterModelParamProfiles: normalizedParamProfiles }),
      ...(codexAuthMode !== undefined && { codexAuthMode: normalizeCodexAuthMode(codexAuthMode) }),
      ...(codexApiKey !== undefined && { codexApiKey: normalize(codexApiKey) }),
      ...(codexBaseUrl !== undefined && { codexBaseUrl: normalize(codexBaseUrl) }),
      ...(codexModel !== undefined && { codexModel: normalize(codexModel) }),
      ...(codexHome !== undefined && { codexHome: normalize(codexHome) }),
      ...(codexSandboxMode !== undefined && { codexSandboxMode: normalizeCodexSandboxMode(codexSandboxMode) }),
      ...(maxCallbackChainDepth !== undefined && { maxCallbackChainDepth: normalizeCount(maxCallbackChainDepth) }),
      ...(maxPendingCallbacks !== undefined && { maxPendingCallbacks: normalizeCount(maxPendingCallbacks) }),
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
