/**
 * Where a directory's checkout is, answered from the filesystem alone — no
 * git process. Shared by the Board's Branches view, the chat PRs route and the
 * per-turn git trail.
 */
import { existsSync, realpathSync } from "fs";
import { dirname, join, resolve, sep } from "path";

/** An absolute path with symlinks resolved where possible and no trailing separator. */
export function normalizeDir(dir: string): string {
  let out = resolve(dir);
  try {
    out = realpathSync.native(out);
  } catch {
    // A directory that no longer exists keeps its lexical form.
  }
  return out.length > 1 && out.endsWith(sep) ? out.slice(0, -1) : out;
}

/**
 * The nearest directory at or above `dir` holding a `.git` (directory, or the
 * file a linked worktree or submodule has), or null when there is none. A
 * filesystem walk, not a spawn — it is what lets a folder in a nested repo or
 * submodule count as its own repository rather than a subdirectory of the
 * worktree around it.
 */
export function findGitRoot(dir: string, exists: (path: string) => boolean = existsSync): string | null {
  for (let current = dir; ; current = dirname(current)) {
    if (exists(join(current, ".git"))) return current;
    if (dirname(current) === current) return null;
  }
}
