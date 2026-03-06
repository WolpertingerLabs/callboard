/**
 * Connection manager for local and remote modes.
 *
 * Local mode: Reads drawlatch's connection templates, merges them with
 * the current caller config, manages secrets in .env, and triggers
 * LocalProxy.reinitialize() after config changes.
 *
 * Remote mode: Calls drawlatch tool handlers (list_connection_templates,
 * set_connection_enabled, set_secrets, get_secret_status) via the proxy
 * client to manage connections on the remote server.
 *
 * Supports multiple caller aliases. Each alias gets its own set of
 * enabled connections and its own env var prefix for secrets to avoid
 * conflicts (e.g., DEFAULT_GITHUB_TOKEN vs MYAGENT_GITHUB_TOKEN).
 */
import { listConnectionTemplates } from "@wolpertingerlabs/drawlatch/shared/connections";
import { loadRemoteConfig, saveRemoteConfig, type RemoteServerConfig, type CallerConfig } from "@wolpertingerlabs/drawlatch/shared/config";
import { loadEnvIntoProcess as drawlatchLoadEnv, setEnvVars, isSecretSetForCaller, setCallerSecrets } from "@wolpertingerlabs/drawlatch/shared/env-utils";
import { getActiveMcpConfigDir } from "./agent-settings.js";
import { getLocalProxyInstance, getProxy, getConfiguredAliases } from "./proxy-singleton.js";
import { createLogger } from "../utils/logger.js";
import type { ConnectionStatus, CallerInfo } from "shared";

const log = createLogger("connection-manager");

// ── MCP_CONFIG_DIR sync ─────────────────────────────────────────────

/**
 * Ensure process.env.MCP_CONFIG_DIR matches the mcpConfigDir from settings.
 * Must be called before any drawlatch config function so that
 * loadRemoteConfig() / saveRemoteConfig() use the correct directory.
 */
function syncConfigDir(): string | null {
  const configDir = getActiveMcpConfigDir();
  if (!configDir) return null;
  process.env.MCP_CONFIG_DIR = configDir;
  return configDir;
}

/**
 * Load the mcp config dir's .env file into process.env.
 * Called on server startup when local mode is active.
 */
export function loadMcpEnvIntoProcess(): void {
  syncConfigDir();
  drawlatchLoadEnv();
  log.info("Loaded MCP .env into process.env");
}

// ── Public API ──────────────────────────────────────────────────────

/** Get the caller config, creating it if it doesn't exist. */
function ensureCallerConfig(config: RemoteServerConfig, callerAlias: string): CallerConfig {
  if (!config.callers[callerAlias]) {
    config.callers[callerAlias] = {
      peerKeyDir: "", // Not used in local mode
      connections: [],
    };
  }
  return config.callers[callerAlias];
}

/**
 * List all configured caller aliases.
 * Always includes "default" as the first entry.
 */
export function listCallerAliases(): CallerInfo[] {
  syncConfigDir();
  const config = loadRemoteConfig();
  const result: CallerInfo[] = [];

  // Ensure "default" is always first
  const aliases = Object.keys(config.callers);
  if (!aliases.includes("default")) {
    aliases.unshift("default");
  }

  for (const alias of aliases) {
    const caller = config.callers[alias];
    result.push({
      alias,
      name: caller?.name,
      connectionCount: caller?.connections?.length ?? 0,
    });
  }

  return result;
}

/**
 * Create a new caller alias.
 * Returns the created caller info.
 */
export function createCallerAlias(callerAlias: string, name?: string): CallerInfo {
  syncConfigDir();
  const config = loadRemoteConfig();

  if (config.callers[callerAlias]) {
    throw new Error(`Caller "${callerAlias}" already exists`);
  }

  config.callers[callerAlias] = {
    name: name || callerAlias,
    peerKeyDir: "",
    connections: [],
  };

  saveRemoteConfig(config);
  log.info(`Created caller alias "${callerAlias}"`);

  return {
    alias: callerAlias,
    name: name || callerAlias,
    connectionCount: 0,
  };
}

