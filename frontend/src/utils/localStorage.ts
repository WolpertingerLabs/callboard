import { normalizePermissions } from "shared/types/permissions.js";
import type { DefaultPermissions } from "../api";
import type { EffortLevel, UiAgentProviderKind } from "shared/types/index.js";

export type { EffortLevel };
export type AgentProviderKind = UiAgentProviderKind;

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
  /**
   * The two halves of the old `Auto-create` + `Worktree` checkbox pair.
   *
   * @deprecated Superseded by {@link worktreeByDefault}. Unread — kept as
   * fields only so a bundle predating the change, open in another tab, still
   * parses the store it shares with this one.
   *
   * Deliberately *not* migrated into `worktreeByDefault`: under the old gated
   * semantics `useWorktree: true` meant "checked while a branch change was
   * pending", and it did nothing at all on a chat with no branch change.
   * Reading it as the new preference would start minting worktrees for chats
   * the user never asked to isolate.
   */
  useWorktree?: boolean;
  /** @deprecated See {@link useWorktree}. */
  autoCreateBranch?: boolean;
  /** BranchSelector's "New worktree" toggle, restored on the next new chat. */
  worktreeByDefault?: boolean;
  showTriggeredChats?: boolean;
  /**
   * Whether the sidebar includes chats on an archived card — closed or hidden.
   * A chat on NO card is not archived and is in the list either way.
   * Absent means "never chosen" — see {@link getChatsShowArchived}, which seeds
   * it from the two keys below rather than defaulting blindly.
   */
  chatsShowArchived?: boolean;
  /**
   * Sidebar scoped to chats on an open card (and their descendants).
   *
   * @deprecated Superseded by {@link chatsShowArchived}. Read once, to seed it;
   * never written again. Still declared because an older bundle open in another
   * tab both reads and writes it.
   */
  chatsCardsOnly?: boolean;
  /**
   * The old three-way card-lifecycle scope: "all" | "active" | "inactive".
   *
   * @deprecated See {@link chatsCardsOnly}. Typed loosely because it is now
   * only ever compared against, never sent anywhere.
   */
  chatsCardLifecycle?: string;
  /**
   * The old "Dim inactive chats" switch.
   *
   * @deprecated The dim is unconditional now, so nothing reads or writes this.
   * Left declared to document that an older bundle still writes it and still
   * reads it back, so it must not be stripped. The declaration is not what
   * preserves it: `getStorageData` casts the whole parsed blob and
   * `setStorageData` re-serialises it, so every key round-trips whether this
   * interface names it or not. Anything that starts picking fields out of the
   * parsed object would break that, and this is the note saying why not to.
   */
  chatsDimCardless?: boolean;
  /**
   * The daemon build id whose reload prompt the user waved off. Keyed by the
   * id, not a boolean, so the *next* upgrade is announced again — see
   * `utils/buildIdentity.ts`.
   *
   * Shared across tabs on this origin, which is the intent: one "not now"
   * quiets the fleet, not just the tab it was clicked in. Note that the store
   * alone does not achieve that — an already-open tab reads this once at mount
   * and would never see a later write. `StaleBundleBanner` carries a `storage`
   * listener for that, and an upgrade is precisely the case where every tab
   * already has the banner up.
   */
  dismissedStaleBuildId?: string;
  themeMode?: ThemeMode;
  customThemeName?: string | null;
  sidebarCollapsed?: boolean;
  /** Desktop sidebar width in pixels when expanded. Clamped to >= SIDEBAR_MIN_WIDTH on read. */
  sidebarWidth?: number;
  sidebarViewMode?: "folders" | "chats";
  /** Whether the board's Closed section is expanded. */
  boardClosedExpanded?: boolean;
  /** Board layout: full-width rows instead of the tile grid. Absent = "cards". */
  boardViewMode?: "cards" | "list";
  /** Whether card faces show the folders their chats live in. Absent = hidden. */
  boardShowPaths?: boolean;
  /** List view: whether rows rest expanded. Absent = collapsed. */
  boardRowsExpanded?: boolean;
  folderMaxAgeDays?: number;
  folderShowSizes?: boolean;
  /** User's last-selected provider in the New Chat panel — persisted so the
   * toggle remembers their choice across page reloads. */
  defaultProvider?: AgentProviderKind;
  /** Last-selected ACP vendor id. Only meaningful when defaultProvider is "acp". */
  defaultAcpProviderId?: string;
  /** Last-selected ACP model, as the vendor names it. */
  defaultAcpModel?: string;
  /** User's last-selected Cline model. Kept separate from the other providers'
   * model values so switching the toggle restores each one's prior selection.
   * Empty/absent means "use the global default from Settings → API". */
  defaultClineModel?: string;
  defaultPiModel?: string;
  /** User's last-selected reasoning effort in the New Chat panel. Shared by
   * every reasoning-capable provider. Stored even when the provider is Claude
   * Code so toggling back restores the prior selection. The key keeps its
   * OpenRouter-era name so existing stored preferences survive. */
  defaultOpenRouterEffort?: EffortLevel;
  /** User's last-selected Anthropic model (alias or full ID) for Claude Code
   * chats in the New Chat panel. Stored separately from the other providers'
   * models so toggling providers restores each one's prior selection.
   * Empty/absent means "use the global default from Settings → API". */
  defaultClaudeModel?: string;
  /** User's last-selected Codex model (e.g. "gpt-5.5") for Codex chats in the
   * New Chat panel. Stored separately from the Claude model so toggling
   * providers restores each one's prior selection. Empty/absent means "use the
   * global default from Settings → API". */
  defaultCodexModel?: string;
  /** Whether tool call inputs/results render JSON pretty-printed (true) or
   * as the raw string (false). Superseded by {@link jsonViewMode}; kept so
   * existing stored preferences migrate ("false" → "raw"). */
  jsonPrettyPrint?: boolean;
  /** How tool call inputs/results render JSON: collapsible key-value tree,
   * pretty-printed JSON text, or the raw string. Toggled inline from any
   * tool view. */
  jsonViewMode?: JsonViewMode;
}

