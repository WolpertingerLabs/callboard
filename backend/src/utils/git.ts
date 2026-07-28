import { execSync, execFileSync } from "child_process";
import { existsSync, statSync, lstatSync, readFileSync, readdirSync } from "fs";
import { join, dirname, basename, resolve, extname, relative } from "path";
import type { DiffFileEntry, DiffFileType, WorkspaceCleanliness } from "shared/types/index.js";

/**
 * Validate a string as a safe git ref name.
 * Rejects characters and patterns that are invalid or dangerous in git branch names.
 * Based on git-check-ref-format rules.
 */
export function validateGitRef(ref: string): void {
  if (!ref || typeof ref !== "string") {
    throw new Error("Branch name is required");
  }
  if (ref.length > 255) {
    throw new Error("Branch name must be 255 characters or fewer");
  }
  // Forbidden patterns per git-check-ref-format(1)
  const forbiddenPatterns: [RegExp, string][] = [
    [/\.\./, "Branch name cannot contain '..'"],
    // eslint-disable-next-line no-control-regex
    [/[\x00-\x1f\x7f]/, "Branch name cannot contain control characters"],
    // eslint-disable-next-line no-useless-escape
    [/[ ~^:?*\[\\]/, "Branch name cannot contain spaces or special characters: ~ ^ : ? * [ \\"],
    [/\/$/, "Branch name cannot end with '/'"],
    [/\.lock$/, "Branch name cannot end with '.lock'"],
    [/^\//, "Branch name cannot start with '/'"],
    [/\/\//, "Branch name cannot contain consecutive slashes"],
    [/\.$/, "Branch name cannot end with '.'"],
    [/^-/, "Branch name cannot start with '-'"],
    [/@\{/, "Branch name cannot contain '@{'"],
  ];

  for (const [pattern, message] of forbiddenPatterns) {
    if (pattern.test(ref)) {
      throw new Error(message);
    }
  }
}

/**
 * Validate that a folder path is an absolute path to an existing directory.
 * Resolves symlinks/traversal to prevent path-based attacks.
 */
export function validateFolderPath(folder: string): string {
  if (!folder || typeof folder !== "string") {
    throw new Error("Folder path is required");
  }
  const resolved = resolve(folder);
  if (!existsSync(resolved)) {
    throw new Error("Folder does not exist");
  }
  const stat = statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error("Path is not a directory");
  }
  return resolved;
}

export interface GitInfo {
  isGitRepo: boolean;
  branch?: string;
}

/**
 * Check if a directory is a git repository and get the current branch
 */
export function getGitInfo(directory: string): GitInfo {
  if (!directory || !existsSync(directory)) {
    return { isGitRepo: false };
  }

  try {
    // Check if directory exists and is accessible
    const stat = statSync(directory);
    if (!stat.isDirectory()) {
      return { isGitRepo: false };
    }

    // Check if it's a git repository by looking for .git folder or if it's inside a git repo
    const gitDir = join(directory, ".git");
    let isGitRepo = existsSync(gitDir);

    // If no .git folder in current directory, check if we're inside a git repo
    if (!isGitRepo) {
      try {
        execSync("git rev-parse --git-dir", {
          cwd: directory,
          stdio: "pipe",
          timeout: 5000, // 5 second timeout
        });
        isGitRepo = true;
      } catch {
        // Not a git repo or git not available
        return { isGitRepo: false };
      }
    }

    if (isGitRepo) {
      try {
        // Get current branch name
        const branch = execSync("git branch --show-current", {
          cwd: directory,
          encoding: "utf8",
          stdio: "pipe",
          timeout: 5000, // 5 second timeout
        }).trim();

        return {
          isGitRepo: true,
          branch: branch || "main", // fallback to 'main' if branch is empty
        };
      } catch {
        // Git repo exists but can't get branch (detached HEAD, etc.)
        return {
          isGitRepo: true,
          branch: "main",
        };
      }
    }

    return { isGitRepo: false };
  } catch (_error) {
    // Any other error (permissions, etc.)
    return { isGitRepo: false };
  }
}

export interface WorktreeResolution {
  mainRepoPath: string;
  isWorktree: boolean;
  /**
   * The worktree's git **admin directory** — `<mainRepo>/.git/worktrees/<slug>`
   * exactly as the worktree's own `.git` file names it. Only set when
   * `isWorktree`.
   *
   * The slug is NOT derivable: git names it after the worktree *directory*, so
   * a worktree at `repo.feat-x` on branch `feat/x` lands in
   * `.git/worktrees/repo.feat-x`, and a collision gets a numeric suffix. It has
   * to be read from the `.git` file, which is why it is surfaced here rather
   * than reconstructed by callers.
   *
   * Git owns this directory: it is untracked by definition and destroyed when
   * the worktree is removed. That is what makes it the right place for the
   * workspace identity token (see utils/worktree-token.ts).
   */
  adminDir?: string;
}

/**
 * Detect if a directory is a git worktree and resolve it to the main repository path.
 *
 * A worktree directory has a `.git` **file** (not directory) containing a line like:
 *   gitdir: /path/to/main-repo/.git/worktrees/<name>
 *
 * We parse this to navigate back to the main repo. This avoids spawning any
 * `git` subprocess — it's pure filesystem reads, safe to call per-session.
 *
 * Git submodules also have a `.git` file, but it points to `../.git/modules/<name>`,
 * not `.git/worktrees/<name>`, so they correctly return `isWorktree: false`.
 */
export function resolveWorktreeToMainRepo(folder: string): WorktreeResolution {
  if (!folder) return { mainRepoPath: folder, isWorktree: false };

  const gitPath = join(folder, ".git");
  if (!existsSync(gitPath)) {
    return { mainRepoPath: folder, isWorktree: false };
  }

  try {
    const stat = lstatSync(gitPath);

    if (stat.isDirectory()) {
      // Normal git repo (not a worktree)
      return { mainRepoPath: folder, isWorktree: false };
    }

    if (stat.isFile()) {
      // Worktree: .git is a file containing "gitdir: <path>"
      const content = readFileSync(gitPath, "utf-8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (!match) {
        return { mainRepoPath: folder, isWorktree: false };
      }

      // Resolve relative paths (gitdir can be relative to the worktree)
      const resolvedGitdir = resolve(folder, match[1]);

      // Expected format: /path/to/main-repo/.git/worktrees/<name>
      const worktreesDir = dirname(resolvedGitdir);
      if (basename(worktreesDir) !== "worktrees") {
        return { mainRepoPath: folder, isWorktree: false };
      }

      const dotGitDir = dirname(worktreesDir);
      if (basename(dotGitDir) !== ".git") {
        return { mainRepoPath: folder, isWorktree: false };
      }

      const mainRepoPath = dirname(dotGitDir);
      if (existsSync(mainRepoPath)) {
        return { mainRepoPath, isWorktree: true, adminDir: resolvedGitdir };
      }
    }
  } catch {
    // Fall through on any error
  }

  return { mainRepoPath: folder, isWorktree: false };
}

// Cache for worktree resolution to avoid repeated filesystem reads
const worktreeResolutionCache = new Map<string, { result: WorktreeResolution; cachedAt: number }>();
const WORKTREE_CACHE_TTL = 300000; // 5 minutes

/**
 * Cached wrapper around resolveWorktreeToMainRepo.
 * Safe to call per-session in hot paths like paginated chat discovery.
 *
 * NOT safe for anything that decides whether a directory may be deleted: the
 * entry can be up to {@link WORKTREE_CACHE_TTL} out of date, and a worktree
 * removed and recreated inside that window would answer with the *old*
 * `adminDir`. Removal paths call {@link resolveWorktreeToMainRepo} directly.
 *
 * **Phase 3 kept this deliberately** (plans/workspace-object.md said the cache
 * "can go"). It could not: workspace records exist for 0.13% of chats, and the
 * remaining callers — chat-search, chat-lookup, ClaudeCodeSessionProvider —
 * map a chat's `folder` to its main repo to find *session log directories*,
 * which the registry cannot answer for a path-only chat. What did move is the
 * sidebar's folder listing: `services/workspace-views.ts` answers from the
 * workspace record when one claims the directory and only falls through to
 * here when none does.
 *
 * Nothing about Phase 2's removal gate changed. It never used this wrapper,
 * and `viewForDirectory` is a display read that is not reachable from it.
 */
export function resolveWorktreeToMainRepoCached(folder: string): WorktreeResolution {
  const cached = worktreeResolutionCache.get(folder);
  const now = Date.now();
  if (cached && now - cached.cachedAt < WORKTREE_CACHE_TTL) {
    return cached.result;
  }
  const result = resolveWorktreeToMainRepo(folder);
  worktreeResolutionCache.set(folder, { result, cachedAt: now });
  return result;
}

/**
 * List local branch names for a git repository.
 * Returns branches sorted alphabetically with the current branch first.
 */
export function getGitBranches(directory: string): string[] {
  if (!directory || !existsSync(directory)) {
    return [];
  }

  try {
    const output = execSync("git branch --list --format='%(refname:short)'", {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 5000,
    }).trim();

    if (!output) return [];

    const branches = output
      .split("\n")
      .map((b) => b.trim().replace(/^'|'$/g, ""))
      .filter(Boolean)
      .sort();

    // Move current branch to front
    const currentBranch = execSync("git branch --show-current", {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 5000,
    }).trim();

    if (currentBranch) {
      const idx = branches.indexOf(currentBranch);
      if (idx > 0) {
        branches.splice(idx, 1);
        branches.unshift(currentBranch);
      }
    }

    return branches;
  } catch {
    return [];
  }
}

export interface WorktreeInfo {
  path: string;
  branch: string | null; // null for detached HEAD
  isMainWorktree: boolean;
  isBare: boolean;
}

/**
 * List all git worktrees for a repository.
 * Parses `git worktree list --porcelain` output.
 */
export function getGitWorktrees(directory: string): WorktreeInfo[] {
  if (!directory || !existsSync(directory)) {
    return [];
  }

  try {
    const output = execSync("git worktree list --porcelain", {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 5000,
    }).trim();

    if (!output) return [];

    // Parse porcelain format: blocks separated by blank lines
    const blocks = output.split("\n\n").filter(Boolean);
    const worktrees: WorktreeInfo[] = [];

    for (let i = 0; i < blocks.length; i++) {
      const lines = blocks[i].split("\n");
      let path = "";
      let branch: string | null = null;
      let isBare = false;

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          path = line.slice("worktree ".length);
        } else if (line.startsWith("branch ")) {
          // Strip refs/heads/ prefix
          branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
        } else if (line === "bare") {
          isBare = true;
        }
        // 'detached' line means branch stays null
      }

      if (path) {
        worktrees.push({
          path,
          branch,
          isMainWorktree: i === 0,
          isBare,
        });
      }
    }

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Sanitize a branch name for use in filesystem paths.
 * Replaces slashes with hyphens.
 */
function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/\//g, "-");
}

export interface EnsuredWorktree {
  /** The absolute path to the worktree directory. */
  path: string;
  /**
   * True only when this call ran `git worktree add`. False when an existing
   * directory or an existing checkout of the branch was reused — we can't
   * claim ownership of something we merely found.
   */
  created: boolean;
}

/**
 * {@link ensureWorktree}, but reporting whether the worktree was created here
 * or reused. Callers that persist worktree provenance need the distinction;
 * everyone else wants the path and can use the wrapper below.
 */
export function ensureWorktreeDetailed(repoDir: string, branch: string, createBranch: boolean, baseBranch?: string): EnsuredWorktree {
  validateGitRef(branch);
  if (baseBranch) validateGitRef(baseBranch);

  const sanitized = sanitizeBranchForPath(branch);
  const repoName = basename(repoDir);
  const parentDir = dirname(repoDir);
  const worktreePath = join(parentDir, `${repoName}.${sanitized}`);

  // If worktree directory already exists, reuse it
  if (existsSync(worktreePath)) {
    return { path: worktreePath, created: false };
  }

  // If the branch is already checked out in another worktree (including the
  // main one), return that worktree's path instead of failing with
  // "fatal: '<branch>' is already checked out at '...'"
  const worktrees = getGitWorktrees(repoDir);
  const existing = worktrees.find((wt) => wt.branch === branch);
  if (existing) {
    return { path: existing.path, created: false };
  }

  // Create the worktree
  if (createBranch) {
    // Create a new branch and worktree in one command
    const base = baseBranch || "HEAD";
    execFileSync("git", ["worktree", "add", "-b", branch, worktreePath, base], {
      cwd: repoDir,
      stdio: "pipe",
      timeout: 10000,
    });
  } else {
    // Use an existing branch
    execFileSync("git", ["worktree", "add", worktreePath, branch], {
      cwd: repoDir,
      stdio: "pipe",
      timeout: 10000,
    });
  }

  return { path: worktreePath, created: true };
}

/**
 * Create or reuse a git worktree as a sibling directory of the repo.
 * Worktree path: [repo-parent]/[repo-name].[sanitized-branch]
 *
 * If the worktree already exists at the expected path, returns the path without creating.
 *
 * @param repoDir - The original repository directory
 * @param branch - Branch name to checkout in the worktree
 * @param createBranch - If true and branch doesn't exist, create it from baseBranch
 * @param baseBranch - Base branch for new branch creation
 * @returns The absolute path to the worktree directory
 */
export function ensureWorktree(repoDir: string, branch: string, createBranch: boolean, baseBranch?: string): string {
  return ensureWorktreeDetailed(repoDir, branch, createBranch, baseBranch).path;
}

/**
 * Switch to a branch in the given directory (non-worktree mode).
 * If createNew is true, creates the branch from baseBranch first.
 *
 * Before checking out, inspects the worktree list. If the target branch is
 * already checked out in a different worktree, returns that worktree's path
 * instead of attempting (and failing) the checkout.
 *
 * @returns The worktree path if the branch lives in a different worktree, or
 *          `null` if the checkout happened in-place in `directory`.
 */
export function switchBranch(directory: string, branch: string, createNew: boolean, baseBranch?: string): string | null {
  validateGitRef(branch);
  if (baseBranch) validateGitRef(baseBranch);

  // Check if the branch is already checked out in a worktree elsewhere
  const worktrees = getGitWorktrees(directory);
  const existing = worktrees.find((wt) => wt.branch === branch && wt.path !== directory);
  if (existing) {
    return existing.path;
  }

  if (createNew) {
    const base = baseBranch || "HEAD";
    execFileSync("git", ["checkout", "-b", branch, base], {
      cwd: directory,
      stdio: "pipe",
      timeout: 5000,
    });
  } else {
    execFileSync("git", ["checkout", branch], {
      cwd: directory,
      stdio: "pipe",
      timeout: 5000,
    });
  }
  return null;
}

/**
 * Check whether the working directory has any uncommitted changes.
 * Uses `git status --porcelain` which is fast and catches:
 *   - staged changes
 *   - unstaged modifications
 *   - untracked files
 *
 * Returns true if there are ANY changes; false if the working tree is clean.
 */
export function hasUncommittedChanges(directory: string): boolean {
  if (!directory || !existsSync(directory)) {
    return false;
  }

  try {
    const output = execSync("git status --porcelain", {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 5000,
    });
    return output.trim().length > 0;
  } catch {
    return false; // If git status fails, don't block the user
  }
}

// ── Worktree removal ─────────────────────────────────────────────────
//
// Everything below decides whether a directory is destroyed, so it inverts the
// convention the rest of this file uses: a git command that fails is reported
// as an error and read as "not clean", never swallowed into a permissive
// default. `hasUncommittedChanges` above returns false when git fails because
// it only gates a branch switch; here that would mean deleting work.

/** Run git and return stdout, or throw with a useful message. */
function gitOutput(directory: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: "pipe",
    timeout: 10000,
    ...(input !== undefined && { input }),
  });
}

