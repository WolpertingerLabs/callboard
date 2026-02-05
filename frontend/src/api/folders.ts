const BASE = '/api';

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

export interface SuggestionsResponse {
  suggestions: FolderSuggestion[];
}

/**
 * Browse directories and files in the given path
 */
export async function browseDirectory(
  path: string,
  showHidden: boolean = false,
  limit: number = 500
): Promise<BrowseResult> {
  const params = new URLSearchParams({
    path,
    showHidden: showHidden.toString(),
    limit: limit.toString()
  });

  const res = await fetch(`${BASE}/folders/browse?${params}`);
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to browse directory');
  }
  return res.json();
}

/**
 * Validate if a path exists and is accessible
 */
export async function validatePath(path: string): Promise<ValidateResult> {
  const params = new URLSearchParams({ path });

  const res = await fetch(`${BASE}/folders/validate?${params}`);
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to validate path');
  }
  return res.json();
}

/**
 * Get suggested directories for quick access
 */
export async function getFolderSuggestions(): Promise<SuggestionsResponse> {
  const res = await fetch(`${BASE}/folders/suggestions`);
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to get folder suggestions');
  }
  return res.json();
}

/**
 * Clear the server-side cache (useful for development)
 */
export async function clearFolderCache(): Promise<void> {
  const res = await fetch(`${BASE}/folders/clear-cache`, { method: 'POST' });
  if (!res.ok) {
    const error = await res.json();
    throw new Error(error.error || 'Failed to clear cache');
  }
}