export type JsonViewMode = "tree" | "pretty" | "raw";

/** Check if a path is inside the Callboard agent-workspaces directory (excluded from recommended folders). */
function isCallboardWorkspacePath(path: string): boolean {
  return path.includes("/.callboard/agent-workspaces/") || path.endsWith("/.callboard/agent-workspaces");
}

function getStorageData(): LocalStorageData {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as LocalStorageData) : {};
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
  return normalizePermissions(data.defaultPermissions);
}

export function saveDefaultPermissions(permissions: DefaultPermissions): void {
  const data = getStorageData();
  data.defaultPermissions = normalizePermissions(permissions);
  setStorageData(data);
}

const KNOWN_PROVIDERS: ReadonlySet<AgentProviderKind> = new Set(["claude-code", "codex", "acp", "cline", "pi"]);

export function getDefaultProvider(): AgentProviderKind {
  const data = getStorageData();
  const stored = data.defaultProvider;
  // Validate against the known set on read — protects against stale or
  // forward-compat values (e.g. an experimental "codex" written by a
  // future build then opened in an older one). Unknown → claude-code.
  // This is also what retires a saved `"openrouter"` default: the harness is
  // gone from the set, so the stored preference lapses to claude-code on the
  // next read rather than needing a migration.
  return stored && KNOWN_PROVIDERS.has(stored) ? stored : "claude-code";
}

export function saveDefaultProvider(provider: AgentProviderKind): void {
  if (!KNOWN_PROVIDERS.has(provider)) return;
  const data = getStorageData();
  data.defaultProvider = provider;
  setStorageData(data);
}

/**
 * Last-selected ACP vendor id (`"opencode"`, …).
 *
 * Deliberately NOT validated against a known set on read, unlike the provider
 * above: the vendor list is server-side data that grows without a frontend
 * build (built-in presets today, user-defined providers later), so a set here
 * would go stale and silently discard a legitimate choice. The caller checks it
 * against the live `acpProviders` list from `/api/system-info` instead, which is
 * the only place that can actually know.
 */
