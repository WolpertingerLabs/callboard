import { statSync, existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";

export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Project dirs in ~/.claude/projects/ that should be hidden from API listings.
 *
 * "-tmp" is the slugified form of `/tmp`, which the Claude Agent SDK uses
 * when callers pass `cwd: tmpdir()` (e.g. quick-completion, sdk-info). Those
 * calls create throwaway transcripts we never want to surface as chats.
 */
export const IGNORED_PROJECT_DIRS: ReadonlySet<string> = new Set(["-tmp"]);

/**
 * Read ~/.claude/projects/ and return the project dir names that aren't
 * on the ignore list. Safe to call when the dir doesn't exist.
 */
export function listClaudeProjectDirs(): string[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];
  try {
    return readdirSync(CLAUDE_PROJECTS_DIR).filter((d) => !IGNORED_PROJECT_DIRS.has(d));
  } catch {
    return [];
  }
}

// ── Claude Binary Resolution ────────────────────────────────────────

/**
 * Cached absolute path to the `claude` CLI binary.
 * Resolved once on first call, then reused for the lifetime of the process.
 */
let _claudeBinaryPath: string | null = null;

/**
 * Well-known locations where `claude` might be installed, checked as a
 * fallback when `which` / `command -v` can't find it (e.g. non-login
 * shell environments that don't source the user's profile).
 */
const CLAUDE_BINARY_SEARCH_PATHS = [
  join(homedir(), ".local", "bin", "claude"),
  join(homedir(), ".claude", "bin", "claude"),
  "/usr/local/bin/claude",
  "/usr/bin/claude",
  "/opt/homebrew/bin/claude",
];

/**
 * Resolve the absolute path to the `claude` CLI binary.
 *
 * Resolution order:
 * 1. `CLAUDE_BINARY` environment variable (explicit override)
 * 2. `which claude` (respects the user's PATH)
 * 3. Well-known install locations (handles non-login shells, daemons, etc.)
 * 4. Falls back to the bare name `"claude"` so execSync still gets a
 *    chance to find it through its own PATH lookup.
 *
 * The result is cached for the lifetime of the process.
 */
export function getClaudeBinaryPath(): string {
  if (_claudeBinaryPath !== null) return _claudeBinaryPath;

  // 1. Explicit override via environment variable
  if (process.env.CLAUDE_BINARY) {
    _claudeBinaryPath = process.env.CLAUDE_BINARY;
    return _claudeBinaryPath;
  }

  // 2. Ask the shell — works for login/interactive shells
  try {
    const resolved = execSync("which claude", {
      timeout: 3_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (resolved) {
      _claudeBinaryPath = resolved;
      return _claudeBinaryPath;
    }
  } catch {
    // `which` failed — claude not on PATH (or `which` not available)
  }

  // 3. Probe well-known install locations
  for (const candidate of CLAUDE_BINARY_SEARCH_PATHS) {
    if (existsSync(candidate)) {
      _claudeBinaryPath = candidate;
      return _claudeBinaryPath;
    }
  }

  // 4. Bare fallback — let the OS resolve it at exec time
  _claudeBinaryPath = "claude";
  return _claudeBinaryPath;
}

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
 */
export function projectDirToFolder(dirName: string): string {
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
