import { statSync, existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Default ignored project-dir prefixes.
 *
 * Project dirs under ~/.claude/projects/ are slugified absolute paths
 * (each `/` becomes `-`). Any project dir that *is* one of these entries, or
 * lies under it, is hidden from chat listings and skipped by chat search —
 * including a folder-scoped search that names it outright. Every provider's
 * `searchSessions` applies the list unconditionally; none of them treat naming
 * a directory as a request to un-ignore it.
 *
 * "Under it" is a path relation, not a string one — see
 * {@link matchesIgnoredPrefix} for why, and for what a trailing `-` means.
 *
 * - "-tmp" — `/tmp` and `/tmp/...` throwaway transcripts (created by
 *   quick-completion, sdk-info, and other SDK callers that pass `cwd: tmpdir()`).
 * - "-private-" — macOS resolves `/tmp` to `/private/tmp`; the SDK
 *   sometimes records the realpath, slugifying as `-private-tmp...`.
 *   The trailing separator makes this the whole `/private/` subtree.
 */
export const DEFAULT_IGNORED_PROJECT_DIR_PREFIXES: readonly string[] = ["-tmp", "-private-"];

/** JSON file persisting the user's configured ignored prefixes. */
const IGNORED_DIRS_CONFIG_FILE = join(process.env.CALLBOARD_DATA_DIR || join(homedir(), ".callboard"), "ignored-project-dirs.json");

let _ignoredPrefixesCache: string[] | null = null;

/**
 * What a project-dir prefix may contain.
 *
 * Project dirs under `~/.claude/projects/` are slugified absolute paths — every
 * non-alphanumeric character becomes `-` (see {@link folderToProjectDir}) — so a
 * prefix that can ever match one contains nothing but `[A-Za-z0-9-]`. Anything
 * else was already inert: it could not match a directory name however it was
 * spelled.
 *
 * It was not inert everywhere, though, and that is why this exists.
 * `ClaudeCodeSessionProvider._discoverPaginated` interpolated these values into
 * a shell command string, so `PUT /api/ignored-project-dirs` — which validated
 * only "an array of strings" — was remote command execution for any
 * authenticated client. The `find` call is an argv array now, which closes it
 * structurally; this is the second layer, and the one that also protects any
 * future consumer that reaches for a string again.
 *
 * Applied on **read** as well as on write, because the file is on disk and a
 * hand-edited or restored one must not be trusted either.
 */
export const IGNORED_PREFIX_PATTERN = /^[A-Za-z0-9-]+$/;

/** True when `prefix` could name (the start of) a real slugified project dir. */
export function isValidIgnoredPrefix(prefix: unknown): prefix is string {
  return typeof prefix === "string" && prefix.length > 0 && prefix.length <= 128 && IGNORED_PREFIX_PATTERN.test(prefix);
}

/**
 * Read the user-configured ignored project-dir prefixes from disk.
 * Falls back to defaults if no config file exists or it's malformed.
 * Results are cached in-memory and invalidated by saveIgnoredProjectDirPrefixes().
 */
export function getIgnoredProjectDirPrefixes(): string[] {
  if (_ignoredPrefixesCache) return _ignoredPrefixesCache;
  try {
    if (existsSync(IGNORED_DIRS_CONFIG_FILE)) {
      const raw = readFileSync(IGNORED_DIRS_CONFIG_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.prefixes)) {
        // Filtered rather than merely type-checked — see IGNORED_PREFIX_PATTERN.
        // A prefix outside the slug charset can never match a project dir, so
        // dropping it costs nothing and keeps a hand-edited file from smuggling
        // one past the route's validation.
        const cleaned = parsed.prefixes.filter(isValidIgnoredPrefix);
        _ignoredPrefixesCache = cleaned;
        return cleaned;
      }
    }
  } catch {
    // Fall through to defaults on any error
  }
  _ignoredPrefixesCache = [...DEFAULT_IGNORED_PROJECT_DIR_PREFIXES];
  return _ignoredPrefixesCache;
}

/**
 * Persist the user's configured ignored project-dir prefixes.
 * Writes to ~/.callboard/ignored-project-dirs.json and refreshes the cache.
 */
