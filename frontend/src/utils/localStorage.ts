import type { DefaultPermissions } from "../api";

const STORAGE_KEYS = {
  SETTINGS: "claude-code-settings",
} as const;

interface RecentDirectory {
  path: string;
  lastUsed: string;
}

export type ThemeMode = "light" | "dark" | "system";

export type AgentProviderKind = "claude-code" | "openrouter";

/**
 * OpenRouter reasoning-effort levels. Maps onto the OR `reasoning.effort`
 * field which OR translates to each provider's native parameter (Anthropic
 * `thinking.budget_tokens`, OpenAI `reasoning_effort`, etc). Ignored by
 * non-reasoning models.
 *
 * `undefined` (no value persisted) means "don't send a reasoning payload";
 * `"none"` means "explicitly request no reasoning". Both produce the same
 * runtime behavior on most models but are kept distinct for UI clarity.
 */
export type EffortLevel = "xhigh" | "high" | "medium" | "low" | "minimal" | "none";

interface LocalStorageData {
  defaultPermissions?: DefaultPermissions;
  recentDirectories?: RecentDirectory[];
  maxTurns?: number;
  useWorktree?: boolean;
  autoCreateBranch?: boolean;
  showTriggeredChats?: boolean;
  themeMode?: ThemeMode;
  customThemeName?: string | null;
  sidebarCollapsed?: boolean;
  sidebarViewMode?: "folders" | "chats";
  folderMaxAgeDays?: number;
  /** User's last-selected provider in the New Chat panel — persisted so the
   * toggle remembers their choice across page reloads. */
  defaultProvider?: AgentProviderKind;
  /** User's last-selected OpenRouter reasoning effort in the New Chat panel.
   * Stored even when the provider is Claude Code so toggling back to OR
   * restores the prior selection. */
  defaultOpenRouterEffort?: EffortLevel;
  /** User's last-selected OpenRouter model slug in the New Chat panel.
   * Empty/absent means "use the global default from Settings → API". */
  defaultOpenRouterModel?: string;
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

const KNOWN_PROVIDERS: ReadonlySet<AgentProviderKind> = new Set(["claude-code", "openrouter"]);

export function getDefaultProvider(): AgentProviderKind {
  const data = getStorageData();
  const stored = data.defaultProvider;
  // Validate against the known set on read — protects against stale or
  // forward-compat values (e.g. an experimental "codex" written by a
  // future build then opened in an older one). Unknown → claude-code.
  return stored && KNOWN_PROVIDERS.has(stored) ? stored : "claude-code";
}

export function saveDefaultProvider(provider: AgentProviderKind): void {
  if (!KNOWN_PROVIDERS.has(provider)) return;
  const data = getStorageData();
  data.defaultProvider = provider;
  setStorageData(data);
}

const KNOWN_EFFORTS: ReadonlySet<EffortLevel> = new Set([
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
]);

/**
 * Last-selected OpenRouter effort. Returns `undefined` when nothing has been
 * stored — the New Chat dropdown surfaces this as the "(unset)" option,
 * which leaves the `reasoning` payload off the OR API call entirely. Any
 * stored value not in {@link KNOWN_EFFORTS} (e.g. a forward-compat level
 * from a newer build) also degrades to `undefined`.
 */
export function getDefaultOpenRouterEffort(): EffortLevel | undefined {
  const data = getStorageData();
  const stored = data.defaultOpenRouterEffort;
  return stored && KNOWN_EFFORTS.has(stored) ? stored : undefined;
}

export function saveDefaultOpenRouterEffort(effort: EffortLevel | undefined): void {
  const data = getStorageData();
  if (effort === undefined) {
    delete data.defaultOpenRouterEffort;
  } else if (KNOWN_EFFORTS.has(effort)) {
    data.defaultOpenRouterEffort = effort;
  } else {
    return; // unknown value — leave existing state alone
  }
  setStorageData(data);
}

/**
 * Last-selected OpenRouter model slug. Returns `""` when nothing has been
 * stored — the New Chat selector treats empty as "use the global default
 * configured in Settings → API".
 */
export function getDefaultOpenRouterModel(): string {
  const data = getStorageData();
  return typeof data.defaultOpenRouterModel === "string" ? data.defaultOpenRouterModel : "";
}

export function saveDefaultOpenRouterModel(model: string): void {
  const data = getStorageData();
  const trimmed = model.trim();
  if (trimmed.length === 0) {
    delete data.defaultOpenRouterModel;
  } else {
    data.defaultOpenRouterModel = trimmed;
  }
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

export function getCustomThemeName(): string | null {
  const data = getStorageData();
  return data.customThemeName ?? null;
}

export function saveCustomThemeName(name: string | null): void {
  const data = getStorageData();
  data.customThemeName = name;
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

export type SidebarViewMode = "folders" | "chats";

export function getSidebarViewMode(): SidebarViewMode {
  const data = getStorageData();
  return data.sidebarViewMode ?? "chats";
}

export function saveSidebarViewMode(mode: SidebarViewMode): void {
  const data = getStorageData();
  data.sidebarViewMode = mode;
  setStorageData(data);
}

export function getFolderMaxAgeDays(): number {
  const data = getStorageData();
  return data.folderMaxAgeDays ?? 5;
}

export function saveFolderMaxAgeDays(days: number): void {
  const data = getStorageData();
  data.folderMaxAgeDays = days;
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
