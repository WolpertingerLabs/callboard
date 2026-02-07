import { execSync, execFileSync } from "child_process";
import { existsSync, statSync } from "fs";
import { join, dirname, basename, resolve } from "path";

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
 * Remove a git worktree and prune stale references.
 * Refuses to remove the main worktree.
 *
 * @param repoDir - The main repository directory
 * @param worktreePath - Absolute path of the worktree to remove
 * @param force - If true, forces removal even with uncommitted changes
 */
export function removeWorktree(repoDir: string, worktreePath: string, force: boolean = false): void {
  // Safety: verify the target is actually a registered worktree and not the main one
  const worktrees = getGitWorktrees(repoDir);
  const target = worktrees.find((wt) => wt.path === worktreePath);

  if (!target) {
    throw new Error(`Path is not a registered worktree of this repository: ${worktreePath}`);
  }

  if (target.isMainWorktree) {
    throw new Error("Cannot remove the main worktree");
  }

  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePath);
  execFileSync("git", args, {
    cwd: repoDir,
    stdio: "pipe",
    timeout: 10000,
  });

  // Prune stale worktree references
  try {
    execSync("git worktree prune", {
      cwd: repoDir,
      stdio: "pipe",
      timeout: 5000,
    });
  } catch {
    // Non-fatal: prune failure shouldn't fail the overall operation
  }
}

/**
 * Sanitize a branch name for use in filesystem paths.
 * Replaces slashes with hyphens.
 */
function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/\//g, "-");
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
  validateGitRef(branch);
  if (baseBranch) validateGitRef(baseBranch);

  const sanitized = sanitizeBranchForPath(branch);
  const repoName = basename(repoDir);
  const parentDir = dirname(repoDir);
  const worktreePath = join(parentDir, `${repoName}.${sanitized}`);

  // If worktree directory already exists, reuse it
  if (existsSync(worktreePath)) {
    return worktreePath;
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

  return worktreePath;
}

/**
 * Switch to a branch in the given directory (non-worktree mode).
 * If createNew is true, creates the branch from baseBranch first.
 */
export function switchBranch(directory: string, branch: string, createNew: boolean, baseBranch?: string): void {
  validateGitRef(branch);
  if (baseBranch) validateGitRef(baseBranch);

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
