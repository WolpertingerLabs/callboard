import type { DefaultPermissions } from "../api";

const STORAGE_KEYS = {
  SETTINGS: "claude-code-settings",
} as const;

interface RecentDirectory {
  path: string;
  lastUsed: string;
}

export type ThemeMode = "light" | "dark" | "system";

interface LocalStorageData {
  defaultPermissions?: DefaultPermissions;
  recentDirectories?: RecentDirectory[];
  maxTurns?: number;
  useWorktree?: boolean;
  autoCreateBranch?: boolean;
  showTriggeredChats?: boolean;
  themeMode?: ThemeMode;
  sidebarCollapsed?: boolean;
}

/** Check if a path is inside the Callboard agent-workspaces directory (excluded from recommended folders). */
function isCallboardWorkspacePath(path: string): boolean {
  return path.includes("/.callboard/agent-workspaces/") || path.endsWith("/.callboard/agent-workspaces");
}

const DEFAULT_PERMISSIONS: DefaultPermissions = {
  fileRead: "ask",
  fileWrite: "ask",
  codeExecution: "ask",
  webAccess: "ask",
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
  if (data.defaultPermissions) {
    return data.defaultPermissions;
  }
  return DEFAULT_PERMISSIONS;
}

export function saveDefaultPermissions(permissions: DefaultPermissions): void {
  const data = getStorageData();
  data.defaultPermissions = permissions;
  setStorageData(data);
}

const DEFAULT_MAX_TURNS = 200;

export function getMaxTurns(): number {
  const data = getStorageData();
  return data.maxTurns ?? DEFAULT_MAX_TURNS;
}

export function saveMaxTurns(value: number): void {
  const data = getStorageData();
  data.maxTurns = value;
  setStorageData(data);
}

export function getRecentDirectories(): RecentDirectory[] {
  const data = getStorageData();
  return (data.recentDirectories || []).filter((dir) => !isCallboardWorkspacePath(dir.path));
}

export function addRecentDirectory(path: string): void {
  const data = getStorageData();
  const existing = data.recentDirectories || [];

  // Remove existing entry for this path
  const filtered = existing.filter((dir) => dir.path !== path);

  // Add to front with current timestamp
  const updated = [{ path, lastUsed: new Date().toISOString() }, ...filtered].slice(0, 5); // Keep only top 5

  data.recentDirectories = updated;
  setStorageData(data);
}

export function removeRecentDirectory(path: string): void {
  const data = getStorageData();
  const existing = data.recentDirectories || [];

  data.recentDirectories = existing.filter((dir) => dir.path !== path);
  setStorageData(data);
}

export function getUseWorktree(): boolean {
  const data = getStorageData();
  return data.useWorktree ?? false;
}

export function saveUseWorktree(value: boolean): void {
  const data = getStorageData();
  data.useWorktree = value;
  setStorageData(data);
}

export function getAutoCreateBranch(): boolean {
  const data = getStorageData();
  return data.autoCreateBranch ?? false;
}

export function saveAutoCreateBranch(value: boolean): void {
  const data = getStorageData();
  data.autoCreateBranch = value;
  setStorageData(data);
}

export function getShowTriggeredChats(): boolean {
  const data = getStorageData();
  return data.showTriggeredChats ?? false;
}

export function saveShowTriggeredChats(value: boolean): void {
  const data = getStorageData();
  data.showTriggeredChats = value;
  setStorageData(data);
}

export function getThemeMode(): ThemeMode {
  const data = getStorageData();
  return data.themeMode ?? "system";
}

export function saveThemeMode(mode: ThemeMode): void {
  const data = getStorageData();
  data.themeMode = mode;
  setStorageData(data);
}

export function getSidebarCollapsed(): boolean {
  const data = getStorageData();
  return data.sidebarCollapsed ?? false;
}

export function saveSidebarCollapsed(value: boolean): void {
  const data = getStorageData();
  data.sidebarCollapsed = value;
  setStorageData(data);
}

export function initializeSuggestedDirectories(chatDirectories: string[]): void {
  const existing = getRecentDirectories();

  // Only initialize if there are no existing suggested directories
  if (existing.length === 0 && chatDirectories.length > 0) {
    const data = getStorageData();

    // Take first three unique directories, excluding Callboard workspace paths
    const uniqueDirs = [...new Set(chatDirectories)].filter((dir) => !isCallboardWorkspacePath(dir));
    const suggestedDirs = uniqueDirs.slice(0, 3).map((path) => ({
      path,
      lastUsed: new Date().toISOString(),
    }));

    data.recentDirectories = suggestedDirs;
    setStorageData(data);
  }
}
