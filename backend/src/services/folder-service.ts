import { readdirSync, statSync, existsSync } from "fs";
import { join, dirname, resolve, basename } from "path";
import { homedir } from "os";
import { CLAUDE_PROJECTS_DIR, projectDirToFolder } from "../utils/paths.js";
import { detectWorktreeMainRepo, isMainGitRepo, getGitWorktrees } from "../utils/git.js";
import type { FolderItem, BrowseResult, ValidateResult, FolderSuggestion, WorktreeGroup } from "shared/types/index.js";

export type { FolderItem, BrowseResult, ValidateResult, FolderSuggestion, WorktreeGroup };

export interface RecentFolder extends FolderSuggestion {
  type: "recent";
  lastUsed: string;
  chatCount: number;
  /** True if this directory is a git worktree checkout */
  isWorktree?: boolean;
  /** Absolute path to the main repository (set when isWorktree is true) */
  mainRepoPath?: string;
  /** Branch checked out in this worktree */
  worktreeBranch?: string;
}

/** A grouped recent item: main repo with its worktrees, or a standalone folder */
export type GroupedRecentItem = RecentFolder | { mainRepo: RecentFolder; worktrees: RecentFolder[] };

/**
 * Format a date as a human-readable "time ago" string.
 */
function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) === 1 ? "" : "s"} ago`;
  return `${Math.floor(diffDays / 30)} month${Math.floor(diffDays / 30) === 1 ? "" : "s"} ago`;
}

export class FolderService {
  private cache = new Map<string, { data: BrowseResult; timestamp: number }>();
  private readonly CACHE_TTL = 2 * 60 * 1000; // 2 minutes

  /**
   * Browse directories and files in the given path
   */
  async browseDirectory(path: string, showHidden: boolean = false, limit: number = 500): Promise<BrowseResult> {
    const resolvedPath = resolve(path);
    const cacheKey = `${resolvedPath}:${showHidden}:${limit}`;

    // Check cache first
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    const result: BrowseResult = {
      directories: [],
      files: [],
      parent: null,
      exists: false,
      currentPath: resolvedPath,
    };

    try {
      if (!existsSync(resolvedPath)) {
        return result;
      }

      const stat = statSync(resolvedPath);
      if (!stat.isDirectory()) {
        return result;
      }

      result.exists = true;
      result.parent = dirname(resolvedPath) !== resolvedPath ? dirname(resolvedPath) : null;

      const items = readdirSync(resolvedPath);
      let processedCount = 0;

      for (const item of items) {
        if (processedCount >= limit) break;

        const itemPath = join(resolvedPath, item);
        const isHidden = item.startsWith(".");

        // Skip hidden files if not requested
        if (isHidden && !showHidden) continue;

        try {
          const itemStat = statSync(itemPath);
          const folderItem: FolderItem = {
            name: item,
            path: itemPath,
            type: itemStat.isDirectory() ? "directory" : "file",
            isHidden,
            size: itemStat.size,
            modified: itemStat.mtime.toISOString(),
          };

          // Check if directory is a git repository and detect worktrees
          if (itemStat.isDirectory()) {
            const gitEntryPath = join(itemPath, ".git");
            if (existsSync(gitEntryPath)) {
              folderItem.isGitRepo = true;
              // Cheap heuristic: if .git is a file (not a directory), this is a worktree checkout
              const wtInfo = detectWorktreeMainRepo(itemPath);
              if (wtInfo) {
                folderItem.isWorktree = true;
                folderItem.mainRepoPath = wtInfo.mainRepoPath;
                folderItem.worktreeBranch = wtInfo.branch ?? undefined;
              }
            }
            result.directories.push(folderItem);
          } else {
            result.files.push(folderItem);
          }

          processedCount++;
        } catch (_err) {
          // Skip items we can't stat (permission issues, etc.)
          continue;
        }
      }

      // Sort directories and files separately
      result.directories.sort((a, b) => a.name.localeCompare(b.name));
      result.files.sort((a, b) => a.name.localeCompare(b.name));

      // Build worktree groups from sibling directories
      result.worktreeGroups = this.buildWorktreeGroups(result.directories);

      // Cache the result
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });

      return result;
    } catch (err) {
      console.error("Error browsing directory:", err);
      return result;
    }
  }

  /**
   * Validate if a path exists and is accessible
   */
  async validatePath(path: string): Promise<ValidateResult> {
    const resolvedPath = resolve(path);

    try {
      const exists = existsSync(resolvedPath);
      if (!exists) {
        return {
          valid: false,
          exists: false,
          readable: false,
        };
      }

      const stat = statSync(resolvedPath);
      const isDirectory = stat.isDirectory();
      const isGit = isDirectory && existsSync(join(resolvedPath, ".git"));

      return {
        valid: true,
        exists: true,
        readable: true,
        isDirectory,
        isGit,
      };
    } catch (_err) {
      return {
        valid: false,
        exists: existsSync(resolvedPath),
        readable: false,
      };
    }
  }

  /**
   * Get recently used directories derived from chat history.
   * Scans ~/.claude/projects/ to find directories that have been used for chats,
   * sorted by most recent activity.
   */
  getRecentFolders(limit: number = 10): RecentFolder[] {
    // Check cache
    const cacheKey = `recent:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data as unknown as RecentFolder[];
    }

    if (!existsSync(CLAUDE_PROJECTS_DIR)) return [];

    try {
      const projectDirs = readdirSync(CLAUDE_PROJECTS_DIR);
      const folderMap = new Map<string, { lastUsed: Date; chatCount: number }>();

      for (const dir of projectDirs) {
        const dirPath = join(CLAUDE_PROJECTS_DIR, dir);
        try {
          const dirStat = statSync(dirPath);
          if (!dirStat.isDirectory()) continue;
        } catch {
          continue;
        }

        const folder = projectDirToFolder(dir);

        // Skip directories that no longer exist
        if (!existsSync(folder)) continue;

        // Count .jsonl files and find most recent modification
        let latestMtime = new Date(0);
        let count = 0;

        try {
          const files = readdirSync(dirPath);
          for (const file of files) {
            if (!file.endsWith(".jsonl")) continue;
            count++;
            try {
              const fileStat = statSync(join(dirPath, file));
              if (fileStat.mtime > latestMtime) {
                latestMtime = fileStat.mtime;
              }
            } catch {
              continue;
            }
          }
        } catch {
          continue;
        }

        if (count === 0) continue;

        // Merge with existing entry if same folder resolved from multiple project dirs
        const existing = folderMap.get(folder);
        if (existing) {
          existing.chatCount += count;
          if (latestMtime > existing.lastUsed) {
            existing.lastUsed = latestMtime;
          }
        } else {
          folderMap.set(folder, { lastUsed: latestMtime, chatCount: count });
        }
      }

      // Sort by most recent, take limit
      const sorted = [...folderMap.entries()].sort((a, b) => b[1].lastUsed.getTime() - a[1].lastUsed.getTime()).slice(0, limit);

      const results: RecentFolder[] = sorted.map(([path, info]) => {
        const ago = formatTimeAgo(info.lastUsed);
        const result: RecentFolder = {
          path,
          name: basename(path),
          description: `Used ${ago}`,
          type: "recent" as const,
          lastUsed: info.lastUsed.toISOString(),
          chatCount: info.chatCount,
        };

        // Enrich with worktree metadata
        const wtInfo = detectWorktreeMainRepo(path);
        if (wtInfo) {
          result.isWorktree = true;
          result.mainRepoPath = wtInfo.mainRepoPath;
          result.worktreeBranch = wtInfo.branch ?? undefined;
        }

        return result;
      });

      // Cache the results
      this.cache.set(cacheKey, { data: results as unknown as BrowseResult, timestamp: Date.now() });

      return results;
    } catch (err) {
      console.error("Error getting recent folders:", err);
      return [];
    }
  }

  /**
   * Get suggested directories for quick access
   */
  getSuggestions(): FolderSuggestion[] {
    const suggestions: FolderSuggestion[] = [];

    // System directories
    const systemDirs = [
      { path: "/", name: "Root", description: "System root directory" },
      { path: "/home", name: "Home", description: "User home directories" },
      { path: "/opt", name: "Optional", description: "Optional software packages" },
      { path: "/usr/local", name: "Local", description: "Local software installations" },
      { path: "/var", name: "Variable", description: "Variable data files" },
      { path: "/tmp", name: "Temp", description: "Temporary files" },
    ];

    for (const dir of systemDirs) {
      if (existsSync(dir.path)) {
        suggestions.push({
          ...dir,
          type: "system",
        });
      }
    }

    // User home directory
    const home = homedir();
    if (existsSync(home)) {
      suggestions.push({
        path: home,
        name: "Home Directory",
        description: "Your personal home directory",
        type: "user",
      });
    }

    // Common development directories in home
    const devDirs = ["Desktop", "Documents", "Downloads", "Projects", "workspace", "code", "dev"];
    for (const dir of devDirs) {
      const fullPath = join(home, dir);
      if (existsSync(fullPath)) {
        suggestions.push({
          path: fullPath,
          name: dir,
          description: `${dir} directory`,
          type: "user",
        });
      }
    }

    // Recent directories from chat history
    const recentFolders = this.getRecentFolders(5);
    for (const recent of recentFolders) {
      // Avoid duplicates with system/user suggestions
      if (!suggestions.some((s) => s.path === recent.path)) {
        suggestions.push(recent);
      }
    }

    return suggestions;
  }

  /**
   * Group sibling directories by worktree relationship.
   *
   * Algorithm:
   * 1. Find all main repos in the listing (isGitRepo && !isWorktree).
   * 2. For each, check if `.git/worktrees/` has entries (cheap readdirSync).
   * 3. If it has worktrees, call `getGitWorktrees()` to get the full list.
   * 4. Cross-reference worktree paths with sibling directories in the listing.
   * 5. Build WorktreeGroup entries for repos that have ≥1 sibling worktree.
   */
  private buildWorktreeGroups(directories: FolderItem[]): WorktreeGroup[] {
    const groups: WorktreeGroup[] = [];
    const dirsByPath = new Map(directories.map((d) => [d.path, d]));
    const consumedPaths = new Set<string>();

    // Find main repos in the listing
    const mainRepos = directories.filter((d) => d.isGitRepo && !d.isWorktree);

    for (const mainRepo of mainRepos) {
      try {
        // Quick check: does this main repo even have worktrees?
        const worktreesDir = join(mainRepo.path, ".git", "worktrees");
        if (!existsSync(worktreesDir)) continue;
        const wtEntries = readdirSync(worktreesDir);
        if (wtEntries.length === 0) continue;

        // Full worktree list from git
        const worktreeInfos = getGitWorktrees(mainRepo.path);

        // Find worktrees that exist in our directory listing (siblings)
        const siblingWorktrees: FolderItem[] = [];
        for (const wt of worktreeInfos) {
          if (wt.isMainWorktree) continue; // Skip the main worktree itself
          const siblingDir = dirsByPath.get(wt.path);
          if (siblingDir) {
            // Enrich with branch info from worktree list if not already set
            if (!siblingDir.worktreeBranch && wt.branch) {
              siblingDir.worktreeBranch = wt.branch;
            }
            siblingWorktrees.push(siblingDir);
            consumedPaths.add(siblingDir.path);
          }
        }

        if (siblingWorktrees.length > 0) {
          consumedPaths.add(mainRepo.path);
          groups.push({
            mainRepo,
            worktrees: siblingWorktrees,
          });
        }
      } catch {
        // If git worktree list fails, skip grouping for this repo
      }
    }

    // Safety net: handle worktree dirs whose mainRepoPath points to a main repo
    // that IS in the listing but wasn't caught above
    for (const dir of directories) {
      if (dir.isWorktree && dir.mainRepoPath && !consumedPaths.has(dir.path)) {
        const mainRepo = dirsByPath.get(dir.mainRepoPath);
        if (mainRepo && !consumedPaths.has(mainRepo.path)) {
          // Find or create group for this main repo
          let group = groups.find((g) => g.mainRepo.path === mainRepo.path);
          if (!group) {
            consumedPaths.add(mainRepo.path);
            group = { mainRepo, worktrees: [] };
            groups.push(group);
          }
          group.worktrees.push(dir);
          consumedPaths.add(dir.path);
        }
      }
    }

    return groups;
  }

  /**
   * Group recent folders by worktree relationship.
   * Returns an array where entries are either standalone folders
   * or groups of { mainRepo, worktrees }.
   */
  groupRecentByWorktree(recent: RecentFolder[]): GroupedRecentItem[] {
    const result: GroupedRecentItem[] = [];
    const consumed = new Set<string>();
    const byPath = new Map(recent.map((r) => [r.path, r]));

    // Step 1: For each recent folder that's a main git repo, find its worktrees in the list
    for (const folder of recent) {
      if (consumed.has(folder.path)) continue;

      if (!folder.isWorktree && isMainGitRepo(folder.path)) {
        // Quick check: does this repo even have worktrees?
        const worktreesDir = join(folder.path, ".git", "worktrees");
        if (!existsSync(worktreesDir)) continue;
        try {
          const wtEntries = readdirSync(worktreesDir);
          if (wtEntries.length === 0) continue;
        } catch {
          continue;
        }

        const worktreeInfos = getGitWorktrees(folder.path);
        const recentWorktrees: RecentFolder[] = [];

        for (const wt of worktreeInfos) {
          if (wt.isMainWorktree) continue;
          const match = byPath.get(wt.path);
          if (match && !consumed.has(match.path)) {
            recentWorktrees.push(match);
            consumed.add(match.path);
          }
        }

        if (recentWorktrees.length > 0) {
          consumed.add(folder.path);
          result.push({ mainRepo: folder, worktrees: recentWorktrees });
          continue;
        }
      }
    }

    // Step 2: For worktree dirs whose main repo is in the list, group them
    for (const folder of recent) {
      if (consumed.has(folder.path)) continue;

      if (folder.isWorktree && folder.mainRepoPath) {
        const mainRepo = byPath.get(folder.mainRepoPath);
        if (mainRepo && !consumed.has(mainRepo.path)) {
          // Find all worktrees for this main repo
          const worktreeInfos = getGitWorktrees(mainRepo.path);
          const recentWorktrees: RecentFolder[] = [];
          for (const wt of worktreeInfos) {
            if (wt.isMainWorktree) continue;
            const match = byPath.get(wt.path);
            if (match && !consumed.has(match.path)) {
              recentWorktrees.push(match);
              consumed.add(match.path);
            }
          }
          consumed.add(mainRepo.path);
          result.push({ mainRepo, worktrees: recentWorktrees });
          continue;
        }
      }
    }

    // Step 3: Add remaining ungrouped folders
    for (const folder of recent) {
      if (!consumed.has(folder.path)) {
        result.push(folder);
      }
    }

    return result;
  }

  /**
   * Clear the cache (useful for testing or manual refresh)
   */
  clearCache(): void {
    this.cache.clear();
  }
}

export const folderService = new FolderService();