/**
 * The verdict {@link checkWorktreeClean} returns.
 *
 * Defined in shared/types/workspace.ts as `WorkspaceCleanliness` and aliased
 * here: the API surface returns this shape verbatim (adoption discovery reports
 * it per candidate), and two hand-maintained copies of a safety-relevant type
 * are exactly the kind of thing that drifts. Fields: staged/unstaged
 * modifications, untracked files (ignored files are NOT counted — see below),
 * and commits reachable from HEAD and nowhere else.
 */
export type WorktreeCleanliness = WorkspaceCleanliness;

/**
 * Is this worktree safe to delete?
 *
 * Three independent refusals, any one of which keeps the directory:
 *
 * 1. **Uncommitted changes** and 2. **untracked files** — `git status
 *    --porcelain`, splitting `??` entries out from everything else so the
 *    caller can say which one it refused on.
 * 3. **Unpushed commits** — deliberately stricter than git's own check, which
 *    only looks at the working tree. A commit reachable from HEAD and from no
 *    other ref exists in exactly one place, and that is the case we must not
 *    destroy. Computed as `rev-list --count HEAD --not <every ref except the
 *    one HEAD is on>`: zero means every commit here is also reachable from a
 *    remote-tracking branch, another local branch or a tag. This covers the
 *    no-upstream case (a `worktree add -b` branch that was never pushed)
 *    without needing an upstream to be configured.
 *
 * The refs are fed through stdin rather than argv — a repository with
 * thousands of refs would otherwise risk E2BIG.
 *
 * **Ignored files are deliberately not counted here.** `--porcelain` does not
 * report them, and counting them would refuse essentially every worktree of a
 * JS project (measured: 44 of 44 on the author's machine). They do not need a
 * gate, because removal is a move into the trash rather than a delete and they
 * ride along intact — see utils/worktree-trash.ts. {@link listIgnoredEntries}
 * surfaces them for display, never for a decision.
 */
