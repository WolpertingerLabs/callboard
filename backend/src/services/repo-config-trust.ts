/**
 * Whether a Claude Code session may run the executable configuration that the
 * folder it opens brings with it (security finding H-02).
 *
 * ## The problem
 *
 * Claude chats load `settingSources: ["user", "project", "local"]`, so the CLI
 * reads `<cwd>/.claude/settings.json` and `settings.local.json`. Anything in
 * there that is a shell command runs **before callboard's permission gate
 * (`canUseTool`) is ever consulted**, and a chat's "Code execution: Deny" did
 * not stop any of it. Reproduced against the real CLI (Agent SDK 0.3.332):
 *
 * - `hooks` (SessionStart, UserPromptSubmit, PreToolUse, …) and `statusLine`;
 * - the credential helpers `apiKeyHelper`, `awsCredentialExport`,
 *   `awsAuthRefresh` and `gcpAuthRefresh` (the last three once the repo's
 *   `env` selects Bedrock or Vertex), which `disableAllHooks` does NOT cover;
 * - stdio servers in `.mcp.json`, in cwd **or any parent directory**, also not
 *   covered by `disableAllHooks`.
 *
 * ## The fix
 *
 * {@link decideRepoConfig} runs at every session start. When it says no, the
 * session gets {@link repoLockdownSettings} as `options.settings`, the SDK's
 * flag tier (`--settings`), which outranks user, project and local settings:
 *
 * - `disableAllHooks: true` blocks settings and plugin-dir hooks and
 *   `statusLine`. A repo's own `disableAllHooks: false` doesn't undo it.
 * - every repo-overridable credential helper is pinned to the user tier's value,
 *   or to `""`, which disables it. Never `null`: an invalid value anywhere in
 *   `--settings` makes the CLI drop the **whole** flag layer, which fails open
 *   (every hook ran again). Each key here was checked against the real CLI.
 * - `disabledMcpjsonServers` names every server in the `.mcp.json` files the CLI
 *   would read. It wins over a repo's `enableAllProjectMcpServers` /
 *   `enabledMcpjsonServers`. A running CLI does not reload `.mcp.json`, so a
 *   server added mid-session is not started until the next session start, which
 *   scans again (verified: written between two turns of one process, it never
 *   spawned, locked down or not).
 *
 * Callboard's own app-plugin hooks are SDK callbacks (`buildHookOptions`), not
 * settings hooks, and keep running. `claude.repoHooks.sdk.test.ts` checks all
 * of this through `sendMessage` against the real CLI, with a positive control.
 *
 * ## Why not `managedSettings`, and what it costs
 *
 * The SDK drops `managedSettings` whenever the machine has an admin managed
 * tier, and there it binds `disableAllHooks` only as `allowManagedHooksOnly`:
 * built on it, the fix would fail open on managed machines.
 *
 * `disableAllHooks` covers every tier, so the operator's own `~/.claude` hooks
 * and `statusLine` are off in a locked-down session too. Nothing in the SDK
 * separates them, and re-running them ourselves as SDK callbacks would be a
 * faithfulness risk (a slightly wrong port of a PreToolUse guard fails open).
 * The UI notice and the README say so.
 *
 * ## Trust
 *
 * The decision is {@link decideRepoConfig}: never unless Code execution is
 * Allow, then per the `claudeProjectHooks` setting. Trust keys on the
 * **directory** (see .claude/CLAUDE.md, workspace keying): a trusted folder
 * covers everything below it, and a linked git worktree of a trusted repo
 * whose admin dir points back at it. The store lives in the data dir, never in
 * the repo. Only the operator grants trust (the HTTP routes are session-only,
 * plus `callboard trust`); no agent tool can, by design.
 *
 * Same idea as pi's project-trust handling: `agents/adapters/pi/optionsAdapter.ts`.
 *
 * Keep this module light: `bin/callboard.js` imports its built form.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve, sep } from "path";
import { DATA_DIR } from "../utils/paths.js";
import { atomicWriteFileSync } from "../utils/atomic-write.js";
import { resolveWorktreeToMainRepo } from "../utils/git.js";
import type { PermissionLevel } from "shared/types/index.js";

export type ClaudeProjectHooksMode = "trusted" | "always" | "never";

export interface TrustedFolder {
  /** Realpath of the trusted directory. */
  path: string;
  /** ISO timestamp. */
  addedAt: string;
}

export const TRUSTED_FOLDERS_FILE = join(DATA_DIR, "trusted-folders.json");

/**
 * Credential and header helpers a project or local settings file can set, each
 * a shell command the CLI runs on its own. Every one was confirmed against the
 * real CLI to accept `""` in the flag tier.
 */
export const REPO_HELPER_KEYS = ["apiKeyHelper", "awsCredentialExport", "awsAuthRefresh", "gcpAuthRefresh", "otelHeadersHelper", "proxyAuthHelper"] as const;

// ── Store ────────────────────────────────────────────────────────────────────

