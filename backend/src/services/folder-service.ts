import { readdirSync, statSync, existsSync } from "fs";
import { join, dirname, resolve, basename } from "path";
import { homedir } from "os";
import { CLAUDE_PROJECTS_DIR, projectDirToFolder } from "../utils/paths.js";
import { resolveWorktreeToMainRepoCached } from "../utils/git.js";
import type { FolderItem, BrowseResult, ValidateResult, FolderSuggestion } from "shared/types/index.js";

/** Base directory for CCUI agent workspaces (excluded from recent folders). */
const CCUI_AGENTS_DIR = process.env.CCUI_AGENTS_DIR || join(homedir(), ".ccui-agents");

export type { FolderItem, BrowseResult, ValidateResult, FolderSuggestion };

export interface RecentFolder extends FolderSuggestion {
  type: "recent";
  lastUsed: string;
  chatCount: number;
}

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

          // Check if directory is a git repository
          if (itemStat.isDirectory()) {
            folderItem.isGitRepo = existsSync(join(itemPath, ".git"));
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

        const rawFolder = projectDirToFolder(dir);
        // Resolve worktree paths to the main repo so they merge with the parent
        const { mainRepoPath: folder } = resolveWorktreeToMainRepoCached(rawFolder);

        // Skip directories that no longer exist
        if (!existsSync(folder)) continue;

        // Skip CCUI agent workspace directories
        if (folder.startsWith(CCUI_AGENTS_DIR + "/") || folder === CCUI_AGENTS_DIR) continue;

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
        return {
          path,
          name: basename(path),
          description: `Used ${ago}`,
          type: "recent" as const,
          lastUsed: info.lastUsed.toISOString(),
          chatCount: info.chatCount,
        };
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
   * Clear the cache (useful for testing or manual refresh)
   */
  clearCache(): void {
    this.cache.clear();
  }
}

export const folderService = new FolderService();