/**
 * Delete a caller alias.
 * Removes the caller from remote.config.json and cleans up prefixed env vars.
 */
export async function deleteCallerAlias(callerAlias: string): Promise<void> {
  if (callerAlias === "default") {
    throw new Error('Cannot delete the "default" caller');
  }

  syncConfigDir();
  const config = loadRemoteConfig();

  if (!config.callers[callerAlias]) {
    throw new Error(`Caller "${callerAlias}" not found`);
  }

  // Clean up prefixed env vars for this caller
  const caller = config.callers[callerAlias];
  if (caller.env) {
    const envUpdates: Record<string, string> = {};
    for (const mapping of Object.values(caller.env)) {
      const envMatch = /^\$\{(.+)\}$/.exec(mapping);
      if (envMatch) {
        envUpdates[envMatch[1]] = ""; // empty string = delete
      }
    }
    if (Object.keys(envUpdates).length > 0) {
      setEnvVars(envUpdates);
    }
  }

  delete config.callers[callerAlias];
  saveRemoteConfig(config);
  await reinitializeProxy();
  log.info(`Deleted caller alias "${callerAlias}"`);
}

/**
 * List all connection templates with runtime status for a specific caller.
 * For each template: is it enabled for the caller? Which secrets are set?
 */
export function listConnectionsWithStatus(callerAlias: string = "default"): ConnectionStatus[] {
  syncConfigDir();
  const templates = listConnectionTemplates();
  const config = loadRemoteConfig();
  const caller = config.callers[callerAlias];
  const enabledConnections = new Set(caller?.connections ?? []);
  const callerEnv = caller?.env;

  return templates.map((t) => {
    const requiredSecretsSet: Record<string, boolean> = {};
    for (const s of t.requiredSecrets) {
      requiredSecretsSet[s] = isSecretSetForCaller(s, callerAlias, callerEnv);
    }
    const optionalSecretsSet: Record<string, boolean> = {};
    for (const s of t.optionalSecrets) {
      optionalSecretsSet[s] = isSecretSetForCaller(s, callerAlias, callerEnv);
    }

    return {
      alias: t.alias,
      name: t.name,
      ...(t.description !== undefined && { description: t.description }),
      ...(t.docsUrl !== undefined && { docsUrl: t.docsUrl }),
      ...(t.openApiUrl !== undefined && { openApiUrl: t.openApiUrl }),
      requiredSecrets: t.requiredSecrets,
      optionalSecrets: t.optionalSecrets,
      hasIngestor: t.hasIngestor,
      ...(t.ingestorType !== undefined && { ingestorType: t.ingestorType }),
      allowedEndpoints: t.allowedEndpoints,
      enabled: enabledConnections.has(t.alias),
      requiredSecretsSet,
      optionalSecretsSet,
      // stability + category are available on recent drawlatch templates (>= alpha.5)
      ...("stability" in t && { stability: (t as any).stability }),
      ...("category" in t && { category: (t as any).category }),
    };
  });
}

/**
 * Get status for a single connection template for a specific caller.
 */
export function getConnectionStatus(alias: string, callerAlias: string = "default"): ConnectionStatus | null {
  const all = listConnectionsWithStatus(callerAlias);
  return all.find((c) => c.alias === alias) ?? null;
}

/**
 * Enable or disable a connection for a specific caller.
 * Updates remote.config.json and reinitializes the proxy.
 */
export async function setConnectionEnabled(alias: string, enabled: boolean, callerAlias: string = "default"): Promise<void> {
  syncConfigDir();
  const config = loadRemoteConfig();
  const caller = ensureCallerConfig(config, callerAlias);

  const idx = caller.connections.indexOf(alias);
  if (enabled && idx === -1) {
    caller.connections.push(alias);
    log.info(`Enabled connection "${alias}" for caller "${callerAlias}"`);
  } else if (!enabled && idx !== -1) {
    caller.connections.splice(idx, 1);
    log.info(`Disabled connection "${alias}" for caller "${callerAlias}"`);
  }

  saveRemoteConfig(config);
  await reinitializeProxy();
}