/** The trusted folders. A missing or unreadable store reads as none: trust fails closed. */
export function readTrustedFolders(): TrustedFolder[] {
  try {
    const parsed = JSON.parse(readFileSync(TRUSTED_FOLDERS_FILE, "utf-8")) as { folders?: unknown };
    if (!Array.isArray(parsed.folders)) return [];
    return parsed.folders.filter(
      (f): f is TrustedFolder => !!f && typeof f === "object" && typeof (f as TrustedFolder).path === "string" && (f as TrustedFolder).path.startsWith("/"),
    );
  } catch {
    return [];
  }
}

function writeTrustedFolders(folders: TrustedFolder[]): void {
  mkdirSync(dirname(TRUSTED_FOLDERS_FILE), { recursive: true });
  atomicWriteFileSync(TRUSTED_FOLDERS_FILE, JSON.stringify({ version: 1, folders }, null, 2) + "\n", { mode: 0o600 });
}

/**
 * Trust `path` (stored as its realpath). Throws on a path that doesn't exist,
 * isn't a directory, or is the filesystem root (use the `always` mode for that).
 */
export function trustFolder(path: string): TrustedFolder {
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    throw new Error(`Folder does not exist: ${path}`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`Not a directory: ${path}`);
  if (real === sep) throw new Error("Refusing to trust the filesystem root. Set Repository hooks to “Whenever code execution is allowed” instead.");
  const folders = readTrustedFolders();
  const existing = folders.find((f) => f.path === real);
  if (existing) return existing;
  const entry = { path: real, addedAt: new Date().toISOString() };
  writeTrustedFolders([...folders, entry]);
  return entry;
}

/** Remove trust for `path` (matched by realpath, or literally for a folder since deleted). Returns whether anything was removed. */
export function untrustFolder(path: string): boolean {
  const candidates = new Set([resolve(path)]);
  try {
    candidates.add(realpathSync(resolve(path)));
  } catch {
    /* gone: the literal path is all we have */
  }
  const folders = readTrustedFolders();
  const kept = folders.filter((f) => !candidates.has(f.path));
  if (kept.length === folders.length) return false;
  writeTrustedFolders(kept);
  return true;
}

// ── Matching ─────────────────────────────────────────────────────────────────

/** The trusted entry `real` sits at or under (on a path-segment boundary), if any. */
function coveringEntry(real: string, folders: TrustedFolder[]): TrustedFolder | undefined {
  return folders.find((f) => real === f.path || real.startsWith(f.path.endsWith(sep) ? f.path : f.path + sep));
}

/**
 * The main repository of the linked worktree containing `real`, but only when
 * the worktree checks out both ways: its `.git` file names an admin dir under
 * `<main>/.git/worktrees/`, **and** that admin dir's `gitdir` file points back
 * at this worktree's `.git`. Without the back-pointer, any folder could plant a
 * `.git` file aimed into a trusted repo and inherit its trust.
 */
function verifiedWorktreeMainRepo(real: string): string | undefined {
  // The nearest ancestor holding a `.git` is the checkout `real` belongs to.
  let dir = real;
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      if (!lstatSync(dotGit).isFile()) return undefined; // a main checkout, not a worktree
      const res = resolveWorktreeToMainRepo(dir);
      if (!res.isWorktree || !res.adminDir) return undefined;
      const back = readFileSync(join(res.adminDir, "gitdir"), "utf-8").trim();
      if (realpathSync(resolve(res.adminDir, back)) !== realpathSync(dotGit)) return undefined;
      return realpathSync(res.mainRepoPath);
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Whether `cwd` is trusted: it is (or is under) a trusted folder, or it is in
 * a verified linked worktree of a repo that is. Never throws.
 */
export function isFolderTrusted(cwd: string): { trusted: boolean; root?: string } {
  try {
    const folders = readTrustedFolders();
    if (folders.length === 0) return { trusted: false };
    const real = realpathSync(resolve(cwd));
    const direct = coveringEntry(real, folders);
    if (direct) return { trusted: true, root: direct.path };
    const main = verifiedWorktreeMainRepo(real);
    const viaWorktree = main ? coveringEntry(main, folders) : undefined;
    if (viaWorktree) return { trusted: true, root: viaWorktree.path };
  } catch {
    /* fall through: untrusted */
  }
  return { trusted: false };
}

// ── Decision ─────────────────────────────────────────────────────────────────

export type RepoConfigReason = "trusted" | "always" | "code-execution-not-allowed" | "untrusted-folder" | "setting-never";

export interface RepoConfigDecision {
  run: boolean;
  reason: RepoConfigReason;
  trustRoot?: string;
}

/** An unknown or absent mode is the default, `"trusted"`. */
export function normalizeClaudeProjectHooksMode(v: unknown): ClaudeProjectHooksMode {
  return v === "always" || v === "never" ? v : "trusted";
}

/**
 * Run the folder's executable Claude config only when Code execution is Allow
 * (Ask counts as Deny: a SessionStart hook can't be asked about) and the mode
 * allows it in this folder.
 */
export function decideRepoConfig(input: {
  cwd: string;
  codeExecution: PermissionLevel | null | undefined;
  mode: ClaudeProjectHooksMode | undefined;
}): RepoConfigDecision {
  if (input.codeExecution !== "allow") return { run: false, reason: "code-execution-not-allowed" };
  const mode = normalizeClaudeProjectHooksMode(input.mode);
  if (mode === "never") return { run: false, reason: "setting-never" };
  if (mode === "always") return { run: true, reason: "always" };
  const trust = isFolderTrusted(input.cwd);
  return trust.trusted ? { run: true, reason: "trusted", trustRoot: trust.root } : { run: false, reason: "untrusted-folder" };
}

// ── Scan (display, logs and the .mcp.json name list only, never execution) ──

export interface RepoExecutableConfig {
  /** Hook events defined in `<cwd>/.claude/settings.json` / `settings.local.json`. */
  hookEvents: string[];
  /** A `statusLine` (or `subagentStatusLine`) command is defined there. */
  statusLine: boolean;
  /** Credential helpers ({@link REPO_HELPER_KEYS}) defined there. */
  helpers: string[];
  /** Servers named in `.mcp.json` in cwd or any parent. */
  mcpJsonServers: string[];
}

function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** `dir` and each of its parents, up to the root. */
function selfAndAncestors(dir: string): string[] {
  const out: string[] = [];
  for (let d = resolve(dir); ; d = dirname(d)) {
    out.push(d);
    if (dirname(d) === d) return out;
  }
}

/** Names of the stdio/remote servers in every `.mcp.json` the CLI reads for `cwd` (cwd and its parents, as given and as realpath). */
export function mcpJsonServerNames(cwd: string): string[] {
  const dirs = new Set(selfAndAncestors(cwd));
  try {
    for (const d of selfAndAncestors(realpathSync(resolve(cwd)))) dirs.add(d);
  } catch {
    /* missing cwd: the literal chain is all there is */
  }
  const names = new Set<string>();
  for (const d of dirs) {
    const servers = readJsonObject(join(d, ".mcp.json"))?.mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) for (const name of Object.keys(servers)) names.add(name);
  }
  return [...names].sort();
}

