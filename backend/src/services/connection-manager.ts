/**
 * Connection manager for local mode.
 *
 * Reads mcp-secure-proxy's connection templates, merges them with the
 * current caller config, manages secrets in .env, and triggers
 * LocalProxy.reinitialize() after config changes.
 *
 * In local mode, all connections are managed for a single hardcoded
 * "default" caller — no multi-user complexity.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from "fs";
import { join } from "path";
import dotenv from "dotenv";
import { listConnectionTemplates } from "mcp-secure-proxy/shared/connections";
import {
  loadRemoteConfig,
  saveRemoteConfig,
  type RemoteServerConfig,
  type CallerConfig,
} from "mcp-secure-proxy/shared/config";
import { getAgentSettings } from "./agent-settings.js";
import { getLocalProxyInstance } from "./proxy-singleton.js";
import { createLogger } from "../utils/logger.js";
import type { ConnectionStatus } from "shared";

const log = createLogger("connection-manager");
const CALLER_ALIAS = "default";

// ── MCP_CONFIG_DIR sync ─────────────────────────────────────────────

/**
 * Ensure process.env.MCP_CONFIG_DIR matches the mcpConfigDir from settings.
 * Must be called before any mcp-secure-proxy config function so that
 * loadRemoteConfig() / saveRemoteConfig() use the correct directory.
 */
function syncConfigDir(): string | null {
  const settings = getAgentSettings();
  if (!settings.mcpConfigDir) return null;
  process.env.MCP_CONFIG_DIR = settings.mcpConfigDir;
  return settings.mcpConfigDir;
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

/** Check if an env var is set (non-empty) in process.env. */
function isSecretSet(varName: string): boolean {
  const val = process.env[varName];
  return val !== undefined && val !== "";
}

// ── Public API ──────────────────────────────────────────────────────

/** Get the caller config, creating it if it doesn't exist. */
function ensureCallerConfig(config: RemoteServerConfig): CallerConfig {
  if (!config.callers[CALLER_ALIAS]) {
    config.callers[CALLER_ALIAS] = {
      peerKeyDir: "", // Not used in local mode
      connections: [],
    };
  }
  return config.callers[CALLER_ALIAS];
}

/**
 * List all connection templates with runtime status.
 * For each template: is it enabled for the default caller? Which secrets are set?
 */
export function listConnectionsWithStatus(): ConnectionStatus[] {
  syncConfigDir();
  const templates = listConnectionTemplates();
  const config = loadRemoteConfig();
  const caller = config.callers[CALLER_ALIAS];
  const enabledConnections = new Set(caller?.connections ?? []);

  return templates.map((t) => {
    const requiredSecretsSet: Record<string, boolean> = {};
    for (const s of t.requiredSecrets) {
      requiredSecretsSet[s] = isSecretSet(s);
    }
    const optionalSecretsSet: Record<string, boolean> = {};
    for (const s of t.optionalSecrets) {
      optionalSecretsSet[s] = isSecretSet(s);
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
 * Get status for a single connection template.
 */
export function getConnectionStatus(alias: string): ConnectionStatus | null {
  const all = listConnectionsWithStatus();
  return all.find((c) => c.alias === alias) ?? null;
}

/**
 * Enable or disable a connection for the default caller.
 * Updates remote.config.json and reinitializes the proxy.
 */
export async function setConnectionEnabled(alias: string, enabled: boolean): Promise<void> {
  syncConfigDir();
  const config = loadRemoteConfig();
  const caller = ensureCallerConfig(config);

  const idx = caller.connections.indexOf(alias);
  if (enabled && idx === -1) {
    caller.connections.push(alias);
    log.info(`Enabled connection "${alias}" for caller "${CALLER_ALIAS}"`);
  } else if (!enabled && idx !== -1) {
    caller.connections.splice(idx, 1);
    log.info(`Disabled connection "${alias}" for caller "${CALLER_ALIAS}"`);
  }

  saveRemoteConfig(config);
  await reinitializeProxy();
}

/**
 * Set secrets for a connection.
 * Writes to .env, sets process.env, reinitializes proxy.
 * Returns updated secret-is-set status for all provided names.
 */
export async function setSecrets(
  secrets: Record<string, string>,
): Promise<Record<string, boolean>> {
  setEnvVars(secrets);
  log.info(
    `Updated ${Object.keys(secrets).length} secret(s): ${Object.keys(secrets).join(", ")}`,
  );

  await reinitializeProxy();

  // Return status (never values)
  const status: Record<string, boolean> = {};
  for (const name of Object.keys(secrets)) {
    status[name] = isSecretSet(name);
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