/**
 * Set secrets for a connection, scoped to a specific caller alias.
 *
 * Delegates to drawlatch's setCallerSecrets() which handles prefixed
 * env var writes and caller env mapping updates in one call.
 *
 * Returns updated secret-is-set status for all provided names.
 */
export async function setSecrets(secrets: Record<string, string>, callerAlias: string = "default"): Promise<Record<string, boolean>> {
  syncConfigDir();

  const config = loadRemoteConfig();
  ensureCallerConfig(config, callerAlias);

  const { config: updatedConfig, status } = setCallerSecrets(secrets, callerAlias, config);
  saveRemoteConfig(updatedConfig);

  log.info(`Updated ${Object.keys(secrets).length} secret(s) for caller "${callerAlias}": ${Object.keys(secrets).join(", ")}`);

  await reinitializeProxy();

  return status;
}

// ── Listener instance management (local mode) ──────────────────────

export interface ListenerInstanceInfo {
  instanceId: string;
  disabled?: boolean;
  params?: Record<string, unknown>;
}

/**
 * List all listener instances for a connection and caller.
 * Returns the instances from callers[alias].listenerInstances[connection].
 */
export function listListenerInstances(connectionAlias: string, callerAlias: string = "default"): ListenerInstanceInfo[] {
  syncConfigDir();
  const config = loadRemoteConfig();
  const caller = config.callers[callerAlias];
  if (!caller?.listenerInstances?.[connectionAlias]) return [];

  return Object.entries(caller.listenerInstances[connectionAlias]).map(([instanceId, overrides]) => ({
    instanceId,
    disabled: overrides?.disabled ?? false,
    params: overrides?.params ?? {},
  }));
}

/**
 * Add a new listener instance for a connection.
 * Saves to remote.config.json and reinitializes the proxy.
 */
export async function addListenerInstance(
  connectionAlias: string,
  instanceId: string,
  params: Record<string, unknown>,
  callerAlias: string = "default",
): Promise<ListenerInstanceInfo> {
  syncConfigDir();
  const config = loadRemoteConfig();
  const caller = ensureCallerConfig(config, callerAlias);

  if (!caller.listenerInstances) {
    caller.listenerInstances = {};
  }
  if (!caller.listenerInstances[connectionAlias]) {
    caller.listenerInstances[connectionAlias] = {};
  }

  if (caller.listenerInstances[connectionAlias][instanceId]) {
    throw new Error(`Instance "${instanceId}" already exists for connection "${connectionAlias}"`);
  }

  caller.listenerInstances[connectionAlias][instanceId] = { params };
  saveRemoteConfig(config);
  log.info(`Added listener instance "${instanceId}" for connection "${connectionAlias}", caller "${callerAlias}"`);

  await reinitializeProxy();

  return { instanceId, params };
}

/**
 * Update a listener instance's parameters.
 * Merges params into the existing instance overrides.
 */
export async function updateListenerInstance(
  connectionAlias: string,
  instanceId: string,
  params: Record<string, unknown>,
  disabled?: boolean,
  callerAlias: string = "default",
): Promise<ListenerInstanceInfo> {
  syncConfigDir();
  const config = loadRemoteConfig();
  const caller = config.callers[callerAlias];

  if (!caller?.listenerInstances?.[connectionAlias]?.[instanceId]) {
    throw new Error(`Instance "${instanceId}" not found for connection "${connectionAlias}"`);
  }

  const instance = caller.listenerInstances[connectionAlias][instanceId];
  if (params && Object.keys(params).length > 0) {
    instance.params = { ...(instance.params || {}), ...params };
  }
  if (disabled !== undefined) {
    instance.disabled = disabled;
  }

  saveRemoteConfig(config);
  log.info(`Updated listener instance "${instanceId}" for connection "${connectionAlias}", caller "${callerAlias}"`);

  await reinitializeProxy();

  return {
    instanceId,
    disabled: instance.disabled ?? false,
    params: instance.params ?? {},
  };
}

