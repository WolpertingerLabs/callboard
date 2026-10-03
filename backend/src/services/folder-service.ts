import { readdirSync, statSync, existsSync } from "fs";
import { join, dirname, resolve, basename } from "path";
import { homedir } from "os";
import { WORKSPACES_DIR } from "../utils/paths.js";
import { getSessionProviders } from "../agents/factory.js";
import type { FolderItem, BrowseResult, ValidateResult, FolderSuggestion } from "shared/types/index.js";

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

class FolderService {
  private cache = new Map<string, { data: BrowseResult; timestamp: number }>();
  private recentCache = new Map<number, { data: RecentFolder[]; timestamp: number }>();
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
    const cached = this.recentCache.get(limit);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    try {
      // Aggregate sessions from all providers into folder stats
      const folderMap = new Map<string, { lastUsed: Date; chatCount: number }>();
      // One existsSync per distinct folder, not one per session.
      const folderExists = new Map<string, boolean>();

      for (const provider of getSessionProviders()) {
        // Every session, not a capped page: chatCount is an all-time count, so
        // a cap (this was 9999) undercounts every folder once a provider
        // passes it. The scan is the one GET /api/chats already drains on
        // each sidebar load, and this result is cached for CACHE_TTL.
        const { sessions } = provider.discoverSessions({ limit: Number.MAX_SAFE_INTEGER, offset: 0 });
        for (const s of sessions) {
          const folder = s.displayFolder;

          // Skip directories that no longer exist
          let exists = folderExists.get(folder);
          if (exists === undefined) {
            exists = existsSync(folder);
            folderExists.set(folder, exists);
          }
          if (!exists) continue;

          // Skip agent workspace directories
          if (folder.startsWith(WORKSPACES_DIR + "/") || folder === WORKSPACES_DIR) continue;

          const existing = folderMap.get(folder);
          if (existing) {
            existing.chatCount += 1;
            if (s.updatedAt > existing.lastUsed) {
              existing.lastUsed = s.updatedAt;
            }
          } else {
            folderMap.set(folder, { lastUsed: s.updatedAt, chatCount: 1 });
          }
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
      this.recentCache.set(limit, { data: results, timestamp: Date.now() });

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
    this.recentCache.clear();
  }
}

export const folderService = new FolderService();
