/**
 * Native chat-retention policy per engine — what Settings → API shows under
 * "Chat retention", and the one write it allows.
 *
 * Only Claude expires chats on its own. Its CLI sweeps `~/.claude/projects/` at
 * every start (the Agent SDK spawns count), deleting transcripts not written to
 * for `cleanupPeriodDays` days — default 30, minimum 1. Codex
 * (`$CODEX_HOME/sessions`) and pi (Callboard's `pi-sessions` dir) have no
 * automatic expiry at all, which was checked against the bundled versions
 * rather than assumed: neither has a setting to surface, so they are reported
 * read-only.
 *
 * ## Where Claude's value comes from
 *
 * The sweep uses the settings the starting process merged, which is more than
 * the user file:
 *
 * - **Managed policy** outranks everything. It is not only
 *   `managed-settings.json`: drop-ins, server-managed settings, macOS MDM and
 *   the Windows registry all feed it, with their own precedence. Rather than
 *   re-implement that merge, the policy tier is read through the SDK's
 *   `resolveSettings({ settingSources: [] })`, which runs the CLI's own merge
 *   without spawning it.
 * - **Project and local settings** (`<repo>/.claude/settings{,.local}.json`)
 *   also outrank the user file, for a `claude` started in that repo — and
 *   Callboard starts sessions with them enabled. They are per-directory, so
 *   there is no single answer to report; the UI says they can override this.
 * - **The user file** is what this service reads and writes.
 *
 * ## Writing someone else's settings file
 *
 * `settings.json` belongs to Claude Code, and the user may have anything in it
 * — permissions, hooks, env. So the write is deliberately narrow:
 *
 * - it touches exactly one key and round-trips every other one (the file is
 *   re-serialised as 2-space JSON, which is how Claude writes it; numbers
 *   beyond double precision would not survive, but Claude's schema has none);
 * - it re-reads the file immediately before writing, rather than trusting a
 *   copy from the GET, to keep the window against a concurrent `/config` small;
 * - it refuses to write a file that exists but does not parse — rewriting it
 *   from `{}` would silently drop the user's configuration;
 * - it writes atomically, keeps the file's permission bits, and writes
 *   *through* a symlink rather than replacing it, so a settings file managed by
 *   a dotfiles tool stays managed.
 *
 * `0` is refused: Claude itself rejects it as invalid (it once meant "write no
 * transcripts at all"). "Keep for a very long time" is a large number, and the
 * UI offers one.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EngineRetention } from "shared/types/index.js";
import { resolvePiSessionsRoot } from "../agents/adapters/pi/paths.js";
import { resolveCodexSessionsRoot } from "../agents/adapters/codex/sessionParser.js";
import { atomicWriteFileSync } from "../utils/atomic-write.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("engine-retention");

/** Claude's own default when `cleanupPeriodDays` is absent. */
export const CLAUDE_DEFAULT_CLEANUP_DAYS = 30;
/**
 * Upper bound on what Callboard will write. Claude enforces no ceiling, but a
 * value past this is a typo, not a policy, and ~100 years is already "forever"
 * for a transcript.
 */
export const CLAUDE_MAX_CLEANUP_DAYS = 36500;

type ClaudeRetention = Extract<EngineRetention, { engine: "claude-code" }>;

/** A managed-policy `cleanupPeriodDays`, and a human-readable name for where it came from. */
export interface PolicyRetention {
  days: number;
  source: string;
}

export interface ClaudeRetentionDeps {
  /** Claude's config dir. Defaults to `$CLAUDE_CONFIG_DIR`, else `~/.claude` — what the CLI uses. */
  claudeDir?: string;
  /** The managed-policy value, if any. Defaults to asking the SDK's settings resolver. */
  resolvePolicy?: () => Promise<PolicyRetention | undefined>;
}

/** Thrown for a request the caller should fix — mapped to a 4xx by the route. */
export class RetentionUpdateError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409,
  ) {
    super(message);
  }
}