/**
 * Delete a listener instance.
 * Removes from remote.config.json and reinitializes the proxy.
 */
export async function deleteListenerInstance(connectionAlias: string, instanceId: string, callerAlias: string = "default"): Promise<void> {
  syncConfigDir();
  const config = loadRemoteConfig();
  const caller = config.callers[callerAlias];

  if (!caller?.listenerInstances?.[connectionAlias]?.[instanceId]) {
    throw new Error(`Instance "${instanceId}" not found for connection "${connectionAlias}"`);
  }

  delete caller.listenerInstances[connectionAlias][instanceId];

  // Clean up empty maps
  if (Object.keys(caller.listenerInstances[connectionAlias]).length === 0) {
    delete caller.listenerInstances[connectionAlias];
  }
  if (Object.keys(caller.listenerInstances).length === 0) {
    delete caller.listenerInstances;
  }

  saveRemoteConfig(config);
  log.info(`Deleted listener instance "${instanceId}" for connection "${connectionAlias}", caller "${callerAlias}"`);

  await reinitializeProxy();
}

// ── Remote mode connections ─────────────────────────────────────────

/** Helper to get the proxy client for a given caller alias. */
function getRemoteClient(callerAlias?: string) {
  const aliases = getConfiguredAliases();
  if (aliases.length === 0) return null;
  const alias = callerAlias && aliases.includes(callerAlias) ? callerAlias : aliases[0];
  return { client: getProxy(alias), alias };
}

/**
 * List connections from a remote proxy server.
 *
 * Tries `list_connection_templates` first (new drawlatch tool with full
 * secret status), falling back to `list_routes` for older servers.
 *
 * Returns `remoteConfigManagement: true` when the new tools are available.
 */
export async function listRemoteConnections(callerAlias?: string): Promise<{
  templates: ConnectionStatus[];
  callers: CallerInfo[];
  remoteConfigManagement: boolean;
}> {
  const remote = getRemoteClient(callerAlias);
  if (!remote?.client) {
    return { templates: [], callers: [], remoteConfigManagement: false };
  }
  const { client, alias } = remote;
  const aliases = getConfiguredAliases();

  // Try list_connection_templates first (new drawlatch tool)
  try {
    const result = await client.callTool("list_connection_templates");
    const data = Array.isArray(result) ? result : [];

    const templates: ConnectionStatus[] = data.map((t: any) => ({
      alias: t.alias,
      name: t.name,
      ...(t.description && { description: t.description }),
      ...(t.docsUrl && { docsUrl: t.docsUrl }),
      ...(t.openApiUrl && { openApiUrl: t.openApiUrl }),
      requiredSecrets: t.requiredSecrets ?? [],
      optionalSecrets: t.optionalSecrets ?? [],
      hasIngestor: t.hasIngestor ?? false,
      ...(t.ingestorType && { ingestorType: t.ingestorType }),
      allowedEndpoints: t.allowedEndpoints ?? [],
      enabled: t.enabled ?? false,
      requiredSecretsSet: t.requiredSecretsSet ?? {},
      optionalSecretsSet: t.optionalSecretsSet ?? {},
      source: "remote" as const,
      ...(t.stability && { stability: t.stability }),
      ...(t.category && { category: t.category }),
    }));

    const callers: CallerInfo[] = aliases.map((a) => ({
      alias: a,
      connectionCount: a === alias ? templates.filter((t) => t.enabled).length : 0,
    }));

    return { templates, callers, remoteConfigManagement: true };
  } catch {
    // Fall through to list_routes fallback
  }

  // Fallback: list_routes (old drawlatch server)
  try {
    const result = await client.callTool("list_routes");
    const routes = Array.isArray(result) ? result : [];

    const templates: ConnectionStatus[] = routes.map((route: any) => ({
      alias: route.alias || route.name || `route-${route.index}`,
      name: route.name || `Route ${route.index}`,
      ...(route.description && { description: route.description }),
      ...(route.docsUrl && { docsUrl: route.docsUrl }),
      ...(route.openApiUrl && { openApiUrl: route.openApiUrl }),
      requiredSecrets: [],
      optionalSecrets: [],
      hasIngestor: route.hasIngestor ?? false,
      ...(route.ingestorType && { ingestorType: route.ingestorType }),
      allowedEndpoints: route.allowedEndpoints ?? [],
      enabled: true,
      requiredSecretsSet: {},
      optionalSecretsSet: {},
      source: "remote" as const,
      ...(route.stability && { stability: route.stability }),
      ...(route.category && { category: route.category }),
    }));

    const callers: CallerInfo[] = aliases.map((a) => ({
      alias: a,
      connectionCount: a === alias ? templates.length : 0,
    }));

    return { templates, callers, remoteConfigManagement: false };
  } catch (err: any) {
    log.error(`Failed to fetch remote connections for alias "${alias}": ${err.message}`);
    return { templates: [], callers: [], remoteConfigManagement: false };
  }
}

