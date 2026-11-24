/**
 * The Sandbox desktop's operator settings: `~/.callboard/sandbox-desktop.json`.
 *
 * A file of its own rather than a field of agent settings: these are host
 * facts (which Docker, which network, how much CPU), changed by the signed-in
 * human from Settings → Sandbox desktop and read on every sandbox start. An
 * unreadable or malformed file reads as all-defaults — automatic mode — and is
 * logged, never thrown at a status poll.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SANDBOX_DESKTOP_BOUNDS, type SandboxDesktopMode, type SandboxDesktopNetwork, type SandboxDesktopSettings } from "shared/types/index.js";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("sandbox-desktop-settings");

export const SANDBOX_SETTINGS_FILE = () => join(DATA_DIR, "sandbox-desktop.json");

const MODES: readonly SandboxDesktopMode[] = ["off", "managed", "endpoint"];
const NETWORKS: readonly SandboxDesktopNetwork[] = ["internet", "none"];

/** The settings with every default filled in. `mode` stays optional: unset is automatic. */
export interface ResolvedSandboxSettings {
  mode?: SandboxDesktopMode;
  network: SandboxDesktopNetwork;
  cpus: number;
  memoryMb: number;
  maxConcurrent: number;
  keepHours: number;
  maxKept: number;
}

export class SandboxSettingsError extends Error {
  readonly code = "invalid_request";
}

type Bound = { min: number; max: number };
const inBounds = (value: unknown, { min, max }: Bound, integer: boolean): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));

/**
 * Validate a stored or submitted value. `strict` (a PUT) throws on anything
 * out of range; otherwise (reading the file) a bad field is dropped back to
 * its default, so one hand-edited typo does not take the sandbox down.
 */
export function normalizeSandboxSettings(input: unknown, strict: boolean): SandboxDesktopSettings {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    if (strict) throw new SandboxSettingsError("Sandbox desktop settings must be an object");
    return {};
  }
  const value = input as Record<string, unknown>;
  const out: SandboxDesktopSettings = {};
  const bad = (field: string, rule: string) => {
    if (strict) throw new SandboxSettingsError(`${field} must be ${rule}`);
    log.warn(`Ignoring sandbox-desktop.json ${field}: not ${rule}`);
  };
  if (strict) {
    const known = new Set(["mode", "network", "cpus", "memoryMb", "maxConcurrent", "keepHours", "maxKept"]);
    const unknown = Object.keys(value).filter((key) => !known.has(key));
    if (unknown.length) throw new SandboxSettingsError(`Unknown sandbox desktop setting ${JSON.stringify(unknown[0])}`);
  }
  // `null` clears a field back to its default (and `mode: null` back to automatic).
  if (value.mode !== undefined && value.mode !== null) {
    if (MODES.includes(value.mode as SandboxDesktopMode)) out.mode = value.mode as SandboxDesktopMode;
    else bad("mode", `one of ${MODES.join(", ")}`);
  }
  if (value.network !== undefined && value.network !== null) {
    if (NETWORKS.includes(value.network as SandboxDesktopNetwork)) out.network = value.network as SandboxDesktopNetwork;
    else bad("network", `one of ${NETWORKS.join(", ")}`);
  }
  const { cpus, memoryMb, maxConcurrent, keepHours, maxKept } = SANDBOX_DESKTOP_BOUNDS;
  if (value.cpus !== undefined && value.cpus !== null) {
    // Docker takes CPUs in hundredths at most; anything finer is noise.
    if (inBounds(value.cpus, cpus, false) && Math.round(value.cpus * 100) === value.cpus * 100) out.cpus = value.cpus;
    else bad("cpus", `a number from ${cpus.min} to ${cpus.max}, in steps of 0.01`);
  }
  if (value.memoryMb !== undefined && value.memoryMb !== null) {
    if (inBounds(value.memoryMb, memoryMb, true)) out.memoryMb = value.memoryMb;
    else bad("memoryMb", `a whole number of MiB from ${memoryMb.min} to ${memoryMb.max}`);
  }
  if (value.maxConcurrent !== undefined && value.maxConcurrent !== null) {
    if (inBounds(value.maxConcurrent, maxConcurrent, true)) out.maxConcurrent = value.maxConcurrent;
    else bad("maxConcurrent", `a whole number from ${maxConcurrent.min} to ${maxConcurrent.max}`);
  }
  if (value.keepHours !== undefined && value.keepHours !== null) {
    if (inBounds(value.keepHours, keepHours, true)) out.keepHours = value.keepHours;
    else bad("keepHours", `a whole number of hours from ${keepHours.min} to ${keepHours.max}`);
  }
  if (value.maxKept !== undefined && value.maxKept !== null) {
    if (inBounds(value.maxKept, maxKept, true)) out.maxKept = value.maxKept;
    else bad("maxKept", `a whole number from ${maxKept.min} to ${maxKept.max}`);
  }
  return out;
}

export function resolveSandboxSettings(settings: SandboxDesktopSettings): ResolvedSandboxSettings {
  return {
    ...(settings.mode ? { mode: settings.mode } : {}),
    network: settings.network ?? "internet",
    cpus: settings.cpus ?? SANDBOX_DESKTOP_BOUNDS.cpus.default,
    memoryMb: settings.memoryMb ?? SANDBOX_DESKTOP_BOUNDS.memoryMb.default,
    maxConcurrent: settings.maxConcurrent ?? SANDBOX_DESKTOP_BOUNDS.maxConcurrent.default,
    keepHours: settings.keepHours ?? SANDBOX_DESKTOP_BOUNDS.keepHours.default,
    maxKept: settings.maxKept ?? SANDBOX_DESKTOP_BOUNDS.maxKept.default,
  };
}

/** What is stored, validated; `{}` when there is no file or it cannot be read. */
export function readSandboxSettings(file = SANDBOX_SETTINGS_FILE()): SandboxDesktopSettings {
  if (!existsSync(file)) return {};
  try {
    return normalizeSandboxSettings(JSON.parse(readFileSync(file, "utf8")), false);
  } catch (error) {
    log.warn(`Could not read ${file}; using the defaults: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
}

/**
 * Apply a partial update (`null` clears a field) and write it atomically.
 * Returns what is now stored. Throws {@link SandboxSettingsError} on a bad value.
 */
export function updateSandboxSettings(patch: unknown, file = SANDBOX_SETTINGS_FILE()): SandboxDesktopSettings {
  const changes = normalizeSandboxSettings(patch, true);
  const cleared = Object.entries(patch as Record<string, unknown>)
    .filter(([, value]) => value === null)
    .map(([key]) => key);
  const next: Record<string, unknown> = { ...readSandboxSettings(file), ...changes };
  for (const key of cleared) delete next[key];
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return next as SandboxDesktopSettings;
}
