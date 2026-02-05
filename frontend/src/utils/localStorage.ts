import type { DefaultPermissions } from '../api';

const STORAGE_KEYS = {
  SETTINGS: 'claude-code-settings',
} as const;

interface RecentDirectory {
  path: string;
  lastUsed: string;
}

interface LocalStorageData {
  defaultPermissions?: DefaultPermissions;
  recentDirectories?: RecentDirectory[];
}

const DEFAULT_PERMISSIONS: DefaultPermissions = {
  fileOperations: 'ask',
  codeExecution: 'ask',
  webAccess: 'ask',
};

function getStorageData(): LocalStorageData {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function setStorageData(data: LocalStorageData): void {
  try {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(data));
  } catch {
    // Ignore localStorage errors (e.g., quota exceeded)
  }
}

export function getDefaultPermissions(): DefaultPermissions {
  const data = getStorageData();
  return data.defaultPermissions || DEFAULT_PERMISSIONS;
}

export function saveDefaultPermissions(permissions: DefaultPermissions): void {
  const data = getStorageData();
  data.defaultPermissions = permissions;
  setStorageData(data);
}

export function getRecentDirectories(): RecentDirectory[] {
  const data = getStorageData();
  return data.recentDirectories || [];
}

export function addRecentDirectory(path: string): void {
  const data = getStorageData();
  const existing = data.recentDirectories || [];

  // Remove existing entry for this path
  const filtered = existing.filter(dir => dir.path !== path);

  // Add to front with current timestamp
  const updated = [
    { path, lastUsed: new Date().toISOString() },
    ...filtered
  ].slice(0, 5); // Keep only top 5

  data.recentDirectories = updated;
  setStorageData(data);
}

export function removeRecentDirectory(path: string): void {
  const data = getStorageData();
  const existing = data.recentDirectories || [];

  data.recentDirectories = existing.filter(dir => dir.path !== path);
  setStorageData(data);
}

export function clearAllRecentDirectories(): void {
  const data = getStorageData();
  data.recentDirectories = [];
  setStorageData(data);
}

export function initializeSuggestedDirectories(chatDirectories: string[]): void {
  const existing = getRecentDirectories();

  // Only initialize if there are no existing suggested directories
  if (existing.length === 0 && chatDirectories.length > 0) {
    const data = getStorageData();

    // Take first three unique directories
    const uniqueDirs = [...new Set(chatDirectories)];
    const suggestedDirs = uniqueDirs.slice(0, 3).map(path => ({
      path,
      lastUsed: new Date().toISOString()
    }));

    data.recentDirectories = suggestedDirs;
    setStorageData(data);
  }
}