/** What executable config `cwd` defines. Missing or malformed files count as defining nothing. */
export function scanRepoExecutableConfig(cwd: string): RepoExecutableConfig {
  const hookEvents = new Set<string>();
  const helpers = new Set<string>();
  let statusLine = false;
  for (const file of ["settings.json", "settings.local.json"]) {
    const s = readJsonObject(join(cwd, ".claude", file));
    if (!s) continue;
    if (s.hooks && typeof s.hooks === "object" && !Array.isArray(s.hooks)) {
      for (const [event, matchers] of Object.entries(s.hooks)) if (Array.isArray(matchers) && matchers.length > 0) hookEvents.add(event);
    }
    if (s.statusLine || s.subagentStatusLine) statusLine = true;
    for (const key of REPO_HELPER_KEYS) if (typeof s[key] === "string" && (s[key] as string).trim() !== "") helpers.add(key);
  }
  return { hookEvents: [...hookEvents].sort(), statusLine, helpers: [...helpers].sort(), mcpJsonServers: mcpJsonServerNames(cwd) };
}

export function definesAnything(scan: RepoExecutableConfig): boolean {
  return scan.hookEvents.length > 0 || scan.statusLine || scan.helpers.length > 0 || scan.mcpJsonServers.length > 0;
}

// ── Lockdown ─────────────────────────────────────────────────────────────────

export interface RepoLockdownSettings {
  disableAllHooks: true;
  apiKeyHelper: string;
  awsCredentialExport: string;
  awsAuthRefresh: string;
  gcpAuthRefresh: string;
  otelHeadersHelper: string;
  proxyAuthHelper: string;
  disabledMcpjsonServers?: string[];
}

/**
 * The flag-tier settings for a session whose folder config must not run.
 * `env` is the environment the CLI will get: its CLAUDE_CONFIG_DIR (or HOME)
 * says where the user tier lives, whose helper values are kept.
 *
 * Every value is a string, `true` or a string array: see the module comment on
 * why a `null` here would fail open.
 */
export function repoLockdownSettings(cwd: string, env: Record<string, string | undefined> = process.env): RepoLockdownSettings {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".claude");
  const user = readJsonObject(join(configDir, "settings.json")) ?? {};
  const pinned = (key: (typeof REPO_HELPER_KEYS)[number]): string => (typeof user[key] === "string" ? (user[key] as string) : "");
  const servers = mcpJsonServerNames(cwd);
  return {
    disableAllHooks: true,
    apiKeyHelper: pinned("apiKeyHelper"),
    awsCredentialExport: pinned("awsCredentialExport"),
    awsAuthRefresh: pinned("awsAuthRefresh"),
    gcpAuthRefresh: pinned("gcpAuthRefresh"),
    otelHeadersHelper: pinned("otelHeadersHelper"),
    proxyAuthHelper: pinned("proxyAuthHelper"),
    ...(servers.length > 0 && { disabledMcpjsonServers: servers }),
  };
}