export function saveIgnoredProjectDirPrefixes(prefixes: string[]): string[] {
  // Normalize: trim, drop empties, dedupe, preserve order
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const p of prefixes) {
    if (typeof p !== "string") continue;
    const trimmed = p.trim();
    if (!isValidIgnoredPrefix(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }

  // Ensure data dir exists before writing
  const dataDir = process.env.CALLBOARD_DATA_DIR || join(homedir(), ".callboard");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  writeFileSync(IGNORED_DIRS_CONFIG_FILE, JSON.stringify({ prefixes: cleaned }, null, 2));
  _ignoredPrefixesCache = cleaned;
  return cleaned;
}

/**
 * What a path separator looks like inside a project-dir name.
 *
 * `folderToProjectDir` turns every non-alphanumeric character into `-`, so in
 * the encoded form a `/` *is* a `-`. That is the only separator the matcher can
 * see: the encoding is lossy, so a `-` may have been a `/`, a `.`, a `_`, a
 * space or a literal `-`, and nothing downstream can tell which. Matching in
 * encoded space is deliberate all the same — it is the one representation all
 * three consumers share (see {@link matchesIgnoredPrefix}).
 */
const ENCODED_SEPARATOR = "-";

/**
 * True when the project-dir name `dirName` is `prefix` itself, or a path
 * *below* it — and not merely a name that happens to begin with the same
 * characters.
 *
 * ## Why the boundary
 *
 * This was a bare `startsWith`, so an entry for `/home/scratch` (`-home-scratch`)
 * also hid `/home/scratchpad-repo` (`-home-scratchpad-repo`) — a directory the
 * user never named and could not un-hide without deleting the entry that hides
 * the one they did name. Before chat search honoured the list that only cost
 * them a listing; since it does, such a folder has no in-app route at all.
 *
 * The rule is the one `chat-search.ts` already applies when it matches a target
 * folder against its worktrees: exact name, or the prefix followed by the
 * encoded separator.
 *
 * ## The trailing-separator form
 *
 * A prefix that *already* ends in `-` — `-private-`, one of the two built-in
 * defaults — is a directory boundary as written: it means "everything under
 * `/private/`". Demanding a further separator after it would break it (encoded
 * `/private/tmp/x` is `-private-tmp-x`, which never has `--`), so a trailing
 * separator is accepted as the boundary it already is.
 *
 * It is back-compat for that default and nothing more; it is not an escape
 * hatch for an entry this fix narrows. The trailing form is strictly *narrower*
 * than the bare one — `-tmp-` matches everything under `/tmp` but not `/tmp`
 * itself, where `-tmp` matches both — so a user whose entry was over-broad in
 * the sense above gains nothing by adding the `-`. The repair for that is a
 * second entry naming the other directory.
 *
 * ## Kept in step with `find`
 *
 * `ClaudeCodeSessionProvider._discoverPaginated` prunes with `find -path`
 * rather than calling this. {@link ignoredPrefixGlobs} generates those globs
 * from the same two branches so the two cannot drift; `ignored-prefix-boundary.test.ts`
 * runs a real `find` over a fixture and asserts the surviving set matches.
 */
export function matchesIgnoredPrefix(dirName: string, prefix: string): boolean {
  if (!dirName.startsWith(prefix)) return false;
  if (dirName.length === prefix.length) return true;
  if (prefix.endsWith(ENCODED_SEPARATOR)) return true;
  return dirName[prefix.length] === ENCODED_SEPARATOR;
}

/**
 * The `find -path` glob suffixes that prune exactly the directories
 * {@link matchesIgnoredPrefix} matches, and no others.
 *
 * Two patterns for an ordinary prefix because `find`'s `-path` has no way to
 * say "or end here" in one glob. Safe to interpolate: a prefix is
 * `[A-Za-z0-9-]` only (see {@link IGNORED_PREFIX_PATTERN}), so it can carry no
 * glob metacharacter of its own — and the caller passes these as literal argv
 * tokens, never through a shell.
 */
export function ignoredPrefixGlobs(prefix: string): string[] {
  if (prefix.endsWith(ENCODED_SEPARATOR)) return [`${prefix}*`];
  return [prefix, `${prefix}${ENCODED_SEPARATOR}*`];
}

/**
 * True if the given project-dir name (e.g. "-tmp-xyz" or "-Users-foo-repo")
 * is, or lies under, any configured ignore prefix.
 */
export function isIgnoredProjectDir(dirName: string): boolean {
  for (const prefix of getIgnoredProjectDirPrefixes()) {
    if (matchesIgnoredPrefix(dirName, prefix)) return true;
  }
  return false;
}

/**
 * Slugify an absolute folder path into the project-dir name form the Claude
 * SDK uses (every non-alphanumeric char → `-`), then test it against the
 * configured ignore prefixes.
 *
 * Use this when you hold a raw folder path rather than an already-slugified
 * project-dir name — the shape every provider that records its `cwd` verbatim
 * hands you (Codex among them). The Claude provider's dirs are pre-slugified on
 * disk, so it calls {@link isIgnoredProjectDir} directly; this keeps every
 * provider checking the same prefixes against the same representation.
 *
 * Encoding *first*, rather than comparing `/`-separated paths, is what makes
 * that true. It costs a little precision — the encoded separator is ambiguous,
 * so `-home-scratch` also matches `/home/scratch-pad`, which is not a child of
 * `/home/scratch` — but the alternative is a folder-side rule strictly tighter
 * than the dir-name-side one, and the two disagreeing about the same folder is
 * the bigger bug. The prefixes are written against encoded names; they are
 * matched against encoded names.
 */
export function isIgnoredProjectFolder(folderPath: string): boolean {
  if (typeof folderPath !== "string" || folderPath.length === 0) return false;
  return isIgnoredProjectDir(folderPath.replace(/[^a-zA-Z0-9]/g, "-"));
}

/**
 * Read ~/.claude/projects/ and return the project dir names that aren't
 * on the ignore list. Safe to call when the dir doesn't exist.
 */
export function listClaudeProjectDirs(): string[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];
  try {
    return readdirSync(CLAUDE_PROJECTS_DIR).filter((d) => !isIgnoredProjectDir(d));
  } catch {
    return [];
  }
}

