/**
 * Connection manager for local mode.
 *
 * Reads drawlatch's connection templates, merges them with the
 * current caller config, manages secrets in .env, and triggers
 * LocalProxy.reinitialize() after config changes.
 *
 * Supports multiple caller aliases. Each alias gets its own set of
 * enabled connections and its own env var prefix for secrets to avoid
 * conflicts (e.g., DEFAULT_GITHUB_TOKEN vs MYAGENT_GITHUB_TOKEN).
 *
 * The caller's `env` field in remote.config.json maps generic secret
 * names (e.g., "GITHUB_TOKEN") to prefixed env vars (e.g.,
 * "${DEFAULT_GITHUB_TOKEN}"), using drawlatch's built-in
 * CallerConfig.env mechanism.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import dotenv from "dotenv";
import { listConnectionTemplates } from "@wolpertingerlabs/drawlatch/shared/connections";
import { loadRemoteConfig, saveRemoteConfig, type RemoteServerConfig, type CallerConfig } from "@wolpertingerlabs/drawlatch/shared/config";
import { getActiveMcpConfigDir } from "./agent-settings.js";
import { getLocalProxyInstance } from "./proxy-singleton.js";
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

// ── Env var prefix utilities ────────────────────────────────────────

/**
 * Convert a caller alias to an env var prefix.
 * "default" → "DEFAULT", "my-agent" → "MY_AGENT", "work bot" → "WORK_BOT"
 */
function callerToPrefix(callerAlias: string): string {
  return callerAlias
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Get the prefixed env var name for a secret.
 * callerAlias="default", secretName="GITHUB_TOKEN" → "DEFAULT_GITHUB_TOKEN"
 */
function prefixedEnvVar(callerAlias: string, secretName: string): string {
  return `${callerToPrefix(callerAlias)}_${secretName}`;
}

// ── .env file utilities ─────────────────────────────────────────────

function getEnvFilePath(): string | null {
  const configDir = syncConfigDir();
  if (!configDir) return null;
  return join(configDir, ".env");
}

/** Load all vars from the mcp .env file into a map (without setting process.env). */
function loadEnvFile(): Record<string, string> {
  const envPath = getEnvFilePath();
  if (!envPath || !existsSync(envPath)) return {};
  try {
    const parsed = dotenv.parse(readFileSync(envPath, "utf-8"));
    return parsed;
  } catch (err: any) {
    log.warn(`Failed to parse .env at ${envPath}: ${err.message}`);
    return {};
  }
}

/**
 * Load the mcp config dir's .env file into process.env.
 * Called on server startup when local mode is active.
 */
export function loadMcpEnvIntoProcess(): void {
  const envPath = getEnvFilePath();
  if (!envPath || !existsSync(envPath)) return;
  dotenv.config({ path: envPath, override: true });
  log.info(`Loaded MCP .env from ${envPath}`);
}

/**
 * Write key-value pairs to the mcp .env file.
 * Also sets process.env immediately for in-process use.
 * An empty string value removes the key.
 */
function setEnvVars(updates: Record<string, string>): void {
  const envPath = getEnvFilePath();
  if (!envPath) throw new Error("MCP config dir not set");

  // Read current .env
  const envVars = loadEnvFile();

  // Apply updates
  for (const [key, value] of Object.entries(updates)) {
    if (value === "") {
      delete envVars[key];
      delete process.env[key];
    } else {
      envVars[key] = value;
      process.env[key] = value;
    }
  }

  // Serialize — quote values that contain spaces, quotes, or newlines
  const lines = Object.entries(envVars).map(([k, v]) => {
    if (/[\s"'\\#]/.test(v) || v.length === 0) {
      return `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return `${k}=${v}`;
  });

  writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });

  // Ensure file permissions even if it already existed
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // May fail on some platforms — best effort
  }
}

/**
 * Check if a secret is set for a given caller alias.
 *
 * Resolution order:
 * 1. Check the caller's `env` mapping — if the caller has
 *    `"GITHUB_TOKEN": "${DEFAULT_GITHUB_TOKEN}"`, resolve the referenced
 *    env var and check that it's set.
 * 2. Fall back to checking the bare secret name in process.env
 *    (backward compatibility for callers without env mappings).
 */
function isSecretSetForCaller(secretName: string, callerAlias: string, callerEnv?: Record<string, string>): boolean {
  // 1. Check caller env mapping
  if (callerEnv) {
    const mapping = callerEnv[secretName];
    if (mapping) {
      // Resolve the mapping (e.g., "${DEFAULT_GITHUB_TOKEN}" → check process.env.DEFAULT_GITHUB_TOKEN)
      const envMatch = /^\$\{(.+)\}$/.exec(mapping);
      if (envMatch) {
        const val = process.env[envMatch[1]];
        return val !== undefined && val !== "";
      }
      // Literal value — always "set"
      return true;
    }
  }

  // 2. Fall back: check the prefixed version
  const prefixed = prefixedEnvVar(callerAlias, secretName);
  if (process.env[prefixed] !== undefined && process.env[prefixed] !== "") {
    return true;
  }

  // 3. Fall back: check bare env var name (backward compat)
  const val = process.env[secretName];
  return val !== undefined && val !== "";
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
 * Saves secrets with a per-caller prefix in .env (e.g., DEFAULT_GITHUB_TOKEN)
 * and updates the caller's `env` mapping in remote.config.json so that
 * drawlatch's resolveSecrets() resolves them correctly.
 *
 * An empty string value for a secret deletes both the env var and the mapping.
 *
 * Returns updated secret-is-set status for all provided names.
 */
export async function setSecrets(secrets: Record<string, string>, callerAlias: string = "default"): Promise<Record<string, boolean>> {
  syncConfigDir();

  // Build prefixed env var updates
  const envUpdates: Record<string, string> = {};
  const newMappings: Record<string, string | null> = {}; // null = delete mapping

  for (const [secretName, value] of Object.entries(secrets)) {
    const prefixed = prefixedEnvVar(callerAlias, secretName);

    if (value === "") {
      // Delete: remove prefixed env var and mapping
      envUpdates[prefixed] = "";
      newMappings[secretName] = null;
    } else {
      // Set: save prefixed env var and add mapping
      envUpdates[prefixed] = value;
      newMappings[secretName] = `\${${prefixed}}`;
    }
  }

  // 1. Write env vars to .env and process.env
  setEnvVars(envUpdates);

  // 2. Update caller's env mapping in remote.config.json
  const config = loadRemoteConfig();
  const caller = ensureCallerConfig(config, callerAlias);
  if (!caller.env) {
    caller.env = {};
  }

  for (const [secretName, mapping] of Object.entries(newMappings)) {
    if (mapping === null) {
      delete caller.env[secretName];
    } else {
      caller.env[secretName] = mapping;
    }
  }

  // Clean up empty env object
  if (Object.keys(caller.env).length === 0) {
    delete caller.env;
  }

  saveRemoteConfig(config);

  log.info(`Updated ${Object.keys(secrets).length} secret(s) for caller "${callerAlias}": ${Object.keys(secrets).join(", ")}`);

  await reinitializeProxy();

  // Return status (never values)
  const callerEnv = config.callers[callerAlias]?.env;
  const status: Record<string, boolean> = {};
  for (const name of Object.keys(secrets)) {
    status[name] = isSecretSetForCaller(name, callerAlias, callerEnv);
  }
  return status;
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