/**
 * Enable or disable a connection on a remote drawlatch server.
 */
export async function setRemoteConnectionEnabled(alias: string, enabled: boolean, callerAlias?: string): Promise<void> {
  const remote = getRemoteClient(callerAlias);
  if (!remote?.client) throw new Error("No remote proxy connection available");

  const result = await remote.client.callTool("set_connection_enabled", {
    connection: alias,
    enabled,
  });

  if (result && typeof result === "object" && "success" in result && !result.success) {
    throw new Error(`Failed to ${enabled ? "enable" : "disable"} remote connection "${alias}"`);
  }

  log.info(`Remote: ${enabled ? "enabled" : "disabled"} connection "${alias}" via caller "${remote.alias}"`);
}

/**
 * Set secrets on a remote drawlatch server.
 * Returns boolean status per secret name.
 */
export async function setRemoteSecrets(secrets: Record<string, string>, callerAlias?: string): Promise<Record<string, boolean>> {
  const remote = getRemoteClient(callerAlias);
  if (!remote?.client) throw new Error("No remote proxy connection available");

  const result: any = await remote.client.callTool("set_secrets", { secrets });

  if (result && typeof result === "object" && "secretsSet" in result) {
    return result.secretsSet as Record<string, boolean>;
  }

  throw new Error("Unexpected response from set_secrets");
}

/**
 * Get secret status from a remote drawlatch server.
 */
export async function getRemoteSecretStatus(
  connectionAlias: string,
  callerAlias?: string,
): Promise<{ requiredSecretsSet: Record<string, boolean>; optionalSecretsSet: Record<string, boolean> }> {
  const remote = getRemoteClient(callerAlias);
  if (!remote?.client) throw new Error("No remote proxy connection available");

  const result: any = await remote.client.callTool("get_secret_status", {
    connection: connectionAlias,
  });

  if (result && typeof result === "object" && "requiredSecretsSet" in result) {
    return {
      requiredSecretsSet: result.requiredSecretsSet ?? {},
      optionalSecretsSet: result.optionalSecretsSet ?? {},
    };
  }

  throw new Error("Unexpected response from get_secret_status");
}

/** Reinitialize the local proxy to pick up config/secret changes. */
async function reinitializeProxy(): Promise<void> {
  const proxy = getLocalProxyInstance();
  if (proxy) {
    try {
      await proxy.reinitialize();
      log.info("Local proxy reinitialized after connection config change");
    } catch (err: any) {
      log.error(`Failed to reinitialize proxy: ${err.message}`);
    }
  }
}
