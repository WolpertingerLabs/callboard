/**
 * Agent settings routes.
 *
 *   GET  /api/agent-settings                  — get current settings
 *   PUT  /api/agent-settings                  — update settings
 *   GET   /api/agent-settings/favorites       — the two favorites lists, and nothing else
 *   PUT   /api/agent-settings/favorites       — replace the two favorites lists
 *   PATCH /api/agent-settings/favorites       — add/remove ids against the stored lists
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
import { getClientKey, isDirectLocalClient } from "../utils/client-ip.js";
import { parseAllowlist, validateAllowlistEntry, isIpAllowed, isPrivateOrLoopback } from "../utils/ip-allowlist.js";
import { startWebTunnel, stopWebTunnel, getWebTunnelStatus, isCloudflaredAvailable, resolveCallboardPort } from "../services/web-tunnel.js";
import { importBundle, BundleImportError } from "../services/bundle-import.js";
import { refreshSdkInfoCache } from "../services/sdk-info.js";
import { resetEngineProbeCaches } from "../services/engine-status.js";
import { refreshCodexModelsCache } from "../services/codex-models.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent-settings-routes");

export const agentSettingsRouter = Router();

/**
 * Sanitize an ordered id list (the favorites). Trims, drops blanks and
 * later duplicates, and collapses an emptied list to `undefined` so
 * un-starring the last entry clears the setting rather than persisting `[]`.
 *
 * Non-array input yields `undefined` too, but every call site guards on
 * `Array.isArray` rather than `!== undefined` — otherwise a malformed body
 * would be indistinguishable from `[]` and would wipe the user's favorites.
 * Same reasoning as `unpinChatsOnArchive`'s `typeof === "boolean"` guard: when
 * clearing is a real outcome, only a well-formed value may ask for it.
 *
 * Order is preserved because order is the data: these lists ARE the display
 * order on the New Chat launchpad.
 *
 * Module-scope rather than local to the main PUT because the narrow
 * `/favorites` pair below must write these fields by exactly the same rules —
 * two normalizers would be two chances for them to drift apart.
 */
function normalizeIdList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > 0 ? out : undefined;
}

/** One side of a favorites PATCH: ids to append, ids to drop. */
interface IdDelta {
  add: string[];
  remove: string[];
}

/**
 * Read one side's delta out of a PATCH body, or `undefined` when the request
 * did not ask to change that side.
 *
 * Deliberately lenient about the *contents* and strict about the *shape*, on
 * the same reasoning as `normalizeIdList`: a non-object (or an object with no
 * usable ids) means "change nothing here", because the alternative is a
 * malformed request being indistinguishable from a deliberate edit. Within a
 * well-formed delta, non-strings and blanks are dropped rather than rejected —
 * they cannot destroy anything, since a delta only ever names what it touches.
 */
function normalizeDelta(v: unknown): IdDelta | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const ids = (raw: unknown): string[] =>
    Array.isArray(raw)
      ? raw
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
  const { add, remove } = v as { add?: unknown; remove?: unknown };
  const delta = { add: ids(add), remove: ids(remove) };
  return delta.add.length === 0 && delta.remove.length === 0 ? undefined : delta;
}

/**
 * Apply a delta to the list **as it is stored right now**.
 *
 * Removes first, then adds — so an id named in both ends up present, which is
 * the only reading of "add it" that is not a silent no-op. Adds append and
 * skip ids already there, preserving the invariant that the list IS the
 * display order on the launchpad: re-starring something does not reshuffle
 * what the user has already learned the positions of.
 */
function applyDelta(current: string[], delta: IdDelta): string[] {
  const dropped = new Set(delta.remove);
  const next = current.filter((id) => !dropped.has(id));
  const present = new Set(next);
  for (const id of delta.add) {
    if (present.has(id)) continue;
    present.add(id);
    next.push(id);
  }
  return next;
}

