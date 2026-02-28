import { statSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Absolute path to the Callboard data directory (~/.callboard). */
export const DATA_DIR = join(homedir(), ".callboard");

/** Path to the primary .env file inside the config directory (~/.callboard/.env). */
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
export const DEFAULT_MCP_LOCAL_DIR = join(DATA_DIR, ".drawlatch");

/** Default MCP config directory for remote proxy mode. */
export const DEFAULT_MCP_REMOTE_DIR = join(DATA_DIR, ".drawlatch-remote");

/** Ensure the data directory exists (idempotent, safe to call multiple times). */
export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/** Default .env template scaffolded on first run. */
const ENV_TEMPLATE = `# Callboard configuration — ~/.callboard/.env
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
 * Otherwise, keep it as a "-" in the current segment. This is O(n) filesystem
 * checks instead of the previous O(2^n) brute-force approach.
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
  const parts = dirName.slice(1).split("-");
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
      // Keep the dash as a literal "-" in the current segment
      currentSegment += "-" + parts[i];
    }
  }

  // Append the final segment (doesn't need to be a directory itself)
  resolvedSegments.push(currentSegment);

  const resolved = "/" + resolvedSegments.join("/");

  // If the resolved path exists, return it directly
  if (pathExists(resolved)) return resolved;

  // The path doesn't exist — try dot substitutions to recover the original path.
  // This handles two cases:
  //
  // Case 1: Dashes within a segment that were originally dots.
  //   e.g. "repo-name" in the last segment was actually "repo.name"
  //
  // Case 2: The greedy algorithm incorrectly split at a coincidental directory,
  //   creating separate segments that should be joined with dots.
  //   e.g. ["Users", "foo", "my", "project", "v2"] should be
  //        ["Users", "foo", "my.project.v2"]
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
