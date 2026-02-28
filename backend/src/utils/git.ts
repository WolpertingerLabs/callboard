import { execSync, execFileSync } from "child_process";
import { existsSync, statSync, lstatSync, readFileSync, readdirSync } from "fs";
import { join, dirname, basename, resolve, extname, relative } from "path";
import type { DiffFileEntry, DiffFileType } from "shared/types/index.js";

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
        return { mainRepoPath, isWorktree: true };
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