export function checkWorktreeClean(directory: string): WorktreeCleanliness {
  const failed = (error: string): WorktreeCleanliness => ({
    clean: false,
    uncommittedChanges: false,
    untrackedFiles: false,
    unpushedCommits: false,
    error,
  });

  if (!directory || !existsSync(directory)) {
    return failed(`Directory does not exist: ${directory}`);
  }

  let statusOut: string;
  try {
    statusOut = gitOutput(directory, ["status", "--porcelain"]);
  } catch (err: any) {
    return failed(`git status failed: ${err?.message ?? err}`);
  }
  const statusLines = statusOut.split("\n").filter((line) => line.trim().length > 0);
  const untrackedFiles = statusLines.some((line) => line.startsWith("??"));
  const uncommittedChanges = statusLines.some((line) => !line.startsWith("??"));

  let refs: string[];
  try {
    refs = gitOutput(directory, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err: any) {
    return failed(`git for-each-ref failed: ${err?.message ?? err}`);
  }

  // The ref HEAD is on, so it can be excluded from the "somewhere else" set.
  // Fails on a detached HEAD, where there is no such ref and nothing to
  // exclude — the stricter reading, which is the right one here.
  let headRef = "";
  try {
    headRef = gitOutput(directory, ["symbolic-ref", "-q", "HEAD"]).trim();
  } catch {
    headRef = "";
  }

  const elsewhere = refs.filter((ref) => ref !== headRef);
  let unpushedCommits: boolean;
  try {
    const revs = ["HEAD", ...elsewhere.map((ref) => `^${ref}`)].join("\n") + "\n";
    const count = Number.parseInt(gitOutput(directory, ["rev-list", "--count", "--stdin"], revs).trim(), 10);
    if (!Number.isFinite(count)) return failed(`git rev-list returned an unparseable count`);
    unpushedCommits = count > 0;
  } catch (err: any) {
    return failed(`git rev-list failed: ${err?.message ?? err}`);
  }

  return {
    clean: !uncommittedChanges && !untrackedFiles && !unpushedCommits,
    uncommittedChanges,
    untrackedFiles,
    unpushedCommits,
  };
}

/**
 * Ignored entries in a worktree, for display only.
 *
 * `--ignored=traditional` collapses whole ignored directories to a single
 * entry (`backend/node_modules/`), which is what makes this cheap enough to
 * call at all — `--ignored=matching` **expands**, one line per file, and a
 * `node_modules` would produce tens of thousands. The collapsed form is also
 * the more legible summary of "what would move to the trash".
 *
 * NEVER a gate. Ignored files are why removal is a move rather than a delete
 * (utils/worktree-trash.ts); a policy that refused on them was measured to
 * refuse 44 worktrees out of 44. This exists so a caller can *see* what travels
 * with the directory, not so anything can decide on it.
 */
export interface IgnoredEntries {
  /** Collapsed paths, relative to the worktree. Capped — see `truncated`. */
  entries: string[];
  /** True when there were more than {@link IGNORED_ENTRY_LIMIT}. */
  truncated: boolean;
  /** Set when git failed. Informational output, so this is never fatal. */
  error?: string;
}

const IGNORED_ENTRY_LIMIT = 100;

export function listIgnoredEntries(directory: string): IgnoredEntries {
  if (!directory || !existsSync(directory)) {
    return { entries: [], truncated: false, error: `Directory does not exist: ${directory}` };
  }
  try {
    const out = gitOutput(directory, ["status", "--porcelain", "--ignored=traditional"]);
    const all = out
      .split("\n")
      .filter((line) => line.startsWith("!! "))
      .map((line) => line.slice(3).replace(/^"(.*)"$/, "$1"));
    return { entries: all.slice(0, IGNORED_ENTRY_LIMIT), truncated: all.length > IGNORED_ENTRY_LIMIT };
  } catch (err: any) {
    return { entries: [], truncated: false, error: `git status --ignored failed: ${err?.message ?? err}` };
  }
}

/**
 * Does this worktree involve submodules?
 *
 * Two independent signals, either of which is enough:
 *
 *  - `.gitmodules` in the working tree — the repository declares submodules,
 *    whether or not this worktree has initialised them;
 *  - `modules/` inside the worktree's git admin dir — where git puts the
 *    **object database** of every submodule initialised *in this worktree*.
 *
 * The second is the one that matters, and it is why quarantining a worktree
 * with submodules is unsafe even though `mv` itself is indifferent to them:
 * `git worktree prune` deletes the admin dir, and with it those object
 * databases. Measured — a commit made inside a worktree's submodule lives
 * *only* in `<mainRepo>/.git/worktrees/<slug>/modules/<path>`; after the
 * quarantine + prune the submodule's working files survive in the trash but its
 * history is unreachable. (`git worktree remove` refuses on submodules outright
 * for the same family of reasons: "fatal: working trees containing submodules
 * cannot be moved or removed".)
 */
export function worktreeContainsSubmodules(worktreePath: string, adminDir?: string): boolean {
  if (existsSync(join(worktreePath, ".gitmodules"))) return true;
  if (adminDir && existsSync(join(adminDir, "modules"))) return true;
  return false;
}

export type PruneWorktreesResult = { ok: true } | { ok: false; error: string };

/**
 * `git worktree prune` — unregister worktrees whose directories are gone.
 *
 * Run after a worktree has been moved into the trash: it drops the registration
 * and deletes the admin dir (taking our identity token with it). Metadata only
 * — prune never touches a directory that still exists, and the branch survives.
 */
export function pruneWorktrees(mainRepoPath: string): PruneWorktreesResult {
  if (!existsSync(mainRepoPath)) return { ok: false, error: `Main repo does not exist: ${mainRepoPath}` };
  try {
    execFileSync("git", ["worktree", "prune"], { cwd: mainRepoPath, stdio: "pipe", timeout: 30000 });
    return { ok: true };
  } catch (err: any) {
    const stderr = typeof err?.stderr === "string" ? err.stderr : err?.stderr?.toString?.() ?? "";
    return { ok: false, error: (stderr || err?.message || String(err)).trim() };
  }
}

/**
 * Is `worktreePath` still registered as a worktree of `mainRepoPath`?
 *
 * Asks git rather than the filesystem, because the question after a failed
 * removal is precisely whether git's bookkeeping and the directory still agree.
 */
export function isRegisteredWorktree(mainRepoPath: string, worktreePath: string): boolean {
  const target = resolve(worktreePath);
  return getGitWorktrees(mainRepoPath).some((wt) => resolve(wt.path) === target);
}

// ── Branch resolution ────────────────────────────────────────────────

export interface ResolveBranchOptions {
  /** Absolute path to the working directory / repo root */
  folder: string;
  /** Branch to switch to (or base for newBranch) */
  baseBranch?: string;
  /** New branch name to create (from baseBranch or current HEAD) */
  newBranch?: string;
  /** Create a git worktree instead of switching branches in-place */
  useWorktree?: boolean;
  /** Skip uncommitted-changes guard (default: false) */
  forceBranchChange?: boolean;
}

/**
 * What a `useWorktree` resolution actually did — the *intent* behind the
 * worktree, which git itself can't tell us afterwards. Reported so the caller
 * can persist it as a Workspace (plans/workspace-object.md); resolveBranch
 * stays a pure git util and writes nothing itself.
 *
 * Only populated for the worktree branch of resolveBranch. A plain branch
 * switch that happens to land in an existing worktree (switchBranch's
 * already-checked-out-elsewhere path) is not a worktree Callboard was asked
 * to make, and is deliberately not reported here.
 */
export interface ResolvedWorktree {
  /** The main checkout the worktree belongs to (resolveBranch's input folder). */
  repoPath: string;
  /** True only when this call ran `git worktree add`. */
  created: boolean;
  /** "branch-off" when a new branch was created for it, else "checkout-branch". */
  mode: "branch-off" | "checkout-branch";
  branch: string;
  /** Base the new branch came from ("branch-off" only; absent means HEAD). */
  baseBranch?: string;
}

export type ResolveBranchResult =
  | { ok: true; folder: string; worktree?: ResolvedWorktree }
  | { ok: false; error: "uncommitted_changes"; message: string; currentBranch: string; targetBranch: string };

/**
 * Resolve a branch configuration to an effective working directory.
 *
 * Handles worktree creation, new-branch creation, and branch switching
 * with a dirty-state guard. Returns the (possibly new) folder path on
 * success, or a structured error when uncommitted changes block an
 * in-place branch switch.
 *
 * Worktrees are inherently isolated and bypass the dirty-state guard.
 */
export function resolveBranch(opts: ResolveBranchOptions): ResolveBranchResult {
  const { folder, baseBranch, newBranch, useWorktree, forceBranchChange } = opts;
  const targetBranch = newBranch || baseBranch;

  if (!targetBranch && !useWorktree) {
    return { ok: true, folder };
  }

  // Dirty-state guard: block in-place branch switch if uncommitted changes exist.
  // Worktrees are inherently isolated, so they bypass this check.
  if (targetBranch && !useWorktree) {
    const currentBranch = getGitInfo(folder).branch;
    const effectiveBranch = newBranch || baseBranch;

    if (effectiveBranch && effectiveBranch !== currentBranch && !forceBranchChange && hasUncommittedChanges(folder)) {
      return {
        ok: false,
        error: "uncommitted_changes",
        message: `Cannot switch from "${currentBranch}" to "${effectiveBranch}" because there are uncommitted changes. Use a worktree to work in isolation instead.`,
        currentBranch: currentBranch || "unknown",
        targetBranch: effectiveBranch,
      };
    }
  }

  // Worktree path
  if (targetBranch && useWorktree) {
    const ensured = ensureWorktreeDetailed(folder, targetBranch, !!newBranch, baseBranch);
    return {
      ok: true,
      folder: ensured.path,
      worktree: {
        repoPath: folder,
        created: ensured.created,
        mode: newBranch ? "branch-off" : "checkout-branch",
        branch: targetBranch,
        ...(newBranch && baseBranch && { baseBranch }),
      },
    };
  }

  // Create new branch in-place
  if (newBranch) {
    const worktreePath = switchBranch(folder, newBranch, true, baseBranch);
    return { ok: true, folder: worktreePath || folder };
  }

  // Switch to existing branch
  if (baseBranch) {
    const worktreePath = switchBranch(folder, baseBranch, false);
    return { ok: true, folder: worktreePath || folder };
  }

  return { ok: true, folder };
}

/**
 * Get the git diff (unstaged + staged) for a repository.
 * Returns the raw unified diff string.
 */
export function getGitDiff(directory: string): string {
  if (!directory || !existsSync(directory)) {
    return "";
  }

  try {
    const unstaged = execSync("git diff", {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    });

    const staged = execSync("git diff --cached", {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    });

    // Combine both; staged changes come first
    return (staged + unstaged).trim();
  } catch {
    return "";
  }
}

// --- Enhanced structured diff support ---

const LARGE_FILE_THRESHOLD = 10 * 1024; // 10 KB

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".bmp", ".tiff", ".avif"]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".avi", ".mkv", ".ogv"]);