/*
 * ── Claude binary resolution lives in services/claude-binary.ts ─────
 *
 * It used to live here, as a second resolver that ignored the
 * `pathToClaudeCodeExecutable` setting and fell back to the bare string
 * `"claude"`. Merging it with the settings-aware one in `agent-settings.ts` is
 * what this module could not do: settings imports `DATA_DIR` from here, so
 * importing settings from here is a cycle. The resolution moved *down* the
 * graph instead — see `services/claude-binary.ts` for the whole argument.
 */

/**
 * Absolute path to the Callboard data directory.
 * Defaults to ~/.callboard; override with CALLBOARD_DATA_DIR env var
 * (e.g. ~/.callboard-dev for development).
 */
export const DATA_DIR = process.env.CALLBOARD_DATA_DIR || join(homedir(), ".callboard");

/** Path to the primary .env file inside the data directory. */
export const ENV_FILE = join(DATA_DIR, ".env");

/**
 * Base directory for agent workspaces (~/.callboard/agent-workspaces by default).
 * Override via CALLBOARD_WORKSPACES_DIR (or legacy CCUI_AGENTS_DIR).
 */
export const WORKSPACES_DIR =
  process.env.CALLBOARD_WORKSPACES_DIR ||
  process.env.CCUI_AGENTS_DIR || // backward compat
  join(DATA_DIR, "agent-workspaces");

/** Default MCP config directory for local proxy mode. */
export const DEFAULT_MCP_LOCAL_DIR = join(DATA_DIR, ".drawlatch.local");

/** Default MCP config directory for remote proxy mode. */
export const DEFAULT_MCP_REMOTE_DIR = join(DATA_DIR, ".drawlatch.remote");

/** @deprecated Old local directory name, kept for migration only. */
export const LEGACY_MCP_LOCAL_DIR = join(DATA_DIR, ".drawlatch");

/** @deprecated Old remote directory name, kept for migration only. */
export const LEGACY_MCP_REMOTE_DIR = join(DATA_DIR, ".drawlatch-remote");

/** Ensure the data directory exists (idempotent, safe to call multiple times). */
export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Default .env template scaffolded on first run. */
const ENV_TEMPLATE = `# Callboard configuration
# See .env.example in the project repo for all available options.

# Authentication — set a password with: callboard set-password
# The hashed password and salt are stored below (never store plaintext).
# AUTH_PASSWORD_HASH=
# AUTH_PASSWORD_SALT=

# Port for the application (defaults to 8000)
# PORT=8000

# Log level for backend output (error, warn, info, debug). Default: info
# LOG_LEVEL=info

# Session cookie name (optional, defaults to "callboard_session")
# SESSION_COOKIE_NAME=
`;

/**
 * Scaffold a default ~/.callboard/.env if one does not exist.
 * Returns true if a new file was created (first run), false otherwise.
 */
