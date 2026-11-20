/**
 * Native chat-retention policy per engine — what Settings → API shows under
 * "Chat retention", and the one write it allows.
 *
 * Only Claude expires chats on its own. Its CLI sweeps `~/.claude/projects/` at
 * every start (the Agent SDK spawns count), deleting transcripts not written to
 * for `cleanupPeriodDays` days — a key in the *user* settings file, default 30,
 * minimum 1. Codex (`$CODEX_HOME/sessions`) and pi (Callboard's
 * `pi-sessions` dir) have no automatic expiry at all, which was checked against
 * the bundled versions rather than assumed: neither has a setting to surface, so
 * they are reported read-only.
 *
 * ## Writing someone else's settings file
 *
 * `~/.claude/settings.json` belongs to Claude Code, and the user may have
 * anything in it — permissions, hooks, env. So the write is deliberately narrow:
 *
 * - it touches exactly one key and round-trips every other one;
 * - it re-reads the file immediately before writing, rather than trusting a
 *   copy from the GET, to keep the window against a concurrent `/config` small;
 * - it refuses to write a file that exists but does not parse — rewriting it
 *   from `{}` would silently drop the user's configuration;
 * - it writes atomically and keeps the file's existing permission bits.
 *
 * `0` is refused rather than passed through: in Claude it does not mean
 * "never expire", it disables transcript writes entirely, which would break
 * every Callboard chat on the engine. "Keep for a very long time" is a large
 * number, and the UI offers one.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EngineRetention } from "shared/types/index.js";
import { resolvePiSessionsRoot } from "../agents/adapters/pi/paths.js";
import { resolveCodexSessionsRoot } from "../agents/adapters/codex/sessionParser.js";
import { atomicWriteFileSync } from "../utils/atomic-write.js";

/** Claude's own default when `cleanupPeriodDays` is absent. */
export const CLAUDE_DEFAULT_CLEANUP_DAYS = 30;
/**
 * Upper bound on what Callboard will write. Claude enforces no ceiling, but a
 * value past this is a typo, not a policy, and ~100 years is already "forever"
 * for a transcript.
 */
export const CLAUDE_MAX_CLEANUP_DAYS = 36500;

export interface ClaudeRetentionPaths {
  /** Claude's config dir — `~/.claude` unless a test says otherwise. */
  claudeDir?: string;
  /** Managed-policy files to check, highest precedence first. Defaults to the platform's documented locations. */
  managedFiles?: string[];
}

/** Thrown for a request the caller should fix — mapped to a 4xx by the route. */
export class RetentionUpdateError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
  }
}

function claudeDir(paths: ClaudeRetentionPaths): string {
  return paths.claudeDir ?? join(homedir(), ".claude");
}

/**
 * Where Claude Code reads managed (org policy) settings, per its docs. A
 * `managed-settings.d/` drop-in directory beside the file is read too.
 */
function defaultManagedFiles(): string[] {
  const base =
    process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode"
      : process.platform === "win32"
        ? "C:\\Program Files\\ClaudeCode"
        : "/etc/claude-code";
  const files = [join(base, "managed-settings.json")];
  const dropIns = join(base, "managed-settings.d");
  try {
    for (const name of readdirSync(dropIns).sort()) {
      if (name.endsWith(".json")) files.push(join(dropIns, name));
    }
  } catch {
    /* no drop-in directory — the common case */
  }
  return files;
}

function isValidDays(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** The first managed file that pins a valid `cleanupPeriodDays`, if any. Unreadable policy files are skipped, not fatal. */
function managedCleanupDays(files: string[]): { days: number; file: string } | undefined {
  for (const file of files) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      const days = (parsed as Record<string, unknown> | null)?.cleanupPeriodDays;
      if (isValidDays(days)) return { days, file };
    } catch {
      /* absent or unparseable — not ours to report on */
    }
  }
  return undefined;
}