export function getDefaultAcpProviderId(): string {
  const data = getStorageData();
  return typeof data.defaultAcpProviderId === "string" ? data.defaultAcpProviderId : "";
}

export function saveDefaultAcpProviderId(providerId: string): void {
  const data = getStorageData();
  data.defaultAcpProviderId = providerId;
  setStorageData(data);
}

/**
 * Last-selected ACP model. Empty means "leave the vendor CLI's own configured
 * model alone", which is the only sensible default: `acp` covers many vendors
 * and there is no model id that would be a reasonable guess across them.
 *
 * Stored per user rather than per vendor, matching how the OR / Claude / Codex
 * model preferences are kept. Switching vendors therefore carries the old
 * string over — the agent rejects a model it does not have, with its own
 * message, rather than silently running on something else.
 */
export function getDefaultAcpModel(): string {
  const data = getStorageData();
  return typeof data.defaultAcpModel === "string" ? data.defaultAcpModel : "";
}

export function saveDefaultAcpModel(model: string): void {
  const data = getStorageData();
  data.defaultAcpModel = model;
  setStorageData(data);
}

/**
 * Last-selected Cline model.
 *
 * One value, not one per Cline provider. Changing the provider in
 * Settings → API is a rare, deliberate act, and the suggestion list re-scopes
 * itself the moment it changes — so a carried-over model from the previous
 * provider is visible and correctable rather than silent. Same trade the ACP
 * pair makes across vendors.
 */
export function getDefaultClineModel(): string {
  const data = getStorageData();
  return typeof data.defaultClineModel === "string" ? data.defaultClineModel : "";
}

export function saveDefaultClineModel(model: string): void {
  const data = getStorageData();
  data.defaultClineModel = model;
  setStorageData(data);
}

/**
 * Last per-chat pi model, remembered across New Chat panels the same way the
 * ACP one is. Empty means "use the default from Settings → API".
 */
export function getDefaultPiModel(): string {
  const data = getStorageData();
  return typeof data.defaultPiModel === "string" ? data.defaultPiModel : "";
}

export function saveDefaultPiModel(model: string): void {
  const data = getStorageData();
  data.defaultPiModel = model;
  setStorageData(data);
}

/** Preserve stored strings, including stale/future levels, so the picker can
 * explain unsupported overrides rather than silently downgrading to default. */
export function getDefaultOpenRouterEffort(): EffortLevel | undefined {
  const data = getStorageData();
  const stored = data.defaultOpenRouterEffort;
  return typeof stored === "string" && stored.length > 0 ? stored : undefined;
}

export function saveDefaultOpenRouterEffort(effort: EffortLevel | undefined): void {
  const data = getStorageData();
  if (effort === undefined) {
    delete data.defaultOpenRouterEffort;
  } else {
    data.defaultOpenRouterEffort = effort;
  }
  setStorageData(data);
}

/**
 * Last-selected Anthropic model for Claude Code chats. Returns `""` when
 * nothing has been stored — the New Chat selector treats empty as "use the
 * global default configured in Settings → API".
 */
export function getDefaultClaudeModel(): string {
  const data = getStorageData();
  return typeof data.defaultClaudeModel === "string" ? data.defaultClaudeModel : "";
}

export function saveDefaultClaudeModel(model: string): void {
  const data = getStorageData();
  const trimmed = model.trim();
  if (trimmed.length === 0) {
    delete data.defaultClaudeModel;
  } else {
    data.defaultClaudeModel = trimmed;
  }
  setStorageData(data);
}

/**
 * Last-selected Codex model for Codex chats. Returns `""` when nothing has
 * been stored — the New Chat selector treats empty as "use the global default
 * configured in Settings → API".
 */
export function getDefaultCodexModel(): string {
  const data = getStorageData();
  return typeof data.defaultCodexModel === "string" ? data.defaultCodexModel : "";
}