export function ensureEnvFile(): boolean {
  ensureDataDir();
  if (existsSync(ENV_FILE)) return false;
  writeFileSync(ENV_FILE, ENV_TEMPLATE, { mode: 0o600 });
  return true;
}

// ── Instance Naming ──────────────────────────────────────────────────

const INSTANCE_NAME_WORDS = [
  "cherry",
  "blossom",
  "willow",
  "maple",
  "cedar",
  "birch",
  "oak",
  "pine",
  "fern",
  "moss",
  "river",
  "brook",
  "meadow",
  "valley",
  "ridge",
  "canyon",
  "cliff",
  "cove",
  "reef",
  "dune",
  "coral",
  "pebble",
  "flint",
  "amber",
  "jade",
  "opal",
  "ruby",
  "pearl",
  "crystal",
  "quartz",
  "daisy",
  "iris",
  "lily",
  "poppy",
  "sage",
  "clover",
  "violet",
  "jasmine",
  "orchid",
  "lotus",
  "thistle",
  "ivy",
  "holly",
  "laurel",
  "basil",
  "thyme",
  "mint",
  "rosemary",
  "lavender",
  "buttercup",
  "dawn",
  "dusk",
  "aurora",
  "ember",
  "spark",
  "frost",
  "breeze",
  "gale",
  "mist",
  "haze",
  "cloud",
  "rain",
  "snow",
  "storm",
  "thunder",
  "lightning",
  "rainbow",
  "starlight",
  "moonbeam",
  "sunray",
  "crimson",
  "scarlet",
  "golden",
  "silver",
  "cobalt",
  "indigo",
  "teal",
  "ivory",
  "onyx",
  "robin",
  "wren",
  "finch",
  "falcon",
  "heron",
  "crane",
  "dove",
  "swift",
  "lark",
  "raven",
  "fox",
  "wolf",
  "bear",
  "deer",
  "otter",
  "badger",
  "hare",
  "lynx",
  "hawk",
  "owl",
];

export function generateInstanceName(): string {
  const pick = () => INSTANCE_NAME_WORDS[Math.floor(Math.random() * INSTANCE_NAME_WORDS.length)];
  const a = pick();
  let b: string, c: string;
  do {
    b = pick();
  } while (b === a);
  do {
    c = pick();
  } while (c === a || c === b);
  return `${a}-${b}-${c}`;
}

/**
 * Ensure INSTANCE_NAME is set in the .env file.
 * If not present, generates a random name and appends it.
 */
export function ensureInstanceName(): string {
  ensureEnvFile();
  const contents = readFileSync(ENV_FILE, "utf-8");
  const match = contents.match(/^INSTANCE_NAME=(.+)$/m);
  if (match) return match[1].trim();

  const name = generateInstanceName();
  appendFileSync(ENV_FILE, `\n# Friendly name for this Callboard instance\nINSTANCE_NAME=${name}\n`);
  process.env.INSTANCE_NAME = name;
  return name;
}

/** Get the current instance name. */
export function getInstanceName(): string {
  return process.env.INSTANCE_NAME || ensureInstanceName();
}