type UserSettingsRead = { kind: "missing" } | { kind: "ok"; settings: Record<string, unknown> } | { kind: "unreadable"; reason: string };

function readUserSettings(file: string): UserSettingsRead {
  if (!existsSync(file)) return { kind: "missing" };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  // Claude itself treats an empty file as no settings.
  if (raw.trim() === "") return { kind: "ok", settings: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "unreadable", reason: "the file is not a JSON object" };
    }
    return { kind: "ok", settings: parsed as Record<string, unknown> };
  } catch (err) {
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
}

export function getClaudeRetention(paths: ClaudeRetentionPaths = {}): Extract<EngineRetention, { engine: "claude-code" }> {
  const dir = claudeDir(paths);
  const settingsPath = join(dir, "settings.json");
  const read = readUserSettings(settingsPath);
  const raw = read.kind === "ok" ? read.settings.cleanupPeriodDays : undefined;
  // An invalid value in the file (0, a string) is reported as "not configured"
  // — what Claude itself would do with it is not something to guess at here.
  const configuredDays = isValidDays(raw) ? raw : null;
  const managed = managedCleanupDays(paths.managedFiles ?? defaultManagedFiles());
  return {
    engine: "claude-code",
    expires: true,
    configuredDays,
    defaultDays: CLAUDE_DEFAULT_CLEANUP_DAYS,
    effectiveDays: managed?.days ?? configuredDays ?? CLAUDE_DEFAULT_CLEANUP_DAYS,
    settingsPath,
    ...(managed ? { managedBy: managed.file } : {}),
    ...(read.kind === "unreadable" ? { unreadable: read.reason } : {}),
    storagePath: join(dir, "projects"),
  };
}

export function getEngineRetention(paths: ClaudeRetentionPaths = {}): EngineRetention[] {
  return [
    getClaudeRetention(paths),
    { engine: "codex", expires: false, storagePath: resolveCodexSessionsRoot() },
    { engine: "pi", expires: false, storagePath: resolvePiSessionsRoot() },
  ];
}

/**
 * Set (or, with `null`, remove) `cleanupPeriodDays` in the user settings file.
 * Every other key is preserved. Throws {@link RetentionUpdateError} for a value
 * or a file state the caller can fix.
 */
export function setClaudeCleanupPeriodDays(days: number | null, paths: ClaudeRetentionPaths = {}): Extract<EngineRetention, { engine: "claude-code" }> {
  if (days !== null && (!isValidDays(days) || days > CLAUDE_MAX_CLEANUP_DAYS)) {
    throw new RetentionUpdateError(
      `cleanupPeriodDays must be a whole number from 1 to ${CLAUDE_MAX_CLEANUP_DAYS}, or null for Claude's default. (0 is not "never" — it turns off saving chats.)`,
      400,
    );
  }
  const dir = claudeDir(paths);
  const settingsPath = join(dir, "settings.json");
  const read = readUserSettings(settingsPath);
  if (read.kind === "unreadable") {
    throw new RetentionUpdateError(
      `${settingsPath} could not be parsed (${read.reason}), so Callboard will not rewrite it — that would drop your other Claude settings. Fix the file and try again.`,
      409,
    );
  }
  if (read.kind === "missing" && days === null) return getClaudeRetention(paths);

  const settings = read.kind === "ok" ? { ...read.settings } : {};
  if (days === null) delete settings.cleanupPeriodDays;
  else settings.cleanupPeriodDays = days;

  let mode: number | undefined;
  try {
    mode = statSync(settingsPath).mode & 0o777;
  } catch {
    mode = undefined;
  }
  if (!existsSync(dir)) {
    // No ~/.claude at all means Claude has never run as this user; creating its
    // config dir on its behalf is not this setting's job.
    throw new RetentionUpdateError(`${dir} does not exist — run Claude once so it creates its config directory, then try again.`, 409);
  }
  atomicWriteFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, mode !== undefined ? { mode } : {});
  return getClaudeRetention(paths);
}
