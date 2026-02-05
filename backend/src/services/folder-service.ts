import { readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';

export interface FolderItem {
  name: string;
  path: string;
  type: 'directory' | 'file';
  isHidden: boolean;
  size?: number;
  modified?: string;
  isGitRepo?: boolean;
}

export interface BrowseResult {
  directories: FolderItem[];
  files: FolderItem[];
  parent: string | null;
  exists: boolean;
  currentPath: string;
}

export interface ValidateResult {
  valid: boolean;
  exists: boolean;
  readable: boolean;
  isGit?: boolean;
  isDirectory?: boolean;
}

export interface FolderSuggestion {
  path: string;
  name: string;
  description: string;
  type: 'system' | 'user' | 'recent';
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
    if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
      return cached.data;
    }

    const result: BrowseResult = {
      directories: [],
      files: [],
      parent: null,
      exists: false,
      currentPath: resolvedPath
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
        const isHidden = item.startsWith('.');

        // Skip hidden files if not requested
        if (isHidden && !showHidden) continue;

        try {
          const itemStat = statSync(itemPath);
          const folderItem: FolderItem = {
            name: item,
            path: itemPath,
            type: itemStat.isDirectory() ? 'directory' : 'file',
            isHidden,
            size: itemStat.size,
            modified: itemStat.mtime.toISOString()
          };

          // Check if directory is a git repository
          if (itemStat.isDirectory()) {
            folderItem.isGitRepo = existsSync(join(itemPath, '.git'));
            result.directories.push(folderItem);
          } else {
            result.files.push(folderItem);
          }

          processedCount++;
        } catch (err) {
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
      console.error('Error browsing directory:', err);
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
          readable: false
        };
      }

      const stat = statSync(resolvedPath);
      const isDirectory = stat.isDirectory();
      const isGit = isDirectory && existsSync(join(resolvedPath, '.git'));

      return {
        valid: true,
        exists: true,
        readable: true,
        isDirectory,
        isGit
      };
    } catch (err) {
      return {
        valid: false,
        exists: existsSync(resolvedPath),
        readable: false
      };
    }
  }

  /**
   * Get suggested directories for quick access
   */
  getSuggestions(): FolderSuggestion[] {
    const suggestions: FolderSuggestion[] = [];

    // System directories
    const systemDirs = [
      { path: '/', name: 'Root', description: 'System root directory' },
      { path: '/home', name: 'Home', description: 'User home directories' },
      { path: '/opt', name: 'Optional', description: 'Optional software packages' },
      { path: '/usr/local', name: 'Local', description: 'Local software installations' },
      { path: '/var', name: 'Variable', description: 'Variable data files' },
      { path: '/tmp', name: 'Temp', description: 'Temporary files' }
    ];

    for (const dir of systemDirs) {
      if (existsSync(dir.path)) {
        suggestions.push({
          ...dir,
          type: 'system'
        });
      }
    }

    // User home directory
    const home = homedir();
    if (existsSync(home)) {
      suggestions.push({
        path: home,
        name: 'Home Directory',
        description: 'Your personal home directory',
        type: 'user'
      });
    }

    // Common development directories in home
    const devDirs = ['Desktop', 'Documents', 'Downloads', 'Projects', 'workspace', 'code', 'dev'];
    for (const dir of devDirs) {
      const fullPath = join(home, dir);
      if (existsSync(fullPath)) {
        suggestions.push({
          path: fullPath,
          name: dir,
          description: `${dir} directory`,
          type: 'user'
        });
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