/** Update the instance name in the .env file and process.env. */
export function saveInstanceName(name: string): void {
  ensureEnvFile();
  const contents = readFileSync(ENV_FILE, "utf-8");
  const regex = /^INSTANCE_NAME=.+$/m;
  let updated: string;
  if (regex.test(contents)) {
    updated = contents.replace(regex, `INSTANCE_NAME=${name}`);
  } else {
    updated = contents + `\n# Friendly name for this Callboard instance\nINSTANCE_NAME=${name}\n`;
  }
  writeFileSync(ENV_FILE, updated, { mode: 0o600 });
  process.env.INSTANCE_NAME = name;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Encode a folder path into the SDK's project-directory name — the forward
 * direction of {@link projectDirToFolder}, and the exact transform the Claude
 * Agent SDK applies when it decides where a session's JSONL lives.
 *
 * Lossy by nature (`/`, `.`, `_` and spaces all collapse to `-`), which is why
 * the inverse needs a filesystem-probing heuristic. Encoding is unambiguous
 * though, so writers that need to place a file for a known cwd can use this
 * directly.
 */
export function folderToProjectDir(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Convert a project directory name back to a folder path.
 * The SDK encodes paths by replacing ALL non-alphanumeric chars with -, so
 * "-home-cybil-my-app" is ambiguous (could be /home/cybil/my-app or
 * /home/cybil/my/app, or even /home/cybil/my.app).
 *
 * The encoding regex is: replace(/[^a-zA-Z0-9]/g, "-")
 * This means /, ., _, spaces, etc. all become dashes.
 *
 * Uses a greedy left-to-right algorithm: at each dash boundary, check if
 * treating it as a "/" yields an existing directory. If so, commit the split.
 * If not, check if treating it as a "." yields a valid directory prefix
 * (handles periods in intermediate folder names like /path/.callboard/src
 * or /path/v2.0/src). Otherwise, keep it as a "-" in the current segment.
 *
 * After the initial greedy pass, if the final resolved path doesn't exist,
 * we try replacing dashes with dots in each segment since dots in folder names
 * (e.g. worktree names like "repo.branch-name") are the most common source
 * of ambiguity. We also try merging incorrectly-split segments back together
 * with dots for cases where the greedy algorithm split at a directory that
 * happened to exist by coincidence.
 *
 * ## Memoised — see {@link projectDirToFolder}
 *
 * This is the uncached body. Every caller should go through the wrapper, which
 * is what makes the decode affordable on a listing path; see its doc comment
 * for why the answer is safe to reuse.
 */
function resolveProjectDirToFolder(dirName: string): string {
  // Strip leading dash (represents the root /)
  const rawParts = dirName.slice(1).split("-");

  // Pre-process: merge empty parts (from double-dashes) with the following
  // non-empty part as a dot-prefixed segment.
  //
  // Double-dashes arise when the original path had consecutive non-alphanumeric
  // characters — most commonly a path separator followed by a dot (hidden dirs):
  //   /Users/me/.callboard → -Users-me--callboard
  //
  // After split("-"): ["Users", "me", "", "callboard"]
  // After merging:    ["Users", "me", ".callboard"]
  const parts: string[] = [];
  let dotPrefix = "";
  for (const part of rawParts) {
    if (part === "") {
      dotPrefix += ".";
    } else {
      parts.push(dotPrefix + part);
      dotPrefix = "";
    }
  }
  // Discard trailing dot accumulator when no non-empty parts were found.
  // This handles the root case: "-" → rawParts = [""] → parts stays empty → "/".
  if (dotPrefix && parts.length > 0) parts.push(dotPrefix);

  if (parts.length === 0) return "/";

  // Build the path greedily from left to right
  const resolvedSegments: string[] = [];
  let currentSegment = parts[0];

  for (let i = 1; i < parts.length; i++) {
    // Try treating the dash as a "/" — does the path so far exist as a directory?
    const candidatePath = "/" + [...resolvedSegments, currentSegment].join("/");
    if (isDirectory(candidatePath)) {
      // Commit this segment and start a new one
      resolvedSegments.push(currentSegment);
      currentSegment = parts[i];
    } else {
      // Before falling back to dash, check if the dash was originally a dot.
      // If treating it as "." creates a valid directory prefix, use that.
      // This handles periods in intermediate directory names (e.g. hidden
      // dirs like ~/.callboard/ or versioned dirs like /path/v2.0/src).
      const dotSegment = currentSegment + "." + parts[i];
      const dotPath = "/" + [...resolvedSegments, dotSegment].join("/");
      if (isDirectory(dotPath)) {
        currentSegment = dotSegment;
      } else {
        // Keep the dash as a literal "-" in the current segment
        currentSegment += "-" + parts[i];
      }
    }
  }

  // Append the final segment (doesn't need to be a directory itself)
  resolvedSegments.push(currentSegment);

  const resolved = "/" + resolvedSegments.join("/");

  // If the resolved path exists, return it directly
  if (pathExists(resolved)) return resolved;

  // The path doesn't exist — the greedy algorithm likely split at a directory
  // that happened to exist, creating a wrong path. Try two recovery strategies:
  //
  // Strategy 1: Filesystem scan recovery — look at the actual directory listing
  // of each candidate parent to find an entry whose encoding matches the merged
  // segments. This handles ALL special characters (periods, dashes, underscores,
  // spaces, etc.) in a unified way.
  //
  // Strategy 2: Dot substitution recovery (legacy) — try replacing dashes with
  // dots within/across segments. Kept as a fallback for edge cases where scan
  // recovery can't find a match (e.g. parent directory not readable).
  const scanFixed = tryScanRecovery(resolvedSegments);
  if (scanFixed) return scanFixed;

  const dotFixed = tryDotRecovery(resolvedSegments);
  if (dotFixed) return dotFixed;

  // Return the greedy result as best effort
  return resolved;
}

/**
 * Decoded folder paths, keyed by project-dir name.
 *
 * The key space is the set of directory names in `~/.claude/projects/`, so this
 * is bounded by what discovery already enumerates — it cannot grow on
 * attacker-chosen input.
 */
const projectDirFolderCache = new Map<string, { folder: string; expiresAt: number }>();

/**
 * How long a decode is reused, on average. Matches the git-info and disk-usage
 * memos in this codebase so all three freshness windows are the same number.
 *
 * It is a *mean* rather than a fixed span — see {@link jitteredExpiry}.
 */
const PROJECT_DIR_CACHE_TTL = 300_000;

/**
 * When an entry minted now should expire: uniformly in [½·TTL, 1½·TTL), so the
 * mean is exactly {@link PROJECT_DIR_CACHE_TTL}.
 *
 * ## Why the spread, and why it is on this memo and not the others
 *
 * Every entry in this map is minted by the *same request* — the first listing,
 * which decodes all ~83 project-dir names in one synchronous pass — so with a
 * fixed TTL every entry also expires in the same millisecond. The sidebar polls
 * every fifteen seconds, so whichever poll lands past the boundary re-decodes
 * all of them at once. Measured on the profiled corpus: **49.8 ms of blocked
 * event loop, recurring every five minutes** for as long as a tab is open.
 *
 * That is the same shape as the `git branch --show-current` herd this change
 * set removed, but it does not have the same fix available. The git spike was
 * cured by making the underlying read cheap — a subprocess became a file read.
 * A decode cannot be made cheap: it *is* filesystem probing, and probing is the
 * answer, not an implementation detail of it. So the refills are spread instead
 * of eliminated. Same total work, ~2–3 ms per poll rather than 49.8 ms on one
 * poll in twenty.
 *
 * The freshness contract is unchanged in the way that matters: the mean window
 * is still five minutes, and the *maximum* staleness rises from 300 s to 450 s
 * for what the TTL is actually left covering — a best-effort decode of a missing
 * path resolving differently once an unrelated directory appears by hand. See
 * {@link projectDirToFolder} for why that residue is all the TTL is for; every
 * move Callboard makes itself goes through {@link clearProjectDirFolderCache}
 * and is unaffected by any of this.
 *
 * Not applied to the git-info memo, deliberately: refilling all of it costs
 * ~12 ms now that the branch is read rather than spawned for, and there is no
 * herd worth breaking up at that price.
 */
function jitteredExpiry(now: number): number {
  return now + PROJECT_DIR_CACHE_TTL * (0.5 + Math.random());
}

/**
 * Drop every memoised decode.
 *
 * Called wherever Callboard itself moves a directory it might have decoded:
 * `quarantineDirectory` (utils/worktree-trash.ts) when a worktree goes to the
 * trash, and `restoreTrashEntry` (services/workspace-trash.ts) when it comes
 * back. Those two are a pair and the restore is the one that needs it — see the
 * note on {@link projectDirToFolder}. Also used by tests that re-ask one name
 * against different filesystems.
 */
export function clearProjectDirFolderCache(): void {
  projectDirFolderCache.clear();
}

/**
 * Convert a project directory name back to a folder path, memoised.
 *
 * See {@link resolveProjectDirToFolder} for the decoding algorithm. This
 * wrapper exists because the decode is *filesystem probing* — `statSync` per
 * candidate split, a `readdirSync` scan, and for an unresolvable name a
 * combinatorial dash/dot search — and the callers ask the same question over
 * and over. `_discoverPaginated` calls it **once per transcript file**: 1518
 * calls across 83 distinct names on the machine this was profiled on, an 18x
 * redundancy factor, for 79 ms of blocked event loop on every listing request.
 *
 * ## Why reusing the answer is safe, and the one case where it is not
 *
 * The decode is a function of the name *and* of which directories exist, so a
 * memoised answer can only be wrong when the second half changes underneath it.
 * The common shapes are benign:
 *
 * - A directory at a path Callboard has never seen gets a project-dir name it
 *   has never decoded, so it is a new key and is decoded fresh.
 * - A directory that is deleted keeps its name and its decoded path, which is
 *   still the right answer — the path is simply gone now, and callers that care
 *   (`GET /api/chats/folders` via `directoryExists`) test for that themselves.
 *
 * The case that is **not** benign is a path that comes *back*: a worktree
 * removed and recreated where it was, or archive-then-restore. The name is not
 * new, so it is not decoded fresh, and a decode taken while the directory was
 * absent is a best-effort guess that may name a path which never existed. That
 * guess would outlive the directory's return and hide its row for up to the
 * TTL. It is why {@link clearProjectDirFolderCache} is wired into both halves
 * of the quarantine/restore pair rather than left for tests.
 *
 * What the TTL is left covering is the residue: a name that resolved to a
 * missing best-effort path resolving differently once some *unrelated*
 * directory appears — `/x/y-z` becoming `/x/y/z`, by a hand-made directory
 * Callboard had no part in. That is also the case that costs the most to
 * compute, which is the case worth memoising.
 */
export function projectDirToFolder(dirName: string): string {
  const now = Date.now();
  const cached = projectDirFolderCache.get(dirName);
  if (cached && now < cached.expiresAt) return cached.folder;

  const folder = resolveProjectDirToFolder(dirName);
  // Each entry gets its own expiry rather than a shared deadline — see
  // {@link jitteredExpiry}. Minting them together must not expire them together.
  projectDirFolderCache.set(dirName, { folder, expiresAt: jitteredExpiry(now) });
  return folder;
}

/**
 * Check if a path exists (as either a file or directory).
 */
function pathExists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encode a string the same way the Claude SDK does (for comparison purposes).
 * Replaces all non-alphanumeric characters with dashes.
 */
function encodeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Try to recover the original path by scanning the filesystem for real directory
 * entries whose encoded form matches the merged segments.
 *
 * This handles ALL special characters uniformly (periods, dashes, underscores,
 * spaces, etc.) because it checks what actually exists on disk rather than
 * guessing which character a dash originally represented.
 *
 * Example: segments = ["Users", "me", "WolpertingerLabs", "callboard", "feat-xyz"]
 *   → greedy split was wrong at "callboard" (it exists as a dir)
 *   → merge last 2: encoded = "callboard-feat-xyz"
 *   → scan /Users/me/WolpertingerLabs/ for entry encoding to "callboard-feat-xyz"
 *   → finds "callboard.feat-xyz" → return "/Users/me/WolpertingerLabs/callboard.feat-xyz"
 */
function tryScanRecovery(segments: string[]): string | null {
  // Try merging the last N segments and scanning the parent for a matching entry.
  //
  // mergeCount=1: Handles intra-segment character recovery. The greedy algorithm
  //   resolved the path structure correctly but a dash within the last segment was
  //   originally a period, underscore, space, etc.
  //   e.g. segments = ["home", "user", "my-project"] → scan for "my_project"
  //
  // mergeCount>=2: Handles wrong splits. The greedy algorithm incorrectly split
  //   at an intermediate directory that happened to exist.
  //   e.g. segments = ["home", "user", "callboard", "feat-xyz"]
  //        → merge last 2: "callboard-feat-xyz" → scan for "callboard.feat-xyz"
  for (let mergeCount = 1; mergeCount <= Math.min(segments.length, 6); mergeCount++) {
    const prefixSegments = segments.slice(0, segments.length - mergeCount);
    const parentPath = prefixSegments.length > 0 ? "/" + prefixSegments.join("/") : "/";

    if (!isDirectory(parentPath)) continue;

    const mergeSegments = segments.slice(segments.length - mergeCount);
    const encodedSuffix = mergeSegments.join("-");

    try {
      const entries = readdirSync(parentPath);
      for (const entry of entries) {
        if (encodeSegment(entry) === encodedSuffix) {
          const candidate = parentPath === "/" ? "/" + entry : parentPath + "/" + entry;
          if (pathExists(candidate)) return candidate;
        }
      }
    } catch {
      // Parent directory not readable — skip to next merge count
    }
  }

  return null;
}

/**
 * Try to recover the original path by replacing dashes with dots.
 * Handles both intra-segment dashes (Case 1) and inter-segment boundaries (Case 2).
 *
 * Strategy:
 * 1. First, try replacing dashes with dots within individual segments
 *    (handles "repo-name" → "repo.name" in the last segment)
 * 2. Then try merging adjacent segments with dots
 *    (handles incorrectly split "/my/project/v2" → "/my.project.v2")
 * 3. Finally try combinations of both
 */
function tryDotRecovery(segments: string[]): string | null {
  // Phase 1: Try replacing dashes with dots WITHIN segments (right-to-left).
  // This is the most common case: the last segment (folder name) has dots.
  // e.g. segments = ["Users", "foo", "repo-name"] → try "repo.name"
  for (let segIdx = segments.length - 1; segIdx >= 0; segIdx--) {
    const segment = segments[segIdx];
    if (!segment.includes("-")) continue;

    const dotVariants = generateDotVariants(segment);
    for (const variant of dotVariants) {
      const testSegments = [...segments];
      testSegments[segIdx] = variant;
      const candidate = "/" + testSegments.join("/");
      if (pathExists(candidate)) return candidate;
    }
  }

  // Phase 2: Try merging adjacent segments with dots (from the right).
  // This handles cases where the greedy split was overly aggressive.
  // e.g. segments = ["Users", "foo", "my", "project", "v2"]
  //   → try merging last 2: ["Users", "foo", "my", "project.v2"]
  //   → try merging last 3: ["Users", "foo", "my.project.v2"]
  if (segments.length >= 2) {
    for (let mergeCount = 2; mergeCount <= Math.min(segments.length, 6); mergeCount++) {
      const prefixSegments = segments.slice(0, segments.length - mergeCount);
      const mergeSegments = segments.slice(segments.length - mergeCount);
      const prefixPath = prefixSegments.length > 0 ? "/" + prefixSegments.join("/") : "";

      // Try all-dots first (most common: "my.project.v2")
      const allDots = mergeSegments.join(".");
      if (pathExists(prefixPath + "/" + allDots)) return prefixPath + "/" + allDots;

      // For small merge counts, try mixed dot/slash combinations
      if (mergeCount <= 4) {
        const separatorCount = mergeCount - 1;
        const totalCombinations = 1 << separatorCount;
        // Skip 0 (all slashes — that's the original) and totalCombinations-1 (all dots — tried above)
        for (let mask = 1; mask < totalCombinations - 1; mask++) {
          let merged = mergeSegments[0];
          for (let i = 0; i < separatorCount; i++) {
            merged += mask & (1 << i) ? "." : "/";
            merged += mergeSegments[i + 1];
          }
          if (pathExists(prefixPath + "/" + merged)) return prefixPath + "/" + merged;
        }
      }
    }
  }

  // Phase 3: Combined — merge segments AND replace dashes within merged result.
  // e.g. segments = ["Users", "foo", "my", "project-v2"]
  //   → merge last 2 + dot within: "my.project.v2"
  if (segments.length >= 2) {
    for (let mergeCount = 2; mergeCount <= Math.min(segments.length, 4); mergeCount++) {
      const prefixSegments = segments.slice(0, segments.length - mergeCount);
      const mergeSegments = segments.slice(segments.length - mergeCount);
      const prefixPath = prefixSegments.length > 0 ? "/" + prefixSegments.join("/") : "";

      // Join with dots, then also try replacing remaining dashes with dots
      const dotJoined = mergeSegments.join(".");
      if (dotJoined.includes("-")) {
        const variants = generateDotVariants(dotJoined);
        for (const variant of variants) {
          if (pathExists(prefixPath + "/" + variant)) return prefixPath + "/" + variant;
        }
      }
    }
  }

  return null;
}

/**
 * Generate variants of a segment by replacing some or all dashes with dots.
 * For "a-b-c", generates: "a.b-c", "a-b.c", "a.b.c"
 * (but NOT the original "a-b-c").
 * Limits output for segments with many dashes to avoid combinatorial explosion.
 */
function generateDotVariants(segment: string): string[] {
  const dashPositions: number[] = [];
  for (let i = 0; i < segment.length; i++) {
    if (segment[i] === "-") dashPositions.push(i);
  }

  if (dashPositions.length === 0) return [];
  if (dashPositions.length > 6) {
    // Too many dashes — just try all-dots replacement
    return [segment.replace(/-/g, ".")];
  }

  const results: string[] = [];
  const totalCombinations = 1 << dashPositions.length;

  // Start from 1 (skip 0 = all dashes = original) up to totalCombinations-1
  // Try all-dots first (most likely), then mixed
  const chars = segment.split("");

  // All dots first
  const allDots = [...chars];
  for (const pos of dashPositions) allDots[pos] = ".";
  results.push(allDots.join(""));

  // Then mixed combinations (skip all-dashes=0 and all-dots=last)
  for (let mask = 1; mask < totalCombinations - 1; mask++) {
    const variant = [...chars];
    for (let i = 0; i < dashPositions.length; i++) {
      if (mask & (1 << i)) {
        variant[dashPositions[i]] = ".";
      }
    }
    results.push(variant.join(""));
  }

  return results;
}
