/**
 * .env file and secret-status utilities.
 *
 * Shared by the remote server (tool handlers, admin API) and the drawlatch CLI.
 * All functions use getEnvFilePath() from shared/config for path resolution.
 */

import fs from 'node:fs';
import { getEnvFilePath, type RemoteServerConfig, type CallerConfig } from './config.js';

// ── Caller prefix helpers ────────────────────────────────────────────────────

/** Convert caller alias to env var prefix: "default" → "DEFAULT", "my-agent" → "MY_AGENT" */
export function callerToPrefix(callerAlias: string): string {
  return callerAlias.toUpperCase().replace(/-/g, '_');
}

/** Get prefixed env var name: ("default", "GITHUB_TOKEN") → "DEFAULT_GITHUB_TOKEN" */
export function prefixedEnvVar(callerAlias: string, secretName: string): string {
  return `${callerToPrefix(callerAlias)}_${secretName}`;
}

// ── .env file I/O ────────────────────────────────────────────────────────────

/** Load all vars from the .env file into a map (does NOT set process.env). */
export function loadEnvFile(): Record<string, string> {
  const envPath = getEnvFilePath();
  if (!fs.existsSync(envPath)) return {};

  const content = fs.readFileSync(envPath, 'utf-8');
  const vars: Record<string, string> = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes (single or double)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    vars[key] = value;
  }

  return vars;
}

/**
 * Write key-value pairs to .env. Empty string = delete.
 * Also sets process.env immediately for in-process use.
 */
export function setEnvVars(updates: Record<string, string>): void {
  const envPath = getEnvFilePath();
  let existing = loadEnvFile();

  // Apply updates
  for (const [key, value] of Object.entries(updates)) {
    if (value === '') {
      // Remove key by rebuilding without it
      const { [key]: _removed, ...rest } = existing;
      existing = rest;
      process.env[key] = undefined;
    } else {
      existing[key] = value;
      process.env[key] = value;
    }
  }

  // Serialize back to .env format
  const lines = Object.entries(existing).map(([key, value]) => {
    // Quote values that contain spaces, #, or special characters
    if (/[\s#"'\\]/.test(value)) {
      return `${key}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return `${key}=${value}`;
  });

  const dir = envPath.replace(/\/[^/]+$/, '');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
}

// ── Secret status checks ─────────────────────────────────────────────────────

/**
 * Check if a secret is set for a caller.
 * Resolution: caller env mapping → prefixed env var.
 * Bare env var fallback intentionally removed to prevent cross-caller leakage.
 */
export function isSecretSetForCaller(
  secretName: string,
  callerAlias: string,
  callerEnv?: Record<string, string>,
): boolean {
  // 1. Check caller's env mapping (e.g., "GITHUB_TOKEN": "${DEFAULT_GITHUB_TOKEN}")
  if (callerEnv && secretName in callerEnv) {
    const mapping = callerEnv[secretName];
    const envMatch = /^\$\{(.+)\}$/.exec(mapping);
    if (envMatch) {
      // It's an env var reference — check if that var is set
      const varName = envMatch[1];
      return process.env[varName] !== undefined && process.env[varName] !== '';
    }
    // It's a literal value
    return mapping !== '';
  }

  // 2. Check prefixed env var (e.g., DEFAULT_GITHUB_TOKEN)
  const prefixed = prefixedEnvVar(callerAlias, secretName);
  return process.env[prefixed] !== undefined && process.env[prefixed] !== '';
}

/**
 * Regex for valid secret names: uppercase letters, digits, and underscores;
 * must start with a letter. Prevents injection of system env vars
 * (e.g., PATH, NODE_OPTIONS, LD_PRELOAD).
 */
export const SECRET_NAME_REGEX = /^[A-Z][A-Z0-9_]*$/;

/**
 * Set secrets for a caller with prefixed env vars.
 * Updates .env file, process.env, and caller's env mapping in config.
 * Returns boolean status per secret name.
 */
export function setCallerSecrets(
  secrets: Record<string, string>,
  callerAlias: string,
  config: RemoteServerConfig,
): { config: RemoteServerConfig; status: Record<string, boolean> } {
  const caller = config.callers[callerAlias] as CallerConfig | undefined;
  if (!caller) {
    throw new Error(`Unknown caller: ${callerAlias}`);
  }

  const envUpdates: Record<string, string> = {};
  const status: Record<string, boolean> = {};

  // Ensure caller has an env mapping
  caller.env ??= {};

  for (const [secretName, value] of Object.entries(secrets)) {
    if (!SECRET_NAME_REGEX.test(secretName)) {
      throw new Error(
        `Invalid secret name "${secretName}": must match ${SECRET_NAME_REGEX} ` +
          `(uppercase letters, digits, underscores; must start with a letter)`,
      );
    }

    const prefixed = prefixedEnvVar(callerAlias, secretName);

    if (value === '') {
      // Delete: remove from .env and caller env mapping
      envUpdates[prefixed] = '';
      const { [secretName]: _removed, ...rest } = caller.env;
      caller.env = rest;
      status[secretName] = false;
    } else {
      // Set: write prefixed env var and update caller env mapping
      envUpdates[prefixed] = value;
      caller.env[secretName] = `\${${prefixed}}`;
      status[secretName] = true;
    }
  }

  // Write to .env file and set process.env
  setEnvVars(envUpdates);

  return { config, status };
}