function classifyFile(filename: string): DiffFileType {
  const ext = extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return "text";
}

/**
 * Validate a filename to prevent path traversal attacks.
 * Allows legitimate patterns like Next.js catch-all routes: [[...slug]], [...params]
 */
export function validateFilename(filename: string): void {
  if (!filename || filename.startsWith("/")) {
    throw new Error("Invalid filename");
  }
  // Check for ".." as a directory traversal path segment, not as a substring.
  // This allows valid filenames containing ".." within brackets (e.g. [[...category]])
  // while still blocking traversal attempts like "../../etc/passwd" or "foo/../bar".
  const segments = filename.split("/");
  if (segments.some((seg) => seg === ".." || seg === ".")) {
    throw new Error("Invalid filename");
  }
}

/**
 * Recursively list all files under a directory, returning paths relative to baseDir.
 */
function listFilesRecursively(dirPath: string, baseDir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...listFilesRecursively(fullPath, baseDir));
      } else if (entry.isFile()) {
        results.push(relative(baseDir, fullPath));
      }
    }
  } catch {
    // Skip directories we can't read
  }
  return results;
}

/**
 * Get list of untracked files using git status --porcelain.
 * When git reports an untracked directory (trailing slash), expands it
 * into all individual files within that directory.
 */
function getUntrackedFiles(directory: string): string[] {
  try {
    const output = execSync("git status --porcelain", {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    });
    const entries = output
      .split("\n")
      .filter((line) => line.startsWith("?? "))
      .map((line) => line.slice(3).replace(/^"(.*)"$/, "$1"));

    const files: string[] = [];
    for (const entry of entries) {
      if (entry.endsWith("/")) {
        // It's a directory — expand into individual files
        const dirPath = join(directory, entry);
        files.push(...listFilesRecursively(dirPath, directory));
      } else {
        files.push(entry);
      }
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * Generate a unified diff for an untracked file.
 * Uses git diff --no-index which exits with code 1 when files differ.
 */
function generateUntrackedFileDiff(directory: string, filename: string): string {
  try {
    const result = execFileSync("git", ["diff", "--no-index", "--", "/dev/null", filename], {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    });
    return result;
  } catch (err: unknown) {
    // git diff --no-index exits with code 1 when there are differences (expected)
    const execError = err as { stdout?: string };
    if (execError.stdout) {
      return execError.stdout;
    }
    return "";
  }
}

/**
 * Split a combined diff string into per-file chunks.
 */
function parseDiffIntoFiles(rawDiff: string): Array<{ filename: string; diff: string; additions: number; deletions: number; isBinary: boolean }> {
  if (!rawDiff.trim()) return [];

  const files: Array<{ filename: string; diff: string; additions: number; deletions: number; isBinary: boolean }> = [];
  const parts = rawDiff.split(/(?=^diff --git )/m);

  for (const part of parts) {
    if (!part.trim()) continue;

    const headerMatch = part.match(/^diff --git a\/(.+?) b\/(.+)/);
    if (!headerMatch) continue;

    const filename = headerMatch[2];

    // Check for binary file
    if (part.includes("Binary files") && part.includes("differ")) {
      files.push({ filename, diff: part, additions: 0, deletions: 0, isBinary: true });
      continue;
    }

    let additions = 0;
    let deletions = 0;

    for (const line of part.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }

    files.push({ filename, diff: part, additions, deletions, isBinary: false });
  }

  return files;
}

/**
 * Detect file status from diff content.
 */
function detectFileStatus(diffContent: string): "modified" | "added" | "deleted" | "renamed" {
  if (diffContent.includes("--- /dev/null")) return "added";
  if (diffContent.includes("+++ /dev/null")) return "deleted";
  if (diffContent.includes("rename from")) return "renamed";
  return "modified";
}

/**
 * Get structured git diff with file metadata, untracked files, and large file gating.
 */
export function getGitDiffStructured(directory: string): DiffFileEntry[] {
  if (!directory || !existsSync(directory)) {
    return [];
  }

  const results: DiffFileEntry[] = [];

  try {
    // 1. Get tracked file diffs (unstaged + staged)
    const unstaged = execSync("git diff", {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    });

    const staged = execSync("git diff --cached", {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    });

    const trackedFiles = parseDiffIntoFiles((staged + unstaged).trim());

    for (const tf of trackedFiles) {
      const fileType = tf.isBinary ? classifyFile(tf.filename) : classifyFile(tf.filename);
      const filePath = join(directory, tf.filename);
      let size = 0;
      try {
        size = statSync(filePath).size;
      } catch {
        // File may have been deleted
      }

      const status = detectFileStatus(tf.diff);
      const isBinary = tf.isBinary;
      const isMedia = fileType === "image" || fileType === "video";
      const changeSize = Buffer.byteLength(tf.diff, "utf8");
      const isLargeChange = changeSize > LARGE_FILE_THRESHOLD && fileType === "text" && !isBinary;

      results.push({
        filename: tf.filename,
        status,
        fileType: isBinary && !isMedia ? "binary" : fileType,
        size,
        changeSize,
        contentIncluded: !isLargeChange && !isBinary,
        diff: isLargeChange || isBinary ? null : tf.diff,
        additions: isLargeChange || isBinary ? 0 : tf.additions,
        deletions: isLargeChange || isBinary ? 0 : tf.deletions,
      });
    }

    // 2. Get untracked files
    const untrackedFiles = getUntrackedFiles(directory);

    for (const filename of untrackedFiles) {
      const filePath = join(directory, filename);
      let size = 0;
      try {
        size = statSync(filePath).size;
      } catch {
        continue; // Skip files that disappeared
      }

      const fileType = classifyFile(filename);
      const isMedia = fileType === "image" || fileType === "video";

      let diff: string | null = null;
      let additions = 0;
      let changeSize = 0;

      if (fileType === "text") {
        diff = generateUntrackedFileDiff(directory, filename);
        changeSize = Buffer.byteLength(diff, "utf8");
        if (changeSize > LARGE_FILE_THRESHOLD) {
          diff = null;
        } else {
          for (const line of diff.split("\n")) {
            if (line.startsWith("+") && !line.startsWith("+++")) additions++;
          }
        }
      }

      const isLargeChange = changeSize > LARGE_FILE_THRESHOLD && fileType === "text";

      results.push({
        filename,
        status: "untracked",
        fileType: isMedia ? fileType : "text",
        size,
        changeSize,
        contentIncluded: !isLargeChange && fileType === "text",
        diff,
        additions,
        deletions: 0,
      });
    }
  } catch {
    // Return whatever we have so far, or empty
  }

  return results;
}

/**
 * Get the diff for a single file on demand (for large files loaded after user clicks "show anyway").
 */
export function getGitFileDiff(directory: string, filename: string): { diff: string; additions: number; deletions: number } {
  validateFilename(filename);

  // Check if it's an untracked file
  const untrackedFiles = getUntrackedFiles(directory);

  if (untrackedFiles.includes(filename)) {
    const diff = generateUntrackedFileDiff(directory, filename);
    let additions = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    }
    return { diff, additions, deletions: 0 };
  }

  // Tracked file: get both staged and unstaged diff for this specific file
  try {
    const unstaged = execFileSync("git", ["diff", "--", filename], {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    });
    const staged = execFileSync("git", ["diff", "--cached", "--", filename], {
      cwd: directory,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 10000,
    });
    const diff = (staged + unstaged).trim();
    let additions = 0;
    let deletions = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return { diff, additions, deletions };
  } catch {
    return { diff: "", additions: 0, deletions: 0 };
  }
}

/**
 * Read a raw file from a repository for media previews.
 */
export function readRepoFile(directory: string, filename: string): { buffer: Buffer; contentType: string } {
  validateFilename(filename);

  const filePath = join(directory, filename);
  if (!existsSync(filePath)) {
    throw new Error("File not found");
  }

  const buffer = readFileSync(filePath);
  const ext = extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
    ".ogv": "video/ogg",
  };
  const contentType = mimeMap[ext] || "application/octet-stream";

  return { buffer, contentType };
}