/** The favorites pair, always as arrays — an unset list reads back as `[]`. */
function favoritesOf(settings: { favoriteSkills?: string[]; favoriteJobs?: string[] }): { favoriteSkills: string[]; favoriteJobs: string[] } {
  return { favoriteSkills: settings.favoriteSkills ?? [], favoriteJobs: settings.favoriteJobs ?? [] };
}

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
    allowEngineInstalls,
    apiBaseUrl,
    apiKey,
    authToken,
    model,
    defaultOpusModel,
    defaultSonnetModel,
    defaultHaikuModel,
    subagentModel,
    pathToClaudeCodeExecutable,
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
    acpProviderModels,
    codexAuthMode,
    codexApiKey,
    codexBaseUrl,
    codexModel,
    codexHome,
    codexPathOverride,
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
    unpinChatsOnArchive,
    favoriteSkills,
    favoriteJobs,
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

  /**
   * Sanitize a string→string map from request JSON: rejects non-object /
   * array / null input with the given message, trims keys and values, drops
   * entries with an empty key or value (blank rows, not errors), and
   * collapses to `undefined` when nothing is left — so the caller clears the
   * stored setting rather than persisting `{}`. When `duplicateErrorMessage`
   * is supplied, two keys that only differ by case are rejected instead of
   * one silently shadowing the other (JS object keys are case-sensitive, so
   * `{"Planner": "x", "planner": "y"}` is a valid object that would otherwise
   * just pick whichever key iteration saw last).
   *
   * Shared by `normalizeAliases` (below, which layers its own duplicate-name
   * and one-hop cycle checks on top — those entries ARE a self-referential
   * alias registry) and the ACP per-vendor default-model map (which needs
   * neither: vendor ids map straight to raw model ids, not to each other).
   */
  const normalizeStringMap = (
    v: unknown,
    opts: { typeErrorMessage: string; duplicateErrorMessage?: (key: string) => string },
  ): { map?: Record<string, string>; error?: string } => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      return { error: opts.typeErrorMessage };
    }
    const map: Record<string, string> = {};
    const seenKeys = new Set<string>();
    for (const [rawKey, rawValue] of Object.entries(v)) {
      const key = rawKey.trim();
      const value = typeof rawValue === "string" ? rawValue.trim() : "";
      if (!key || !value) continue; // blank rows are dropped, not errors
      const lower = key.toLowerCase();
      if (opts.duplicateErrorMessage && seenKeys.has(lower)) {
        return { error: opts.duplicateErrorMessage(key) };
      }
      seenKeys.add(lower);
      map[key] = value;
    }
    return { map: Object.keys(map).length > 0 ? map : undefined };
  };

  // Sanitize the OpenRouter model alias map. Returns undefined when the map
  // ends up empty (clears the setting), or a string error for invalid input
  // the user must fix (the UI surfaces it inline).
  const normalizeAliases = (v: unknown): { aliases?: Record<string, string>; error?: string } => {
    const { map, error } = normalizeStringMap(v, {
      typeErrorMessage: "openRouterModelAliases must be an object mapping alias names to model slugs",
      duplicateErrorMessage: (alias) => `Duplicate alias name (case-insensitive): "${alias}"`,
    });
    if (error) return { error };
    // Resolution is intentionally one hop — an alias pointing at another
    // alias would either chain or cycle, so reject it at write time.
    if (map) {
      const seenNames = new Set(Object.keys(map).map((k) => k.toLowerCase()));
      for (const [alias, target] of Object.entries(map)) {
        if (seenNames.has(target.toLowerCase())) {
          return { error: `Alias "${alias}" points to another alias ("${target}") — targets must be real model slugs` };
        }
      }
    }
    return { aliases: map };
  };

  // Sanitize the per-ACP-vendor default-model map. Unlike normalizeAliases,
  // there's no cycle check: these are vendor ids to raw model ids, not a
  // self-referential alias registry, so a duplicate check is unneeded too —
  // vendor ids come from the settings UI's own tabs, not free-typed rows.
  const normalizeAcpProviderModels = (v: unknown): { models?: Record<string, string>; error?: string } => {
    const { map, error } = normalizeStringMap(v, {
      typeErrorMessage: "acpProviderModels must be an object mapping ACP vendor id to model id",
    });
    if (error) return { error };
    return { models: map };
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

  /**
   * Did this save change *which binary* an engine spawns?
   *
   * Kept apart from {@link apiFieldsTouched} because the remedy is different and
   * heavier: an API-key change needs the SDK account refetched, while a path
   * change invalidates every memoized "where did this resolve" answer in the
   * daemon. `getClaudeCodeExecutablePath` caches its result for the process
   * lifetime, which is why editing `pathToClaudeCodeExecutable` used to require
   * `callboard restart` before it took effect at all — a papercut Phase 2 built
   * `resetEngineProbeCaches()` to fix and nothing was yet calling for this
   * reason.
   *
   * Compared against the stored value rather than merely "was the field in the
   * request": the settings page sends every field on every save, so keying on
   * presence would drop five caches and re-run an Agent SDK query each time
   * someone changed a model name on an unrelated tab.
   */
  const binaryOverrideFieldsTouched =
    (pathToClaudeCodeExecutable !== undefined && normalize(pathToClaudeCodeExecutable) !== getAgentSettings().pathToClaudeCodeExecutable) ||
    (codexPathOverride !== undefined && normalize(codexPathOverride) !== getAgentSettings().codexPathOverride);

  /**
   * ── Binary overrides are a local-client capability ──────────────────
   *
   * These two fields designate which executable the daemon spawns. Before this
   * feature they could only be set by editing `agent-settings.json` on the host;
   * putting them in this request body made "which binary does this machine run"
   * remotely writable for the first time, and it went out ungated while Phase 3
   * refused *the same client* the far weaker capability of running one command
   * from a closed allowlist. Measured: a request with `X-Forwarded-For:
   * 8.8.8.8` got 403 from `POST /api/engines/:id/install` and 200 from this
   * route carrying `codexPathOverride`.
   *
   * That is not privilege escalation — the daemon runs as the user and any
   * authenticated client can already run commands through a chat. It is a
   * consistency failure, and the inconsistency is the security argument's own:
   * Phase 3 gates because Remote Access can put this server on the public
   * internet with a password as the only barrier. A supported UI for pointing
   * the daemon at an arbitrary executable belongs on the same side of that line
   * as a supported UI for `npm install -g`.
   *
   * Reads are untouched — a tunnelled client still sees which binary is in
   * effect on the status card, and still gets `binary-check`, which executes
   * nothing. Only the write is refused, and only when it would actually change
   * something: an unrelated save from a tunnelled client that happens to echo
   * the fields back unchanged is not an attempt to set them.
   *
   * @see plans/engine-availability-and-install.md — Decision 9
   */
  if (binaryOverrideFieldsTouched && !isDirectLocalClient(req)) {
    log.warn(`Refused a binary-override change from a non-local client (${getClientKey(req)})`);
    res.status(403).json({
      error:
        "Binary overrides can only be changed from a client on the local network. These fields decide which executable the Callboard daemon spawns, so they are held to the same scope as running an install — change them from a browser on the same machine or LAN, or by editing agent-settings.json on the host.",
    });
    return;
  }

  const codexFieldsTouched =
    codexAuthMode !== undefined ||
    codexApiKey !== undefined ||
    codexBaseUrl !== undefined ||
    codexHome !== undefined ||
    // A different binary can report a different model catalog — which is the
    // point of pointing at a newer one — and `codex-models.ts` now resolves
    // through the same override, so its cache is stale the moment this moves.
    codexPathOverride !== undefined ||
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

  let normalizedAcpProviderModels: Record<string, string> | undefined;
  if (acpProviderModels !== undefined) {
    const result = normalizeAcpProviderModels(acpProviderModels);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    normalizedAcpProviderModels = result.models;
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
      // NOT `normalizeBool`, and the difference is the direction it fails in.
      // `normalizeBool` returns `undefined` for a non-boolean, and an explicit
      // `undefined` in this spread *clears* the stored field — so
      // `{"allowEngineInstalls": "false"}` from a typo, a form serialiser or a
      // shell script would delete an operator's "off" and revert the capability
      // to its permissive default. For a security switch the only safe
      // interpretation of an unparseable value is "change nothing".
      ...(typeof allowEngineInstalls === "boolean" && { allowEngineInstalls }),
      ...(apiBaseUrl !== undefined && { apiBaseUrl: normalize(apiBaseUrl) }),
      ...(apiKey !== undefined && { apiKey: normalize(apiKey) }),
      ...(authToken !== undefined && { authToken: normalize(authToken) }),
      ...(model !== undefined && { model: normalize(model) }),
      ...(defaultOpusModel !== undefined && { defaultOpusModel: normalize(defaultOpusModel) }),
      ...(defaultSonnetModel !== undefined && { defaultSonnetModel: normalize(defaultSonnetModel) }),
      ...(defaultHaikuModel !== undefined && { defaultHaikuModel: normalize(defaultHaikuModel) }),
      ...(subagentModel !== undefined && { subagentModel: normalize(subagentModel) }),
      // Binary overrides. `normalize` trims and turns "" into undefined, which is
      // what clearing the field must do — an empty string here would be a
      // configured path of zero length, and the resolvers would report it as a
      // missing binary forever.
      ...(pathToClaudeCodeExecutable !== undefined && { pathToClaudeCodeExecutable: normalize(pathToClaudeCodeExecutable) }),
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
      ...(codexPathOverride !== undefined && { codexPathOverride: normalize(codexPathOverride) }),
      ...(codexSandboxMode !== undefined && { codexSandboxMode: normalizeCodexSandboxMode(codexSandboxMode) }),
      ...(codexUseOpenRouter !== undefined && { codexUseOpenRouter: normalizeBool(codexUseOpenRouter) }),
      ...(codexOpenRouterApiKey !== undefined && { codexOpenRouterApiKey: normalize(codexOpenRouterApiKey) }),
      ...(acpUseOpenRouter !== undefined && { acpUseOpenRouter: normalizeBool(acpUseOpenRouter) }),
      ...(acpOpenRouterApiKey !== undefined && { acpOpenRouterApiKey: normalize(acpOpenRouterApiKey) }),
      ...(acpProviderModels !== undefined && { acpProviderModels: normalizedAcpProviderModels }),
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
      // Guarded on `typeof === "boolean"`, not `normalizeBool`, for the reason
      // `allowEngineInstalls` above is: this setting defaults to ON when
      // absent, so an unparseable value passed through `normalizeBool` would
      // clear a stored `false` and silently switch the behaviour back on.
      // "Change nothing" is the only safe reading of a value that isn't a
      // boolean.
      ...(typeof unpinChatsOnArchive === "boolean" && { unpinChatsOnArchive }),
      // `Array.isArray`, not `!== undefined` — see `normalizeIdList`.
      ...(Array.isArray(favoriteSkills) && { favoriteSkills: normalizeIdList(favoriteSkills) }),
      ...(Array.isArray(favoriteJobs) && { favoriteJobs: normalizeIdList(favoriteJobs) }),
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
    if (binaryOverrideFieldsTouched) {
      // A different binary is now in effect, so every cached answer about which
      // one resolved — and the account info the *old* one reported — is stale.
      // This is the same reset Recheck performs; doing it here is what makes the
      // field take effect on the next chat instead of on the next daemon
      // restart, and what makes the status card agree with that chat.
      //
      // It subsumes the SDK-info refresh below (which is why that branch is now
      // an `else if`): both would otherwise fire, and `resetEngineProbeCaches`
      // deliberately drops the executable-path cache *before* re-spawning the
      // SDK query, so running the bare refresh alongside it would race a fetch
      // on the old path against one on the new.
      log.info("Binary override changed — dropping engine probe caches so the next chat and the status card both see it.");
      resetEngineProbeCaches();
    } else if (apiFieldsTouched) {
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

/**
 * GET   /api/agent-settings/favorites — the two favorites lists, and nothing else.
 * PUT   /api/agent-settings/favorites — replace one or both of them.
 * PATCH /api/agent-settings/favorites — add/remove ids against what is stored.
 *
 * ## Why this is not just `GET /api/agent-settings`
 *
 * The full settings object is unredacted: `apiKey`, `authToken`,
 * `openRouterApiKey`, `codexApiKey`, `cloudflaredToken`. That was defensible
 * while every caller was the Settings page itself — the page exists to show and
 * edit those fields. The New Chat launchpad is not: it needs two arrays of ids
 * to draw a row of chips, and it asks on every new-chat open, from whatever
 * device is reaching Callboard through the remote-access tunnel. Shipping every
 * credential in the install across that tunnel to render a chip row is a cost
 * with no matching benefit, so the launchpad gets a payload shaped like its
 * need.
 *
 * The write is the same `normalizeIdList` the main PUT uses — `[]` clears,
 * a non-array leaves the stored list alone — because the star in Settings and
 * the star on the launchpad must mean the same thing. The response is the
 * authoritative post-write pair, which is what the client adopts rather than
 * trusting its own optimistic copy (see `frontend/src/utils/favorites.ts`).
 *
 * The fields stay on the main PUT as well. Nothing is gained by breaking a
 * surface that already has tests and callers.
 *
 * ## Why PATCH exists, and why the star uses it
 *
 * PUT replaces the list, so the body has to be computed from a snapshot the
 * client read at some earlier point. Callboard is a remote-access tool and two
 * open tabs — a phone and a desk — is its normal shape, so that snapshot is
 * routinely stale, and a whole-list write from a stale snapshot destroys
 * entries the writer never knew existed. Measured in a browser with no induced
 * latency: tab A un-stars one skill, tab B (holding the pre-A list) stars
 * another and resurrects A's removal; A's *next* click then writes its own
 * two-entry snapshot over the three-entry list and two favorites are gone, with
 * no error anywhere.
 *
 * A delta cannot do that. `{ skills: { add: ["dep-audit"] } }` says only what
 * the click meant, and it is applied here, against the list as stored. The
 * worst a stale client can now do is re-add something — visible, and one click
 * to undo — instead of deleting what it could not see.
 *
 * PUT stays: replacing the list wholesale is a legitimate operation with its
 * own callers and tests. It is just no longer how a single star is toggled.
 */
agentSettingsRouter.get("/favorites", (_req: Request, res: Response): void => {
  try {
    res.json(favoritesOf(getAgentSettings()));
  } catch (err: any) {
    log.error(`Error getting favorites: ${err.message}`);
    res.status(500).json({ error: "Failed to get favorites" });
  }
});

agentSettingsRouter.put("/favorites", (req: Request, res: Response): void => {
  const { favoriteSkills, favoriteJobs } = req.body ?? {};
  try {
    const updated = updateAgentSettings({
      // `Array.isArray`, not `!== undefined` — see `normalizeIdList`.
      ...(Array.isArray(favoriteSkills) && { favoriteSkills: normalizeIdList(favoriteSkills) }),
      ...(Array.isArray(favoriteJobs) && { favoriteJobs: normalizeIdList(favoriteJobs) }),
    });
    res.json(favoritesOf(updated));
  } catch (err: any) {
    log.error(`Error updating favorites: ${err.message}`);
    res.status(500).json({ error: "Failed to update favorites" });
  }
});

agentSettingsRouter.patch("/favorites", (req: Request, res: Response): void => {
  const { skills, jobs } = req.body ?? {};
  const skillsDelta = normalizeDelta(skills);
  const jobsDelta = normalizeDelta(jobs);
  try {
    const current = favoritesOf(getAgentSettings());
    const updated = updateAgentSettings({
      // Only the sides this request actually named. An absent (or unusable)
      // delta must not rewrite a list, not even to the same value.
      ...(skillsDelta && { favoriteSkills: normalizeIdList(applyDelta(current.favoriteSkills, skillsDelta)) }),
      ...(jobsDelta && { favoriteJobs: normalizeIdList(applyDelta(current.favoriteJobs, jobsDelta)) }),
    });
    res.json(favoritesOf(updated));
  } catch (err: any) {
    log.error(`Error patching favorites: ${err.message}`);
    res.status(500).json({ error: "Failed to update favorites" });
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