export function saveDefaultCodexModel(model: string): void {
  const data = getStorageData();
  const trimmed = model.trim();
  if (trimmed.length === 0) {
    delete data.defaultCodexModel;
  } else {
    data.defaultCodexModel = trimmed;
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

export function getWorktreeByDefault(): boolean {
  const data = getStorageData();
  // Coerced on read, like `getDefaultProvider` validates on read: the store is
  // JSON someone else's build wrote, and `?? false` passes a stored `"yes"`
  // straight through to a checkbox's `checked=`, where a string is not a
  // boolean and React has to guess.
  return data.worktreeByDefault === true;
}

export function saveWorktreeByDefault(value: boolean): void {
  const data = getStorageData();
  data.worktreeByDefault = value;
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

/**
 * Whether the sidebar includes chats on an archived card — closed or hidden.
 * A chat on no card at all is not archived and is in the list either way, so
 * this decides strictly fewer rows than its name once implied.
 *
 * Migrates the three-way scope this replaced, once, on first read: a stored
 * scope of "all" or "inactive" was showing the user archived rows, so it seeds
 * ON; "active" — or the older `cardsOnly` boolean it aliased — was hiding them,
 * so it seeds OFF. A store with neither seeds OFF, the new default, rather than
 * inheriting the old "all": hiding archived chats IS the change.
 *
 * The legacy pair is resolved the way the bundle that wrote it did (explicit
 * scope wins; else `cardsOnly: true` meant "active") rather than by reading
 * `chatsCardLifecycle` alone. That is deliberate and it changes no answer
 * today: every branch `cardsOnly` can reach returns `false`, which is also
 * where an unrecognised store lands. It is here to state which preference is
 * being migrated, so that flipping the default later cannot quietly turn "this
 * user asked for open cards only" into "this user never chose".
 *
 * `typeof === "boolean"` on the new key rather than `??` because this is JSON
 * another bundle version or a hand edit could have written anything into, and
 * the answer decides which scope goes out as a query param.
 *
 * The legacy keys are read, never written back — {@link saveChatsShowArchived}
 * touches only the new one, so they stop tracking the user's choice from the
 * first save. They are not deleted either: the store round-trips every key it
 * holds, and an older bundle in another tab still reads them.
 */
export function getChatsShowArchived(): boolean {
  const data = getStorageData();
  if (typeof data.chatsShowArchived === "boolean") return data.chatsShowArchived;
  const legacyScope = data.chatsCardLifecycle ?? (data.chatsCardsOnly === true ? "active" : undefined);
  return legacyScope === "all" || legacyScope === "inactive";
}

export function saveChatsShowArchived(value: boolean): void {
  const data = getStorageData();
  data.chatsShowArchived = value;
  setStorageData(data);
}

/**
 * The build id whose reload prompt was dismissed, or `null`.
 *
 * Type-checked on the way out rather than trusted: this is JSON on disk, and a
 * non-string here is compared against a real build id by `shouldPromptReload`.
 * A stored `0` would never match one, so the failure mode is silent — the
 * prompt reappears — but "silently ignore the store" is the behaviour to pick
 * deliberately, not to arrive at by accident.
 */
export function getDismissedStaleBuildId(): string | null {
  const data = getStorageData();
  return typeof data.dismissedStaleBuildId === "string" ? data.dismissedStaleBuildId : null;
}

export function saveDismissedStaleBuildId(buildId: string): void {
  const data = getStorageData();
  data.dismissedStaleBuildId = buildId;
  setStorageData(data);
}

export function getJsonViewMode(): JsonViewMode {
  const data = getStorageData();
  if (data.jsonViewMode === "tree" || data.jsonViewMode === "pretty" || data.jsonViewMode === "raw") {
    return data.jsonViewMode;
  }
  // Migrate the pre-tree boolean preference: an explicit "raw" choice is
  // preserved; pretty-printing (or no preference) upgrades to the tree view.
  if (data.jsonPrettyPrint === false) return "raw";
  return "tree";
}

export function saveJsonViewMode(mode: JsonViewMode): void {
  const data = getStorageData();
  data.jsonViewMode = mode;
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

/** Minimum width (px) of the expanded desktop sidebar — enforced on drag and on read. */
export const SIDEBAR_MIN_WIDTH = 350;
const DEFAULT_SIDEBAR_WIDTH = 360;

export function getSidebarWidth(): number {
  const data = getStorageData();
  const stored = typeof data.sidebarWidth === "number" && Number.isFinite(data.sidebarWidth) ? data.sidebarWidth : DEFAULT_SIDEBAR_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, stored);
}

export function saveSidebarWidth(value: number): void {
  const data = getStorageData();
  data.sidebarWidth = Math.max(SIDEBAR_MIN_WIDTH, Math.round(value));
  setStorageData(data);
}

export type SidebarViewMode = "folders" | "chats";

const SIDEBAR_VIEW_MODES: readonly string[] = ["folders", "chats"];

export function getSidebarViewMode(): SidebarViewMode {
  const data = getStorageData();
  // Anyone who last used the removed "jobs" view still has it persisted, and a
  // mode with no branch left to render would leave them on a blank sidebar.
  const stored = data.sidebarViewMode as string | undefined;
  return stored && SIDEBAR_VIEW_MODES.includes(stored) ? (stored as SidebarViewMode) : "chats";
}

export function saveSidebarViewMode(mode: SidebarViewMode): void {
  const data = getStorageData();
  data.sidebarViewMode = mode;
  setStorageData(data);
}

export function getBoardClosedExpanded(): boolean {
  const data = getStorageData();
  return data.boardClosedExpanded === true;
}

export function saveBoardClosedExpanded(expanded: boolean): void {
  const data = getStorageData();
  data.boardClosedExpanded = expanded;
  setStorageData(data);
}

export type BoardViewMode = "cards" | "list";

const BOARD_VIEW_MODES: readonly string[] = ["cards", "list"];

export function getBoardViewMode(): BoardViewMode {
  const data = getStorageData();
  // Matched against the known values rather than cast: the store is shared
  // with bundles this one has never met, so an unrecognised mode has to fall
  // back to the default rather than render a container that doesn't exist.
  const stored = data.boardViewMode as string | undefined;
  return stored && BOARD_VIEW_MODES.includes(stored) ? (stored as BoardViewMode) : "cards";
}

export function saveBoardViewMode(mode: BoardViewMode): void {
  const data = getStorageData();
  data.boardViewMode = mode;
  setStorageData(data);
}

export function getBoardShowPaths(): boolean {
  const data = getStorageData();
  return data.boardShowPaths === true;
}

export function saveBoardShowPaths(show: boolean): void {
  const data = getStorageData();
  data.boardShowPaths = show;
  setStorageData(data);
}

/**
 * The RESTING state of a list row's folder breakdown, not the state of any
 * particular row. Per-row overrides are deliberately ephemeral: an expansion
 * restored across a reload onto a card that has since collapsed to one folder
 * is a row that opens onto nothing.
 */
export function getBoardRowsExpanded(): boolean {
  const data = getStorageData();
  return data.boardRowsExpanded === true;
}

export function saveBoardRowsExpanded(expanded: boolean): void {
  const data = getStorageData();
  data.boardRowsExpanded = expanded;
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

/**
 * Whether the folder list asks the server to measure each directory.
 *
 * Off by default and deliberately sticky: `du -sk` over a worktree with a cold
 * `node_modules` is seconds, and this list is polled every fifteen seconds
 * while a session is live. A user who wants sizes turns them on once; everyone
 * else never pays for them.
 */
export function getFolderShowSizes(): boolean {
  const data = getStorageData();
  return data.folderShowSizes ?? false;
}

export function saveFolderShowSizes(value: boolean): void {
  const data = getStorageData();
  data.folderShowSizes = value;
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