function claudeDir(deps: ClaudeRetentionDeps): string {
  return deps.claudeDir ?? (process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"));
}

function isValidDays(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

const POLICY_ORIGIN_LABEL: Record<string, string> = {
  remote: "server-managed settings",
  plist: "a macOS configuration profile",
  hklm: "the Windows registry (HKLM)",
  hkcu: "the Windows registry (HKCU)",
  helper: "a policy helper",
  parent: "the parent process's managed settings",
};

/**
 * The policy tier's `cleanupPeriodDays`, through the CLI's own merge. With no
 * filesystem sources enabled, anything left in `effective` came from policy.
 * Known blind spot, per the SDK: an admin `policyHelper` is never executed
 * here, so a value only it supplies is not detected — the field then stays
 * editable and a write has no effect, which loses nothing.
 * A resolver failure is logged and treated as "no policy": the field is then
 * editable, which is the state the user can at least act on.
 */
async function resolvePolicyFromSdk(): Promise<PolicyRetention | undefined> {
  try {
    const { resolveSettings } = await import("@anthropic-ai/claude-agent-sdk");
    const resolved = await resolveSettings({ settingSources: [] });
    const days = (resolved.effective as Record<string, unknown>).cleanupPeriodDays;
    if (!isValidDays(days)) return undefined;
    const prov = resolved.provenance.cleanupPeriodDays;
    const source = prov?.path ?? (prov?.policyOrigin ? POLICY_ORIGIN_LABEL[prov.policyOrigin] : undefined) ?? "managed policy";
    return { days, source };
  } catch (err) {
    log.warn(`could not resolve Claude managed settings: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
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

function configuredDaysIn(read: UserSettingsRead): number | null {
  const raw = read.kind === "ok" ? read.settings.cleanupPeriodDays : undefined;
  return isValidDays(raw) ? raw : null;
}

/**
 * A `cleanupPeriodDays` that is present but one Claude rejects. Claude does not
 * fall back to its default for it: an invalid key fails validation and the CLI
 * skips the sweep altogether — nothing is deleted.
 */
function invalidValueIn(read: UserSettingsRead): string | undefined {
  if (read.kind !== "ok" || !("cleanupPeriodDays" in read.settings)) return undefined;
  const raw = read.settings.cleanupPeriodDays;
  return isValidDays(raw) ? undefined : JSON.stringify(raw) ?? String(raw);
}

/**
 * Days the sweep currently keeps transcripts for, for the shrink comparison:
 * the configured value, Claude's default when absent, and *unbounded* when the
 * value is invalid — because then nothing is deleted, and any valid write
 * turns deletion on.
 */
function currentKeepDays(read: UserSettingsRead): number {
  if (invalidValueIn(read) !== undefined) return Number.POSITIVE_INFINITY;
  return configuredDaysIn(read) ?? CLAUDE_DEFAULT_CLEANUP_DAYS;
}

/** Does going from `current` to `next` shorten retention? Two values at or past the ceiling are both "forever", not a reduction. */
export function isShortening(current: number, next: number): boolean {
  if (current >= CLAUDE_MAX_CLEANUP_DAYS && next >= CLAUDE_MAX_CLEANUP_DAYS) return false;
  return next < current;
}

export async function getClaudeRetention(deps: ClaudeRetentionDeps = {}): Promise<ClaudeRetention> {
  const dir = claudeDir(deps);
  const settingsPath = join(dir, "settings.json");
  const read = readUserSettings(settingsPath);
  const configuredDays = configuredDaysIn(read);
  const invalidValue = invalidValueIn(read);
  const policy = await (deps.resolvePolicy ?? resolvePolicyFromSdk)();
  return {
    engine: "claude-code",
    expires: true,
    configuredDays,
    defaultDays: CLAUDE_DEFAULT_CLEANUP_DAYS,
    effectiveDays: policy?.days ?? configuredDays ?? CLAUDE_DEFAULT_CLEANUP_DAYS,
    settingsPath,
    ...(policy ? { managedBy: policy.source } : {}),
    ...(read.kind === "unreadable" ? { unreadable: read.reason } : {}),
    ...(invalidValue !== undefined ? { invalidValue } : {}),
    storagePath: join(dir, "projects"),
  };
}

export async function getEngineRetention(deps: ClaudeRetentionDeps = {}): Promise<EngineRetention[]> {
  return [
    await getClaudeRetention(deps),
    { engine: "codex", expires: false, storagePath: resolveCodexSessionsRoot() },
    { engine: "pi", expires: false, storagePath: resolvePiSessionsRoot() },
  ];
}

/**
 * The real file to write: `settingsPath` itself, or what it links to. A
 * dangling link is refused rather than replaced — whatever it pointed at is
 * the user's, and putting a plain file in its place would detach it.
 */
function writeTarget(settingsPath: string): string {
  let isLink = false;
  try {
    isLink = lstatSync(settingsPath).isSymbolicLink();
  } catch {
    return settingsPath; // does not exist yet
  }
  if (!isLink) return settingsPath;
  try {
    return realpathSync(settingsPath);
  } catch {
    throw new RetentionUpdateError(`${settingsPath} is a symlink to a file that does not exist. Fix the link and try again.`, 409);
  }
}

export interface SetClaudeRetentionOptions extends ClaudeRetentionDeps {
  /**
   * May this call shorten retention? Shortening is the only edit that deletes
   * data — every transcript past the new period goes at Claude's next start —
   * so the route only allows it from a local client.
   */
  allowShrink?: boolean;
}

/**
 * Set (or, with `null`, remove) `cleanupPeriodDays` in the user settings file.
 * Every other key is preserved. Throws {@link RetentionUpdateError} for a value
 * or a file state the caller can fix.
 */
export async function setClaudeCleanupPeriodDays(days: number | null, opts: SetClaudeRetentionOptions = {}): Promise<ClaudeRetention> {
  if (days !== null && (!isValidDays(days) || days > CLAUDE_MAX_CLEANUP_DAYS)) {
    throw new RetentionUpdateError(
      `cleanupPeriodDays must be a whole number from 1 to ${CLAUDE_MAX_CLEANUP_DAYS}, or null for Claude's default. Claude rejects 0; for "keep forever", use ${CLAUDE_MAX_CLEANUP_DAYS}.`,
      400,
    );
  }
  const dir = claudeDir(opts);
  const settingsPath = join(dir, "settings.json");

  const policy = await (opts.resolvePolicy ?? resolvePolicyFromSdk)();
  if (policy) {
    throw new RetentionUpdateError(`Claude's chat retention is set by ${policy.source}, which overrides your own settings, so changing it here would have no effect.`, 409);
  }

  const read = readUserSettings(settingsPath);
  if (read.kind === "unreadable") {
    throw new RetentionUpdateError(
      `${settingsPath} could not be parsed (${read.reason}), so Callboard will not rewrite it — that would drop your other Claude settings. Fix the file and try again.`,
      409,
    );
  }

  const nextDays = days ?? CLAUDE_DEFAULT_CLEANUP_DAYS;
  if (isShortening(currentKeepDays(read), nextDays) && !opts.allowShrink) {
    throw new RetentionUpdateError(
      "Shortening Claude's chat retention can only be done from a browser connected directly to this machine or its LAN — not from off the LAN or through a proxy (Tailscale included) — because it deletes every Claude chat older than the new period the next time Claude starts. Lengthening it is allowed from anywhere.",
      403,
    );
  }

  if (read.kind === "missing" && days === null) return getClaudeRetention(opts);
  if (!existsSync(dir)) {
    // No config dir at all means Claude has never run as this user; creating it
    // on its behalf is not this setting's job.
    throw new RetentionUpdateError(`${dir} does not exist — run Claude once so it creates its config directory, then try again.`, 409);
  }

  const settings = read.kind === "ok" ? { ...read.settings } : {};
  if (days === null) delete settings.cleanupPeriodDays;
  else settings.cleanupPeriodDays = days;

  const target = writeTarget(settingsPath);
  let mode: number | undefined;
  try {
    mode = statSync(target).mode & 0o777;
  } catch {
    mode = undefined;
  }
  try {
    atomicWriteFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, mode !== undefined ? { mode } : {});
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      // Typically a link into a read-only store (nix/home-manager): the file is
      // managed somewhere else, and that is where it has to change.
      throw new RetentionUpdateError(
        `${target === settingsPath ? settingsPath : `${settingsPath} (→ ${target})`} is not writable by Callboard (${code}). If a dotfiles tool manages it, change cleanupPeriodDays there.`,
        409,
      );
    }
    throw err;
  }
  return getClaudeRetention(opts);
}
