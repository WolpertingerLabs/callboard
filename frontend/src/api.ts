import type {
  NotifiableChannel,
  ContactChannelAvailability,
  UserContactAvailability,
  ActivityKind,
  ActivityCondition,
  ChatActivity,
  ConditionWatch,
  ChatActivityResponse,
  SlashCommand,
  PluginCommand,
  PluginManifest,
  Plugin,
  Chat,
  ParsedMessage,
  ChatListResponse,
  ChatTreeAncestor,
  ChatTreeNode,
  ChatTreeResponse,
  FolderSummary,
  FolderListResponse,
  PermissionLevel,
  DefaultPermissions,
  StoredImage,
  ImageUploadResult,
  QueueItem,
  BranchConfig,
  FolderItem,
  BrowseResult,
  ValidateResult,
  FolderSuggestion,
  GitDiffResponse,
  AppPlugin,
  McpServerConfig,
  PluginScanRoot,
  AppPluginsData,
  ScanResult,
  AgentConfig,
  SystemPromptSection,
  SystemMessagePreview,
  CronJob,
  ActivityEntry,
  Trigger,
  TriggerFilter,
  FilterCondition,
  QuietHours,
  AgentSettings,
  KeyAliasInfo,
  EnrolledCaller,
  CustomTheme,
  ThemeListItem,
  ThemeContrastReport,
  ThemeContrastFailure,
  CustomSkill,
  CustomSkillListItem,
  Keyword,
  McpToolDefinition,
  McpToolParameter,
  McpToolServerInfo,
  McpToolsResponse,
  OpenRouterModelInfo,
  OpenRouterModelAliasInfo,
  CodexModelInfo,
  JobDefinition,
  JobStep,
  JobRun,
  JobRunListItem,
  JobRunStatus,
  JobRunHistoryEntry,
  Card,
  CardPatch,
  CardSummary,
  CardRollupState,
  CardPendingKind,
  CardMemberChat,
  CardMemberRun,
  CardListResponse,
  CardResponse,
  Workspace,
  WorkspaceEntry,
  WorkspaceWithRemovability,
  WorkspaceListResponse,
  WorkspaceVerdictListResponse,
  WorkspaceRemovabilityResponse,
  WorkspaceRemovalBlocker,
  WorkspaceCleanliness,
  WorkspaceRefusalReason,
  WorktreeNamingGuess,
  WorkspaceRemovability,
  WorkspaceRemovalReason,
  WorkspaceIgnoredPreview,
  WorkspaceDirectory,
  FolderWorkspaceRecord,
  UnmanagedWorktree,
  UnmanagedWorktreeListing,
  AdoptWorktreesResult,
  ArchiveWorkspaceResult,
  WorktreeDiskUsage,
  TrashEntryView,
  TrashListing,
  TrashRestoreResult,
  EngineStatus,
  EngineStatusResponse,
  EngineRefreshResponse,
  EngineBinaryCheckResponse,
  EngineBinaryOverride,
  EngineOverrideState,
  EngineVersionDrift,
  EngineInstallGuidance,
  EngineInstallRecipe,
  EngineOneClickOffer,
  EngineInstallStartResponse,
  EngineInstallEvent,
  EngineInstallExitEvent,
  EngineInstallVerifiedEvent,
  SelfUpdateCapability,
  SelfUpdateStatusResponse,
  SelfUpdateStartResponse,
  SelfUpdateEvent,
  SelfUpdateVerifiedEvent,
  SelfUpdateRestartingEvent,
} from "shared/types/index.js";

export type {
  NotifiableChannel,
  ContactChannelAvailability,
  UserContactAvailability,
  ActivityKind,
  ActivityCondition,
  ChatActivity,
  ConditionWatch,
  ChatActivityResponse,
  SlashCommand,
  PluginCommand,
  PluginManifest,
  Plugin,
  Chat,
  ParsedMessage,
  ChatListResponse,
  ChatTreeAncestor,
  ChatTreeNode,
  ChatTreeResponse,
  FolderSummary,
  FolderListResponse,
  PermissionLevel,
  DefaultPermissions,
  StoredImage,
  ImageUploadResult,
  QueueItem,
  BranchConfig,
  FolderItem,
  BrowseResult,
  ValidateResult,
  FolderSuggestion,
  GitDiffResponse,
  AppPlugin,
  McpServerConfig,
  PluginScanRoot,
  AppPluginsData,
  ScanResult,
  AgentConfig,
  SystemPromptSection,
  SystemMessagePreview,
  CronJob,
  ActivityEntry,
  Trigger,
  TriggerFilter,
  FilterCondition,
  QuietHours,
  AgentSettings,
  KeyAliasInfo,
  EnrolledCaller,
  CustomTheme,
  ThemeListItem,
  ThemeContrastReport,
  ThemeContrastFailure,
  CustomSkill,
  CustomSkillListItem,
  Keyword,
  McpToolDefinition,
  McpToolParameter,
  McpToolServerInfo,
  McpToolsResponse,
  OpenRouterModelInfo,
  OpenRouterModelAliasInfo,
  CodexModelInfo,
  JobDefinition,
  JobStep,
  JobRun,
  JobRunListItem,
  JobRunStatus,
  JobRunHistoryEntry,
  Card,
  CardPatch,
  CardSummary,
  CardRollupState,
  CardPendingKind,
  CardMemberChat,
  CardMemberRun,
  CardListResponse,
  CardResponse,
  Workspace,
  WorkspaceEntry,
  WorkspaceWithRemovability,
  WorkspaceListResponse,
  WorkspaceVerdictListResponse,
  WorkspaceRemovabilityResponse,
  WorkspaceRemovalBlocker,
  WorkspaceCleanliness,
  WorkspaceRefusalReason,
  WorktreeNamingGuess,
  WorkspaceRemovability,
  WorkspaceRemovalReason,
  WorkspaceIgnoredPreview,
  WorkspaceDirectory,
  FolderWorkspaceRecord,
  UnmanagedWorktree,
  UnmanagedWorktreeListing,
  AdoptWorktreesResult,
  ArchiveWorkspaceResult,
  WorktreeDiskUsage,
  TrashEntryView,
  TrashListing,
  TrashRestoreResult,
  EngineStatus,
  EngineStatusResponse,
  EngineRefreshResponse,
  EngineBinaryCheckResponse,
  EngineBinaryOverride,
  EngineOverrideState,
  EngineVersionDrift,
  EngineInstallGuidance,
  EngineInstallRecipe,
  EngineOneClickOffer,
  EngineInstallStartResponse,
  EngineInstallEvent,
  EngineInstallExitEvent,
  EngineInstallVerifiedEvent,
  SelfUpdateCapability,
  SelfUpdateStatusResponse,
  SelfUpdateStartResponse,
  SelfUpdateEvent,
  SelfUpdateVerifiedEvent,
  SelfUpdateRestartingEvent,
};

export { CARD_CATEGORY_MAX, WORKSPACE_NAME_MAX } from "shared/types/index.js";

/**
 * Capability handshake headers (`X-Callboard-Protocol` / `X-Callboard-Caps`).
 * Re-exported here so callers that hand-roll a `fetch` — the SSE streams in
 * Chat.tsx, which need the raw response body — can spread them in without
 * reaching into `shared/` directly. Omitting them is always safe: the server
 * treats a headerless client as protocol 1 with no capabilities.
 */
export { handshakeHeaders } from "shared/types/index.js";

const BASE = "/api";

/** Shared error handler: throws with the server's error message or a fallback. */
async function assertOk(res: Response, fallback: string): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || fallback);
  }
}

export async function listChats(
  limit?: number,
  offset?: number,
  bookmarked?: boolean,
  excludeTriggered?: boolean,
  cached?: boolean,
  includeLineage?: boolean,
  /**
   * @deprecated Alias of `cardLifecycle: "active"`. Still sent by nothing in
   * this bundle; the parameter stays so an older caller keeps compiling.
   */
  cardsOnly?: boolean,
  /**
   * Scope by the lifecycle of each chat's card: "active" is the open-card
   * trees (what `cardsOnly` meant), "inactive" their complement, "all" no
   * scoping. Omitted when "all", so the default request is byte-identical to
   * what it was.
   */
  cardLifecycle?: "all" | "active" | "inactive",
): Promise<ChatListResponse> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.append("limit", limit.toString());
  if (offset !== undefined) params.append("offset", offset.toString());
  if (bookmarked) params.append("bookmarked", "true");
  if (excludeTriggered) params.append("excludeTriggered", "true");
  if (cached === false) params.append("cached", "false");
  if (includeLineage) params.append("includeLineage", "true");
  if (cardsOnly) params.append("cardsOnly", "true");
  if (cardLifecycle && cardLifecycle !== "all") params.append("cardLifecycle", cardLifecycle);

  const res = await fetch(`${BASE}/chats${params.toString() ? `?${params}` : ""}`);
  await assertOk(res, "Failed to list chats");
  return res.json();
}

/**
 * `signal` is optional and trailing, so existing callers are unaffected. The
 * sidebar passes one because a request whose answer is already superseded
 * should stop occupying the connection rather than run to completion and be
 * thrown away.
 *
 * The server caches this response for 5 s, which is shorter than the sidebar's
 * 15 s poll — so a scheduled poll still costs a full recompute, and aborting a
 * superseded request still saves real work. Nor does an event-driven refresh
 * get a hit: it fires because session or workspace state moved, which is the
 * same movement that invalidates the entry. Assume every request from here
 * costs a recompute; see backend/src/services/folder-list-cache.ts.
 */
export async function listFolders(maxAgeDays?: number, includeDiskUsage?: boolean, signal?: AbortSignal): Promise<FolderListResponse> {
  const params = new URLSearchParams();
  if (maxAgeDays !== undefined) params.append("maxAgeDays", maxAgeDays.toString());
  // Off unless asked: `du` is the slow part and this endpoint is polled.
  if (includeDiskUsage) params.append("includeDiskUsage", "true");
  const res = await fetch(`${BASE}/chats/folders${params.toString() ? `?${params}` : ""}`, { signal });
  await assertOk(res, "Failed to list folders");
  return res.json();
}

export async function getChatTree(id: string): Promise<ChatTreeResponse> {
  const res = await fetch(`${BASE}/chats/${id}/tree`);
  await assertOk(res, "Failed to get chat tree");
  return res.json();
}

export async function searchChatContents(query: string): Promise<{ chatIds: string[] }> {
  const params = new URLSearchParams({ q: query });
  const res = await fetch(`${BASE}/chats/search?${params}`);
  await assertOk(res, "Failed to search chats");
  return res.json();
}

export async function toggleBookmark(id: string, bookmarked: boolean): Promise<Chat> {
  const res = await fetch(`${BASE}/chats/${id}/bookmark`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookmarked }),
  });
  await assertOk(res, "Failed to toggle bookmark");
  return res.json();
}

export async function updateChatPermissions(id: string, permissions: DefaultPermissions): Promise<Chat> {
  const res = await fetch(`${BASE}/chats/${id}/permissions`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultPermissions: permissions }),
  });
  await assertOk(res, "Failed to update chat permissions");
  return res.json();
}

export async function markAsRead(id: string): Promise<Chat> {
  const res = await fetch(`${BASE}/chats/${id}/read`, { method: "PATCH" });
  await assertOk(res, "Failed to mark chat as read");
  return res.json();
}

export async function dismissSummon(id: string): Promise<Chat> {
  const res = await fetch(`${BASE}/chats/${id}/summon`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dismiss: true }),
  });
  await assertOk(res, "Failed to dismiss summon");
  return res.json();
}

// ── Cards (board view) ──────────────────────────────────────────────

export async function listCards(): Promise<CardListResponse> {
  const res = await fetch(`${BASE}/cards`);
  await assertOk(res, "Failed to list cards");
  return res.json();
}

export async function getCard(id: string): Promise<CardResponse> {
  const res = await fetch(`${BASE}/cards/${id}`);
  await assertOk(res, "Failed to get card");
  return res.json();
}

export async function updateCard(id: string, patch: CardPatch): Promise<CardResponse> {
  const res = await fetch(`${BASE}/cards/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await assertOk(res, "Failed to update card");
  return res.json();
}

/**
 * Per-id outcome of a bulk lifecycle change. The endpoint is deliberately
 * partial rather than all-or-nothing: one card failing must not strand the
 * other six, so the caller retries exactly the ids named here.
 */
export interface BulkLifecycleFailure {
  id: string;
  error: string;
}

export interface BulkLifecycleResponse {
  updated: CardSummary[];
  failed: BulkLifecycleFailure[];
}

/** Open or close many cards at once; see BulkLifecycleResponse on partial failure. */
export async function bulkSetCardLifecycle(ids: string[], lifecycle: "open" | "closed"): Promise<BulkLifecycleResponse> {
  const res = await fetch(`${BASE}/cards/bulk-lifecycle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, lifecycle }),
  });
  await assertOk(res, "Failed to update cards");
  return res.json();
}

// No createCard / deleteCard / assignChatToCard: a card IS a lineage root
// chat. It is created by starting a top-level chat, deleted by deleting that
// chat, and joined by being spawned from the tree. Edit card fields with
// updateCard (id = root chat id).

export interface NewChatInfo {
  folder: string;
  displayFolder?: string;
  is_git_repo: boolean;
  is_worktree?: boolean;
  git_branch?: string;
  slash_commands: SlashCommand[];
  plugins: Plugin[];
  appPlugins?: AppPluginsData;
}

export async function getNewChatInfo(folder: string): Promise<NewChatInfo> {
  const res = await fetch(`${BASE}/chats/new/info?folder=${encodeURIComponent(folder)}`);
  await assertOk(res, "Failed to get chat info");
  return res.json();
}

/**
 * The harnesses a conversation can be forked or handed off into.
 *
 * Every `RoutableProviderKind` **except `acp`** — see the fork route's own
 * guard in `routes/chats.ts` for the two independent reasons ACP is excluded
 * (the kind names a wire format rather than a harness, and ACP session state
 * lives inside the agent's process where no client can seed it).
 *
 * `cline` and `pi` were missing until Phase 5 of the pi landing. Both session
 * providers implement `forkSession` and `seedSession`, and both round-trip a
 * real handoff — Callboard had built the capability into two harnesses and
 * offered it into neither.
 */
export type ForkProvider = "claude-code" | "codex" | "cline" | "pi";

/**
 * Fork a chat at a message: creates a new chat whose history is a copy of
 * this one up to and including the message at `timestamp`. The forked chat
 * is not auto-started — the user sends the next message themselves.
 *
 * Passing `provider` hands the conversation to a different harness: the
 * history is translated into that harness's native session format, with tool
 * calls flattened to text summaries. Omitting it forks within the chat's own
 * harness, which preserves the session log verbatim.
 */
export async function forkChat(id: string, timestamp: string, opts?: { provider?: ForkProvider; model?: string }): Promise<Chat> {
  const res = await fetch(`${BASE}/chats/${id}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamp, ...(opts?.provider && { provider: opts.provider }), ...(opts?.model && { model: opts.model }) }),
  });
  await assertOk(res, "Failed to fork chat");
  return res.json();
}

export async function deleteChat(id: string): Promise<void> {
  const res = await fetch(`${BASE}/chats/${id}`, { method: "DELETE" });
  await assertOk(res, "Failed to delete chat");
}

export async function getChat(id: string): Promise<Chat> {
  const res = await fetch(`${BASE}/chats/${id}`);
  await assertOk(res, "Failed to get chat");
  return res.json();
}

export async function getMessages(id: string): Promise<ParsedMessage[]> {
  const res = await fetch(`${BASE}/chats/${id}/messages`);
  await assertOk(res, "Failed to get messages");
  return res.json();
}

export async function getPending(id: string): Promise<any | null> {
  const res = await fetch(`${BASE}/chats/${id}/pending`);
  await assertOk(res, "Failed to get pending action");
  const data = await res.json();
  return data.pending;
}

/**
 * What the chat is currently blocked on: long-running tool calls, any open
 * condition watch, and how many spawned children it is awaiting.
 *
 * Polled on mount and on reconnect rather than pushed, because a countdown is
 * client-side arithmetic — the client needs the deadline, not a tick stream.
 * See the route handler for why this isn't an SSE frame.
 */
export async function getActivity(id: string): Promise<ChatActivityResponse> {
  const res = await fetch(`${BASE}/chats/${id}/activity`);
  await assertOk(res, "Failed to get chat activity");
  return res.json();
}

/**
 * End an interruptible activity (a `wait`) early, so the agent resumes now.
 *
 * Throws on refusal — a 404 here means the wait already elapsed on its own, or
 * the activity represents delegated work that cannot be cut short.
 */
export async function releaseActivity(id: string, activityId: string): Promise<{ ok: boolean; kind: string }> {
  const res = await fetch(`${BASE}/chats/${encodeURIComponent(id)}/activity/${encodeURIComponent(activityId)}/release`, {
    method: "POST",
    credentials: "include",
  });
  await assertOk(res, "Failed to end the wait");
  return res.json();
}

/**
 * Cancel the run behind a chat. The server aborts the session AND terminates
 * the underlying provider request; the run's own SSE stream then delivers a
 * final `message_complete` with reason "aborted" as it unwinds.
 *
 * `id` may be a chat id or, for a chat still being created, the
 * clientTrackingId sent with the first message.
 *
 * Returns `stopped: false` when the server had nothing to cancel (the run
 * already ended, or it's a CLI session the server doesn't control). Throws on
 * transport/HTTP failure so callers can surface "it may still be running"
 * rather than silently pretending the stop landed.
 */
export async function stopChat(id: string): Promise<{ stopped: boolean }> {
  const res = await fetch(`${BASE}/chats/${encodeURIComponent(id)}/stop`, { method: "POST", credentials: "include" });
  if (!res.ok) throw new Error(`Stop failed (${res.status})`);
  return res.json();
}

export async function respondToChat(
  id: string,
  allow: boolean,
  updatedInput?: Record<string, unknown>,
  updatedPermissions?: unknown[],
): Promise<{ ok: boolean; toolName?: string }> {
  const res = await fetch(`${BASE}/chats/${id}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allow, updatedInput, updatedPermissions }),
  });
  if (!res.ok) {
    return { ok: false };
  }
  return res.json();
}

export async function uploadImages(chatId: string, images: File[]): Promise<ImageUploadResult> {
  const formData = new FormData();
  images.forEach((image) => {
    formData.append("images", image);
  });

  const res = await fetch(`${BASE}/chats/${chatId}/images`, {
    method: "POST",
    body: formData,
  });
  await assertOk(res, "Failed to upload images");
  return res.json();
}

/** Upload images without a chat ID (for new chat creation). */
export async function uploadImagesOnly(images: File[]): Promise<ImageUploadResult> {
  const formData = new FormData();
  images.forEach((image) => {
    formData.append("images", image);
  });

  const res = await fetch(`${BASE}/images/upload`, {
    method: "POST",
    body: formData,
  });
  await assertOk(res, "Failed to upload images");
  return res.json();
}

// Draft API functions
export async function getDrafts(chatId?: string): Promise<QueueItem[]> {
  const params = new URLSearchParams();
  if (chatId) params.append("chat_id", chatId);

  const res = await fetch(`${BASE}/queue?${params}`);
  await assertOk(res, "Failed to load drafts");
  return res.json();
}

export async function createDraft(chatId: string | null, message: string, folder?: string, defaultPermissions?: DefaultPermissions): Promise<QueueItem> {
  const res = await fetch(`${BASE}/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      user_message: message,
      ...(folder && { folder }),
      ...(defaultPermissions && { defaultPermissions }),
    }),
  });
  await assertOk(res, "Failed to save draft");
  return res.json();
}

export async function updateDraft(id: string, message: string): Promise<QueueItem> {
  const res = await fetch(`${BASE}/queue/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_message: message }),
  });
  await assertOk(res, "Failed to update draft");
  return res.json();
}

export async function deleteDraft(id: string): Promise<void> {
  const res = await fetch(`${BASE}/queue/${id}`, { method: "DELETE" });
  await assertOk(res, "Failed to delete draft");
}

export async function executeDraft(id: string): Promise<void> {
  const res = await fetch(`${BASE}/queue/${id}/execute-now`, { method: "POST" });
  await assertOk(res, "Failed to execute draft");
}

export async function getSlashCommandsAndPlugins(chatId: string): Promise<{ slashCommands: string[]; plugins: Plugin[]; appPlugins?: AppPluginsData }> {
  const res = await fetch(`${BASE}/chats/${chatId}/slash-commands`);
  await assertOk(res, "Failed to get slash commands");
  const data = await res.json();
  return {
    slashCommands: data.slashCommands || [],
    plugins: data.plugins || [],
    appPlugins: data.appPlugins,
  };
}

export interface SlashCommandContent {
  name: string;
  source: "custom-skill" | "plugin" | "builtin";
  description: string | null;
  content: string | null;
}

/**
 * Where to resolve a command name. A chat supplies its own folder server-side;
 * a composer on `/chat/new` has no chat yet and supplies the folder directly.
 */
export interface SlashCommandScope {
  chatId?: string;
  folder?: string;
  /** Per-directory plugin ids the user has switched on. */
  activePlugins?: string[];
}

/**
 * Bodies are immutable for the life of a tab.
 *
 * A command chip fetches its body the first time its popover is opened, and a
 * user who opens the same popover twice — or re-picks the same command later in
 * the session — should not pay for it twice. The cost of that is a body edited
 * on disk mid-session showing stale until reload, which is the right trade for
 * content that is essentially static.
 *
 * The active-plugin set is part of the key, not just the request: toggling a
 * plugin on changes what resolves, and a cached "no body" from before the
 * toggle would outlive the reason it was true. Nothing negative is cached on
 * *failure* — `assertOk` throws before the write.
 */
const slashCommandContentCache = new Map<string, SlashCommandContent>();

export async function getSlashCommandContent(name: string, scope: SlashCommandScope): Promise<SlashCommandContent> {
  const { chatId, folder, activePlugins = [] } = scope;
  if (!chatId && !folder) throw new Error("Cannot resolve a command without a chat or a folder");

  const key = `${chatId ?? `folder:${folder}`}|${activePlugins.join(",")}|${name}`;
  const cached = slashCommandContentCache.get(key);
  if (cached) return cached;

  const params = new URLSearchParams({ name });
  for (const id of activePlugins) params.append("activePlugins", id);
  let path: string;
  if (chatId) {
    path = `/chats/${encodeURIComponent(chatId)}/slash-commands/content`;
  } else {
    path = "/chats/new/slash-commands/content";
    params.set("folder", folder!);
  }

  const res = await fetch(`${BASE}${path}?${params.toString()}`);
  await assertOk(res, "Failed to get command content");
  const data = (await res.json()) as SlashCommandContent;
  slashCommandContentCache.set(key, data);
  return data;
}

// Branch / worktree configuration
export async function getGitBranches(folder: string): Promise<{ branches: string[] }> {
  const res = await fetch(`${BASE}/git/branches?folder=${encodeURIComponent(folder)}`);
  await assertOk(res, "Failed to list branches");
  return res.json();
}

export async function generateGitBranchName(prompt: string): Promise<{ branchName: string }> {
  const res = await fetch(`${BASE}/git/generate-branch-name`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  await assertOk(res, "Failed to generate branch name");
  return res.json();
}

export async function getGitDiff(folder: string): Promise<GitDiffResponse> {
  const res = await fetch(`${BASE}/git/diff?folder=${encodeURIComponent(folder)}`);
  await assertOk(res, "Failed to get diff");
  return res.json();
}

export async function getGitFileDiff(folder: string, filename: string): Promise<{ diff: string; additions: number; deletions: number }> {
  const params = new URLSearchParams({ folder, filename });
  const res = await fetch(`${BASE}/git/diff/file?${params}`);
  await assertOk(res, "Failed to get file diff");
  return res.json();
}

export function getGitFileRawUrl(folder: string, filename: string): string {
  const params = new URLSearchParams({ folder, filename });
  return `${BASE}/git/diff/file/raw?${params}`;
}

// Folder browsing API functions

export interface SuggestionsResponse {
  suggestions: FolderSuggestion[];
}

export async function browseDirectory(path: string, showHidden: boolean = false, limit: number = 500): Promise<BrowseResult> {
  const params = new URLSearchParams({
    path,
    showHidden: showHidden.toString(),
    limit: limit.toString(),
  });

  const res = await fetch(`${BASE}/folders/browse?${params}`);
  await assertOk(res, "Failed to browse directory");
  return res.json();
}

export async function validatePath(path: string): Promise<ValidateResult> {
  const params = new URLSearchParams({ path });

  const res = await fetch(`${BASE}/folders/validate?${params}`);
  await assertOk(res, "Failed to validate path");
  return res.json();
}

export async function getFolderSuggestions(): Promise<SuggestionsResponse> {
  const res = await fetch(`${BASE}/folders/suggestions`);
  await assertOk(res, "Failed to get folder suggestions");
  return res.json();
}

export async function clearFolderCache(): Promise<void> {
  const res = await fetch(`${BASE}/folders/clear-cache`, { method: "POST" });
  await assertOk(res, "Failed to clear folder cache");
}

// App-wide Plugins & MCP Servers API functions

export async function getAppPlugins(): Promise<AppPluginsData> {
  const res = await fetch(`${BASE}/app-plugins`);
  await assertOk(res, "Failed to get app plugins");
  return res.json();
}

export async function scanForPlugins(directory: string): Promise<ScanResult> {
  const res = await fetch(`${BASE}/app-plugins/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory }),
  });
  await assertOk(res, "Failed to scan for plugins");
  return res.json();
}

export async function rescanPlugins(directory?: string): Promise<AppPluginsData> {
  const res = await fetch(`${BASE}/app-plugins/rescan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory }),
  });
  await assertOk(res, "Failed to rescan plugins");
  return res.json();
}

export async function removeScanRoot(directory: string): Promise<void> {
  const res = await fetch(`${BASE}/app-plugins/scan-root`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory }),
  });
  await assertOk(res, "Failed to remove scan root");
}

export async function toggleAppPlugin(pluginId: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${BASE}/app-plugins/plugins/${encodeURIComponent(pluginId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  await assertOk(res, "Failed to toggle plugin");
}

export async function toggleMcpServer(serverId: string, enabled: boolean): Promise<void> {
  const res = await fetch(`${BASE}/app-plugins/mcp-servers/${encodeURIComponent(serverId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  await assertOk(res, "Failed to toggle MCP server");
}

export async function updateMcpServerEnv(serverId: string, env: Record<string, string>): Promise<void> {
  const res = await fetch(`${BASE}/app-plugins/mcp-servers/${encodeURIComponent(serverId)}/env`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ env }),
  });
  await assertOk(res, "Failed to update MCP server env");
}

// Agent API functions

export async function listAgents(): Promise<AgentConfig[]> {
  const res = await fetch(`${BASE}/agents`, { credentials: "include" });
  await assertOk(res, "Failed to list agents");
  const data = await res.json();
  return data.agents;
}

export async function getAgent(alias: string): Promise<AgentConfig> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}`, { credentials: "include" });
  await assertOk(res, "Failed to get agent");
  const data = await res.json();
  return data.agent;
}

export async function createAgent(agent: {
  name: string;
  alias: string;
  description: string;
  systemPrompt?: string;
  emoji?: string;
  personality?: string;
  role?: string;
  tone?: string;
}): Promise<AgentConfig> {
  const res = await fetch(`${BASE}/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(agent),
  });
  await assertOk(res, "Failed to create agent");
  const data = await res.json();
  return data.agent;
}

export async function updateAgent(alias: string, updates: Partial<AgentConfig>): Promise<AgentConfig> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(updates),
  });
  await assertOk(res, "Failed to update agent");
  const data = await res.json();
  return data.agent;
}

export async function toggleAgent(alias: string, enabled: boolean): Promise<AgentConfig> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/toggle`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ enabled }),
  });
  await assertOk(res, "Failed to toggle agent");
  const data = await res.json();
  return data.agent;
}

export async function deleteAgent(alias: string): Promise<void> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await assertOk(res, "Failed to delete agent");
}

export async function getAgentIdentityPrompt(alias: string): Promise<string> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/identity-prompt`, { credentials: "include" });
  await assertOk(res, "Failed to get agent identity prompt");
  const data = await res.json();
  return data.prompt;
}

export async function getAgentSystemMessagePreview(alias: string): Promise<SystemMessagePreview> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/system-message-preview`, { credentials: "include" });
  await assertOk(res, "Failed to get system message preview");
  return res.json();
}

// Agent export/import API functions

export function getAgentExportUrl(alias: string): string {
  return `${BASE}/agents/${encodeURIComponent(alias)}/export`;
}

export async function importAgent(file: File): Promise<AgentConfig> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${BASE}/agents/import`, {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  await assertOk(res, "Failed to import agent");
  const data = await res.json();
  return data.agent;
}

// Agent workspace file API functions

export async function getWorkspaceFiles(alias: string): Promise<string[]> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/workspace`, { credentials: "include" });
  await assertOk(res, "Failed to list workspace files");
  const data = await res.json();
  return data.files;
}

export async function getWorkspaceFile(alias: string, filename: string): Promise<string> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/workspace/${encodeURIComponent(filename)}`, { credentials: "include" });
  await assertOk(res, "Failed to read workspace file");
  const data = await res.json();
  return data.content;
}

export async function updateWorkspaceFile(alias: string, filename: string, content: string): Promise<void> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/workspace/${encodeURIComponent(filename)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ content }),
  });
  await assertOk(res, "Failed to update workspace file");
}

// Agent memory API functions

export async function getAgentMemory(alias: string): Promise<{ curatedMemory: string; dailyFiles: string[] }> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/memory`, { credentials: "include" });
  await assertOk(res, "Failed to get agent memory");
  return res.json();
}

export async function getAgentDailyMemory(alias: string, date: string): Promise<string> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/memory/${encodeURIComponent(date)}`, { credentials: "include" });
  await assertOk(res, "Failed to get daily memory");
  const data = await res.json();
  return data.content;
}

// Agent cron jobs API functions

export async function getAgentCronJobs(alias: string): Promise<CronJob[]> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/cron-jobs`, { credentials: "include" });
  await assertOk(res, "Failed to list cron jobs");
  const data = await res.json();
  return data.jobs;
}

export async function createAgentCronJob(alias: string, job: Omit<CronJob, "id">): Promise<CronJob> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/cron-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(job),
  });
  await assertOk(res, "Failed to create cron job");
  const data = await res.json();
  return data.job;
}

export async function updateAgentCronJob(alias: string, jobId: string, updates: Partial<CronJob>): Promise<CronJob> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/cron-jobs/${encodeURIComponent(jobId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(updates),
  });
  await assertOk(res, "Failed to update cron job");
  const data = await res.json();
  return data.job;
}

export async function deleteAgentCronJob(alias: string, jobId: string): Promise<void> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/cron-jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await assertOk(res, "Failed to delete cron job");
}

export async function runAgentCronJob(alias: string, jobId: string): Promise<CronJob> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/cron-jobs/${encodeURIComponent(jobId)}/run`, {
    method: "POST",
    credentials: "include",
  });
  await assertOk(res, "Failed to run cron job");
  const data = await res.json();
  return data.job;
}

// Agent trigger API functions

export interface BacktestResult {
  totalScanned: number;
  matchCount: number;
  matches: StoredEvent[];
}

export async function getAgentTriggers(alias: string): Promise<Trigger[]> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/triggers`, { credentials: "include" });
  await assertOk(res, "Failed to list triggers");
  const data = await res.json();
  return data.triggers;
}

export async function createAgentTrigger(alias: string, trigger: Omit<Trigger, "id">): Promise<Trigger> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/triggers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(trigger),
  });
  await assertOk(res, "Failed to create trigger");
  const data = await res.json();
  return data.trigger;
}

export async function updateAgentTrigger(alias: string, triggerId: string, updates: Partial<Trigger>): Promise<Trigger> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/triggers/${encodeURIComponent(triggerId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(updates),
  });
  await assertOk(res, "Failed to update trigger");
  const data = await res.json();
  return data.trigger;
}

export async function deleteAgentTrigger(alias: string, triggerId: string): Promise<void> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/triggers/${encodeURIComponent(triggerId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await assertOk(res, "Failed to delete trigger");
}

export async function backtestTriggerFilter(alias: string, filter: TriggerFilter, limit?: number): Promise<BacktestResult> {
  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/triggers/backtest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ filter, limit }),
  });
  await assertOk(res, "Failed to backtest filter");
  return res.json();
}

// Proxy API functions (read-only)

export interface ProxyRoute {
  index: number;
  name?: string;
  description?: string;
  docsUrl?: string;
  openApiUrl?: string;
  allowedEndpoints: string[];
  secretNames: string[];
  autoHeaders: string[];
}

export interface IngestorStatus {
  connection: string;
  instanceId?: string;
  type: "websocket" | "webhook" | "poll";
  state: string;
  bufferedEvents: number;
  totalEventsReceived: number;
  lastEventAt: string | null;
  error?: string;
}

export async function getProxyRoutes(alias?: string): Promise<{ routes: ProxyRoute[]; configured: boolean }> {
  const params = alias ? `?alias=${encodeURIComponent(alias)}` : "";
  const res = await fetch(`${BASE}/proxy/routes${params}`, { credentials: "include" });
  await assertOk(res, "Failed to get proxy routes");
  return res.json();
}

export async function getProxyIngestors(alias?: string): Promise<{ ingestors: IngestorStatus[]; configured: boolean }> {
  const params = alias ? `?alias=${encodeURIComponent(alias)}` : "";
  const res = await fetch(`${BASE}/proxy/ingestors${params}`, { credentials: "include" });
  await assertOk(res, "Failed to get ingestor status");
  return res.json();
}

// Stored event log types

export interface StoredEvent {
  id: number;
  idempotencyKey?: string;
  receivedAt: string;
  receivedAtMs?: number;
  callerAlias: string;
  source: string;
  /** Instance ID for multi-instance listeners (e.g. "project-board") */
  instanceId?: string;
  eventType: string;
  data: unknown;
  storedAt: number;
}

export async function getProxyEvents(caller: string, limit?: number, offset?: number): Promise<{ events: StoredEvent[]; sources: string[] }> {
  const params = new URLSearchParams();
  params.append("caller", caller);
  if (limit !== undefined) params.append("limit", limit.toString());
  if (offset !== undefined) params.append("offset", offset.toString());

  const res = await fetch(`${BASE}/proxy/events?${params}`, { credentials: "include" });
  await assertOk(res, "Failed to get proxy events");
  return res.json();
}

export async function getProxyEventsBySource(caller: string, source: string, limit?: number, offset?: number): Promise<{ events: StoredEvent[] }> {
  const params = new URLSearchParams();
  params.append("caller", caller);
  if (limit !== undefined) params.append("limit", limit.toString());
  if (offset !== undefined) params.append("offset", offset.toString());

  const res = await fetch(`${BASE}/proxy/events/${encodeURIComponent(source)}?${params}`, { credentials: "include" });
  await assertOk(res, "Failed to get proxy events for source");
  return res.json();
}

// Agent settings API functions

export async function getAgentSettings(): Promise<AgentSettings> {
  const res = await fetch(`${BASE}/agent-settings`, { credentials: "include" });
  await assertOk(res, "Failed to get agent settings");
  return res.json();
}

export async function updateAgentSettings(settings: Partial<AgentSettings>): Promise<AgentSettings> {
  const res = await fetch(`${BASE}/agent-settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(settings),
  });
  await assertOk(res, "Failed to update agent settings");
  return res.json();
}

export interface RemoteAccessStatus {
  enabled: boolean;
  mode: "quick" | "named";
  available: boolean | null;
  status: "down" | "starting" | "up" | "error";
  url: string | null;
  error: string | null;
  /** The requesting client's resolved IP (real remote IP behind the tunnel) — used by the allowlist UI. */
  callerIp?: string;
}

/** Current status of the remote-access (public cloudflared) tunnel. */
export async function getRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  const res = await fetch(`${BASE}/agent-settings/remote-access-status`, { credentials: "include" });
  await assertOk(res, "Failed to get remote-access status");
  return res.json();
}

export async function getKeyAliases(proxyMode?: "local" | "remote"): Promise<KeyAliasInfo[]> {
  const params = proxyMode ? `?proxyMode=${proxyMode}` : "";
  const res = await fetch(`${BASE}/agent-settings/key-aliases${params}`, { credentials: "include" });
  await assertOk(res, "Failed to get key aliases");
  const data = await res.json();
  return data.aliases;
}

export interface ConnectionTestResult {
  status: "unreachable" | "handshake_failed" | "connected";
  message: string;
  routeCount?: number;
}

export async function testProxyConnection(url: string, alias?: string): Promise<ConnectionTestResult> {
  const res = await fetch(`${BASE}/agent-settings/test-connection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ url, alias }),
  });
  await assertOk(res, "Failed to test connection");
  return res.json();
}

// Drawlatch daemon status

export interface DaemonStatus {
  mode: "local" | "remote";
  url: string | null;
  managed: boolean;
  reachable: boolean;
  health: {
    status: string;
    activeSessions?: number;
    uptime?: number;
    tunnelUrl?: string;
  } | null;
  pid?: number;
  dashboardUrl: string | null;
  enrolledAliases: string[];
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
  const res = await fetch(`${BASE}/agent-settings/daemon-status`, { credentials: "include" });
  await assertOk(res, "Failed to get daemon status");
  return res.json();
}

// Enrolled caller management (Proxy Settings panel)

export async function getEnrolledCallers(proxyMode?: "local" | "remote"): Promise<EnrolledCaller[]> {
  const params = proxyMode ? `?proxyMode=${proxyMode}` : "";
  const res = await fetch(`${BASE}/agent-settings/callers${params}`, { credentials: "include" });
  await assertOk(res, "Failed to list enrolled callers");
  const data = await res.json();
  return data.callers;
}

/**
 * Set (or clear) the default enrolled caller for regular (non-agent) sessions.
 * Pass a caller alias to make it the default, or `null` to clear it so regular
 * sessions have no MCP-proxy access. Mode defaults to the active proxy mode.
 */
export async function setDefaultCaller(alias: string | null, proxyMode?: "local" | "remote"): Promise<void> {
  const params = proxyMode ? `?proxyMode=${proxyMode}` : "";
  const res = await fetch(`${BASE}/agent-settings/default-caller${params}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ alias }),
  });
  await assertOk(res, "Failed to set default caller");
}

/**
 * Delete an enrolled caller. Rejects with the server's message when the caller
 * is still bound to agents (HTTP 409) — deletion requires zero associated agents.
 */
export async function deleteEnrolledCaller(alias: string, proxyMode?: "local" | "remote"): Promise<void> {
  const params = proxyMode ? `?proxyMode=${proxyMode}` : "";
  const res = await fetch(`${BASE}/agent-settings/callers/${encodeURIComponent(alias)}${params}`, {
    method: "DELETE",
    credentials: "include",
  });
  await assertOk(res, "Failed to delete enrolled caller");
}

// Caller credential bundle import (remote mode)

/**
 * Parsed view of a `{alias}.drawlatch-caller.json` bundle — only the plaintext,
 * user-facing fields the import UI needs to show for confirmation. The private
 * keys (possibly passphrase-wrapped) are passed through to the backend verbatim
 * inside `raw` and never inspected client-side.
 */
export interface ParsedCallerBundle {
  version: number;
  callerAlias: string;
  fingerprint: string;
  endpointUrl: string;
  serverKeyFingerprint: string;
  /** Non-null when the private keys are passphrase-wrapped. */
  encryption: unknown;
  /** The original parsed JSON, forwarded to the backend on confirm. */
  raw: unknown;
}

export interface ImportBundleResult {
  alias: string;
  fingerprint: string;
  serverKeyFingerprint: string;
  endpointUrl: string;
  aliases: KeyAliasInfo[];
}

export async function importCallerBundle(bundle: unknown, passphrase?: string): Promise<ImportBundleResult> {
  const res = await fetch(`${BASE}/agent-settings/import-bundle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ bundle, ...(passphrase ? { passphrase } : {}) }),
  });
  await assertOk(res, "Failed to import caller bundle");
  return res.json();
}

// Agent activity API functions

export async function getAgentActivity(alias: string, type?: string, limit?: number, offset?: number): Promise<ActivityEntry[]> {
  const params = new URLSearchParams();
  if (type) params.append("type", type);
  if (limit !== undefined) params.append("limit", limit.toString());
  if (offset !== undefined) params.append("offset", offset.toString());

  const res = await fetch(`${BASE}/agents/${encodeURIComponent(alias)}/activity${params.toString() ? `?${params}` : ""}`, { credentials: "include" });
  await assertOk(res, "Failed to get agent activity");
  const data = await res.json();
  return data.entries;
}

// Password change API

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const res = await fetch(`${BASE}/auth/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  await assertOk(res, "Failed to change password");
}

// API keys (bearer tokens for external integrations)

export interface ApiKeyInfo {
  id: string;
  name: string;
  description: string;
  tokenPreview: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
}

export async function listApiKeys(): Promise<ApiKeyInfo[]> {
  const res = await fetch(`${BASE}/api-keys`, { credentials: "include" });
  await assertOk(res, "Failed to load API keys");
  const data = await res.json();
  return data.keys;
}

export async function createApiKey(name: string, description: string, expiresAt: number | null): Promise<{ key: ApiKeyInfo; token: string }> {
  const res = await fetch(`${BASE}/api-keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name, description, expiresAt }),
  });
  await assertOk(res, "Failed to create API key");
  return res.json();
}

export async function deleteApiKey(id: string): Promise<void> {
  const res = await fetch(`${BASE}/api-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await assertOk(res, "Failed to revoke API key");
}

// Claude Code auth status API

/**
 * Whether Claude Code can authenticate on the server — **not** whether the CLI
 * is logged in.
 *
 * `loggedIn` keeps its name for older bundles, but the backend now answers it
 * from every credential a chat could use: an API key or auth token configured
 * in Settings, OpenRouter routing, a third-party provider, or a
 * `claude auth login`. It used to shell out to `claude auth status` alone,
 * which knows nothing about Callboard's settings, so an API-key user was shown
 * the login modal on every page load forever.
 */
export interface ClaudeAuthStatus {
  /** False means no credential of any kind was found — the only state that needs the modal. */
  loggedIn: boolean;
  email?: string;
  /** Where the credential came from, e.g. "API key (ANTHROPIC_API_KEY)", "claude.ai", "openrouter". */
  authMethod?: string;
  subscriptionType?: string;
  /** Extra context for the source, when there is any. */
  note?: string;
  /**
   * The native `claude` the server resolved, when it has one.
   *
   * Absent means `claude auth login` is not a command this machine can run, so
   * the modal must not tell anyone to run it.
   */
  cliPath?: string;
  error?: string;
}

export async function checkClaudeStatus(): Promise<ClaudeAuthStatus> {
  const res = await fetch(`${BASE}/auth/claude-status`, { credentials: "include" });
  await assertOk(res, "Failed to check Claude status");
  return res.json();
}

// System info API

export interface SystemInfoAccount {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
}

export interface SystemInfoModel {
  value: string;
  displayName: string;
  description: string;
}

export interface SystemInfo {
  version: string;
  latestVersion?: string;
  nodeVersion: string;
  platform: string;
  sdkVersion: string;
  claudeCliVersion: string;
  proxyMode?: string;
  environment: string;
  account?: SystemInfoAccount;
  models?: SystemInfoModel[];
  /** True when the native Claude Code harness is routed through OpenRouter (toggle on + key set). */
  claudeCodeUseOpenRouter?: boolean;
  /** True when the native Codex harness is routed through OpenRouter (toggle on + key set). */
  codexUseOpenRouter?: boolean;
  /** True when the ambient env already points Claude Code at OpenRouter (ANTHROPIC_BASE_URL). Defaults the toggle on. */
  claudeCodeOpenRouterDetected?: boolean;
  /** True when the ambient env already points Codex at OpenRouter (OPENAI base / config.toml). Defaults the toggle on. */
  codexOpenRouterDetected?: boolean;
  /**
   * True when the Codex provider has usable credentials — an `OPENAI_API_KEY`
   * in Settings → API (api-key mode), a parseable `$CODEX_HOME/auth.json` from
   * `codex login` (subscription mode), or a `$CODEX_HOME/config.toml`
   * declaring a `model_provider` (manual setup).
   */
  codexConfigured?: boolean;
  /**
   * Which credential source backed `codexConfigured`. Lets the UI label the
   * status accurately ("auth.json", "config.toml", api key, or unconfigured).
   */
  codexAuthSource?: "api-key" | "auth.json" | "config.toml" | null;
  /**
   * Configured ACP vendors and whether each one's CLI is installed.
   *
   * `available` means the binary resolves on PATH — **not** that the user is
   * authenticated. ACP has no auth introspection, so an unauthenticated vendor
   * reports available and fails at send time with the CLI's own message. Absent
   * on servers older than the ACP picker; treat that as "no ACP vendors".
   */
  acpProviders?: AcpProviderInfo[];
  /**
   * Which Cline provider new chats run on, from Settings → API.
   *
   * The model picker needs it to know which catalog to offer — Cline's list is
   * per-provider, so selecting `openrouter` here is what surfaces OpenRouter's
   * models in the picker. There is no `clineConfigured` companion: the SDK is
   * embedded and falls back to the backend's own environment credentials, so
   * there is no state in which the provider could honestly be disabled.
   */
  clineProviderId?: string;
}

/**
 * Per-engine runtime / version / credential status.
 *
 * A separate call from {@link getSystemInfo} on purpose: system-info is polled
 * by several pages and its `acpProviders` / `codexConfigured` / `codexAuthSource`
 * fields are read by older bundles, so engine status — which hits the npm
 * registry — got its own route rather than growing that payload.
 *
 * Best-effort by contract: an offline daemon answers 200 with `latestVersion`
 * omitted, so a failure here means the request itself failed.
 */
export async function getEngines(refresh = false): Promise<EngineStatus[]> {
  const res = await fetch(`${BASE}/engines${refresh ? "?refresh=1" : ""}`, { credentials: "include" });
  await assertOk(res, "Failed to get engine status");
  const data = (await res.json()) as EngineStatusResponse;
  return Array.isArray(data.engines) ? data.engines : [];
}

/**
 * "Would Callboard accept this path as a binary override?", for the two
 * override fields in Settings → API.
 *
 * Asks the daemon rather than guessing in the browser, for the obvious reason
 * and a less obvious one: the path is on the *daemon's* filesystem, which a
 * remote tab cannot see at all, and the check that matters is the one the
 * resolver applies at chat time — existence, file-ness, and an execute bit for
 * the daemon's own user. A browser could not evaluate any of the three.
 *
 * Runs nothing on the far side; see the route's doc-comment. Callers debounce.
 */
export async function checkEngineBinary(path: string, engineId: string, signal?: AbortSignal): Promise<EngineBinaryCheckResponse> {
  const query = new URLSearchParams({ path, engineId });
  const res = await fetch(`${BASE}/engines/binary-check?${query.toString()}`, { credentials: "include", signal });
  await assertOk(res, "Failed to check the binary path");
  const data = (await res.json()) as EngineBinaryCheckResponse;
  return { path: String(data.path ?? ""), state: data.state ?? null, detail: String(data.detail ?? "") };
}

/**
 * Re-probe every engine after installing something — the "Recheck" button.
 *
 * Distinct from `getEngines(true)`, which only bypasses the npm-registry cache.
 * The daemon memoizes where each binary resolved for its whole lifetime, so a
 * user who has just installed `opencode` and re-fetches is told again that it is
 * missing. This drops those caches server-side first, which is why it is a POST.
 *
 * Answers `probed: false` when the call was coalesced with a concurrent one or
 * fell inside the server's minimum interval — the endpoint spawns processes
 * synchronously, so it is rate-limited. Callers must not report a `probed:
 * false` result as a fresh check.
 */
export async function refreshEngines(): Promise<EngineRefreshResponse> {
  const res = await fetch(`${BASE}/engines/refresh`, { method: "POST", credentials: "include" });
  await assertOk(res, "Failed to re-check engine status");
  const data = (await res.json()) as EngineRefreshResponse;
  return { engines: Array.isArray(data.engines) ? data.engines : [], probed: data.probed !== false, retryAfterMs: data.retryAfterMs };
}

/**
 * Ask the daemon to run an engine's install recipe on its own machine.
 *
 * The only call in this file that makes Callboard execute a command. The engine
 * id **selects** a recipe from a closed registry server-side; nothing sent from
 * here reaches a command line, and there is no argv parameter to supply.
 *
 * A refusal is a normal outcome, not an exception in spirit — every gate that
 * can decline (a client outside the LAN, the capability switched off, Windows, a
 * non-writable npm prefix, another install already running) answers with a
 * one-line `refusal` written for the card, which keeps rendering the
 * copy-and-paste command either way. It still *throws*, because `assertOk`'s
 * contract is that a non-2xx is an error; the message is that sentence.
 */
export async function startEngineInstall(engineId: string): Promise<EngineInstallStartResponse> {
  const res = await fetch(`${BASE}/engines/${encodeURIComponent(engineId)}/install`, { method: "POST", credentials: "include" });
  await assertOk(res, "Failed to start the install");
  return (await res.json()) as EngineInstallStartResponse;
}

/**
 * Follow one install's output to its verdict.
 *
 * Reads the SSE stream with `fetch` rather than `EventSource` for the reason
 * `Chat.tsx` does: an abortable request that shares the app's `credentials:
 * "include"` handling, instead of a second connection type with its own
 * reconnection behaviour. The server replays the whole transcript on connect, so
 * a late subscriber loses nothing and a reconnect is not a special case.
 *
 * Resolves when the server closes the stream — which it does on the terminal
 * event, so the caller does not have to decide what "finished" means. It never
 * throws for an unhappy install: a non-zero exit is an `install_exit` event with
 * `ok: false`, and an install that npm completed but the daemon cannot see is an
 * `install_verified` with `visible: false`. Both are data, not errors.
 */
export async function readEngineInstallStream(installId: string, onEvent: (event: EngineInstallEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}/engines/installs/${encodeURIComponent(installId)}/stream`, { credentials: "include", signal });
  if (res.status === 404) {
    // Tagged, because the caller has to tell "this install no longer exists"
    // (forget it) from "the connection broke" (it may still be running, keep
    // the pointer so a reload can reattach). Collapsing the two is how a
    // reconnect deletes the thing it exists to reconnect to.
    throw Object.assign(new Error("That install is no longer available."), { installGone: true });
  }
  await assertOk(res, "Failed to follow the install");
  if (!res.body) throw new Error("The install stream returned no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue; // heartbeats are `:` comments
        try {
          onEvent(JSON.parse(line.slice(6)) as EngineInstallEvent);
        } catch {
          // A frame this bundle cannot parse is skipped rather than fatal — the
          // transcript is prose, and losing one line of it must not lose the
          // verdict that comes after.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Self-update ─────────────────────────────────────────────────────

/**
 * May this daemon install its own update here, and what would it run?
 *
 * Asked once by Settings → About, and only when it has already decided a newer
 * version exists — this is not on a polling path. The response carries the
 * copy-and-paste command in *every* case, refusals included, because that
 * command is what the feature degrades to and a UI that hid it would have taken
 * away the only remaining action.
 */
export async function getSelfUpdateStatus(): Promise<SelfUpdateStatusResponse> {
  const res = await fetch(`${BASE}/self-update`, { credentials: "include" });
  await assertOk(res, "Failed to check whether Callboard can update itself");
  return (await res.json()) as SelfUpdateStatusResponse;
}

/**
 * Ask the daemon to install its own latest version and restart into it.
 *
 * Nothing sent from here reaches a command line: the package name comes from the
 * daemon's own manifest, there is no body, and there is no argv parameter to
 * supply. A refusal is a normal outcome — outside the LAN, the capability
 * switched off, a git checkout rather than the global install — and it still
 * *throws*, because `assertOk`'s contract is that a non-2xx is an error; the
 * message is the server's one-line sentence.
 */
export async function startSelfUpdate(): Promise<SelfUpdateStartResponse> {
  const res = await fetch(`${BASE}/self-update`, { method: "POST", credentials: "include" });
  await assertOk(res, "Failed to start the update");
  return (await res.json()) as SelfUpdateStartResponse;
}

/**
 * Follow one update's output up to the point where the daemon stops answering.
 *
 * Reads the SSE stream with `fetch` for the same reason
 * {@link readEngineInstallStream} does. The difference is what "finished" means:
 * a *successful* update ends with the server being killed, so this promise
 * resolving — or rejecting with a network error — after an `update_restarting`
 * event is the expected path, not a failure. The caller stops here and starts
 * polling for the daemon to come back; there is no frame that can tell it the
 * new process is up, because the process that would send it is gone.
 */
export async function readSelfUpdateStream(updateId: string, onEvent: (event: SelfUpdateEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch(`${BASE}/self-update/runs/${encodeURIComponent(updateId)}/stream`, { credentials: "include", signal });
  if (res.status === 404) {
    // Tagged like the install stream's, and with an extra reading available
    // here: a 404 for an update this tab just started most likely means the
    // update worked and this is a *different daemon* that never heard of it.
    throw Object.assign(new Error("That update is no longer available."), { updateGone: true });
  }
  await assertOk(res, "Failed to follow the update");
  if (!res.body) throw new Error("The update stream returned no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue; // heartbeats are `:` comments
        try {
          onEvent(JSON.parse(line.slice(6)) as SelfUpdateEvent);
        } catch {
          // A frame this bundle cannot parse is skipped rather than fatal.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Is the daemon answering again, and on which version?
 *
 * The success signal for an update, and it has to be a *fresh* request rather
 * than {@link getSystemInfo}: that one is served stale-while-revalidate from a
 * module-level cache, so it would answer "yes, still running the old version"
 * instantly and forever. This bypasses the cache entirely and returns undefined
 * for every way a restarting daemon can fail to answer — connection refused
 * mid-restart is the *expected* case here, not an error to report.
 */
export async function probeDaemonVersion(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(`${BASE}/system-info`, { credentials: "include", signal });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === "string" && data.version.length > 0 ? data.version : undefined;
  } catch {
    return undefined;
  }
}

/** The models callboard has seen an ACP vendor advertise. */
export interface AcpModelCatalogInfo {
  providerId: string;
  models: { value: string; displayName: string; description: string }[];
  /** ISO timestamp of the session that produced the list; "" when never seen. */
  discoveredAt: string;
  /** The model that session was running on, when the vendor reported one. */
  currentValue?: string;
}

/**
 * Models known for an ACP vendor.
 *
 * Harvested from previous chats rather than probed — a promptless ACP session
 * persists in the vendor's own store — so a vendor that has never run reports an
 * empty list. That is not an error, and the model field takes free text anyway.
 */
export async function getAcpModels(providerId: string): Promise<AcpModelCatalogInfo> {
  const res = await fetch(`${BASE}/acp/models?providerId=${encodeURIComponent(providerId)}`, { credentials: "include" });
  await assertOk(res, "Failed to get ACP models");
  return res.json();
}

/** One model the configured Cline provider will route to. */
export interface ClineModelInfo {
  value: string;
  displayName: string;
  description: string;
}

/**
 * Provider ids the embedded Cline runtime supports.
 *
 * Read from the SDK by the backend rather than from a table, so this stays
 * correct across SDK bumps without a frontend change.
 */
export async function getClineProviders(): Promise<{ providers: string[] }> {
  const res = await fetch(`${BASE}/cline/providers`, { credentials: "include" });
  await assertOk(res, "Failed to get Cline providers");
  return res.json();
}

/**
 * Models for one Cline provider.
 *
 * An empty list means the provider could not be reached, not that it has no
 * models — every model field accepts free text, so the picker degrades to an
 * input rather than blocking.
 */
export async function getClineModels(providerId: string): Promise<{ providerId: string; models: ClineModelInfo[] }> {
  const res = await fetch(`${BASE}/cline/models?providerId=${encodeURIComponent(providerId)}`, { credentials: "include" });
  await assertOk(res, "Failed to get Cline models");
  return res.json();
}

/** One model the configured pi provider will route to. */
export interface PiModelInfo {
  value: string;
  displayName: string;
  description: string;
}

/**
 * Provider ids the embedded pi runtime ships a model catalog for.
 *
 * Answered offline from a catalog bundled inside the package, so this is
 * populated before any key is entered — unlike the Cline equivalent, which can
 * need the network for some providers.
 */
export async function getPiProviders(): Promise<{ providers: string[] }> {
  const res = await fetch(`${BASE}/pi/providers`, { credentials: "include" });
  await assertOk(res, "Failed to get pi providers");
  return res.json();
}

/**
 * Models for one pi provider.
 *
 * Large: OpenRouter alone answers with ~300 entries, which is why
 * {@link PiModelSelector} filters rather than listing. An empty list means the
 * catalog could not be read, not that the provider has no models — every model
 * field accepts free text, so the picker degrades to an input rather than
 * blocking.
 */
export async function getPiModels(providerId: string): Promise<{ providerId: string; models: PiModelInfo[] }> {
  const res = await fetch(`${BASE}/pi/models?providerId=${encodeURIComponent(providerId)}`, { credentials: "include" });
  await assertOk(res, "Failed to get pi models");
  return res.json();
}

export interface AcpProviderInfo {
  id: string;
  label: string;
  available: boolean;
  /** The binary probed, so a disabled entry can say what to install. */
  command: string;
}

/**
 * The last `/api/system-info` payload this tab saw, or `null` before the first.
 *
 * Module-level rather than per-caller because the point is to share it across
 * *mounts*: `NewChatPanel` is conditionally rendered, so it remounts on every
 * popup open and would otherwise start from an empty ACP vendor list every
 * single time. `ClaudeModelSelector` had already reached for a private
 * `cachedModels` of its own for the same reason; this is that idea moved to
 * where every caller can use it.
 */
let systemInfoCache: SystemInfo | null = null;

/** One in-flight request, so N callers in one frame share a round trip rather than racing N. */
let systemInfoInFlight: Promise<SystemInfo> | null = null;

/**
 * The cached payload **synchronously**, without touching the network.
 *
 * This is the accessor that actually kills the pop-in, and it exists because a
 * promise cannot: `useEffect` runs *after* the browser has painted, so even a
 * cache hit that resolves in a microtask is one frame too late — the row would
 * still render without the OpenCode button and then reflow. A component seeds
 * its initial state from this instead, and paints the button on frame one.
 *
 * `null` means "this tab has never had an answer", which is not the same as
 * "there are no ACP vendors" — callers must keep their existing empty-state
 * behaviour for it rather than treating it as data.
 */
export function cachedSystemInfo(): SystemInfo | null {
  return systemInfoCache;
}

export interface SystemInfoOptions {
  /**
   * Skip the cache and resolve with a fresh response.
   *
   * For the callers that have just *changed* something the payload reports —
   * Settings → API after a save, after a Recheck, after an install. Handing
   * those the previous answer would show the user the state they just left, and
   * the stale-while-revalidate default would do exactly that: it resolves with
   * the old value and updates the cache for whoever comes next, which is the
   * wrong trade when the point of the call is to observe a mutation.
   */
  refresh?: boolean;
}

/**
 * System info, served stale-while-revalidate.
 *
 * A cache hit resolves immediately and kicks off a background refresh whose
 * result lands in the cache for the next caller. That is the right default here
 * because every field is a property of the *daemon* — versions, credentials,
 * which CLIs are installed — none of which changes as a result of anything the
 * page does, except on the pages that pass `refresh`.
 *
 * The revalidation is deliberately not surfaced to the caller: a call resolves
 * once, with one payload. A caller handed a stale value and then a fresh one
 * would have to survive its own state changing underneath it a few hundred
 * milliseconds after mount, and `NewChatPanel` reacts to this payload by
 * *downgrading the selected provider* — a decision that must be made once,
 * against one list, or it can overrule a choice the user made in between.
 *
 * The consequence, and it is the trap: **a caller that needs a fresh answer must
 * ask for one.** Serving stale is not "fresh, slightly late" — the revalidation
 * lands in the cache, not in the caller, so a component that takes the default
 * is pinned to whatever this tab last saw for its entire lifetime. That is right
 * for a display of daemon facts and wrong for anything that *gates* on them, so
 * {@link cachedSystemInfo} is what makes a first frame instant and `refresh` is
 * what makes an answer current. They are separate tools and most seeding callers
 * want both.
 */
export async function getSystemInfo(opts: SystemInfoOptions = {}): Promise<SystemInfo> {
  if (systemInfoCache && !opts.refresh) {
    // Fire-and-forget: the caller has its answer, and a revalidation that fails
    // must not become an unhandled rejection or evict a good cached value.
    void revalidateSystemInfo().catch(() => {});
    return systemInfoCache;
  }
  // A `refresh` deliberately does **not** join an in-flight request. That
  // request may have been issued before the save/install this call exists to
  // observe, and a response is only as fresh as the moment it left — joining one
  // would hand back pre-mutation data through the very parameter that asked not
  // to get any.
  return opts.refresh ? fetchSystemInfo() : revalidateSystemInfo();
}

function revalidateSystemInfo(): Promise<SystemInfo> {
  return systemInfoInFlight ?? fetchSystemInfo();
}

/** Ticket dispenser: every request takes the next number, in start order. */
let systemInfoRequestSeq = 0;

/**
 * The highest-numbered request whose response actually reached the cache.
 *
 * Because a `refresh` runs alongside an in-flight revalidation, two responses
 * can be outstanding, and the network does not promise they land in order — so a
 * response writes only if no *later*-started one has already written. Without
 * that, a slow revalidation settling after a fast post-save refresh would put
 * the pre-save payload back and hand it to every later caller.
 *
 * Gating on "did anyone newer already write" rather than on "am I the newest
 * request that started" is the difference between dropping a stale answer and
 * dropping a *good* one. Under the latter, a newer request that **failed** still
 * held the gate shut: press Recheck twice, let the second 500 and the first
 * succeed, and the fresh payload was discarded while the page itself displayed
 * it — leaving the module cache holding the pre-install answer, so the next New
 * Chat popup contradicted the engine card the user was looking at. A request
 * that produced nothing must not out-rank one that produced an answer, and here
 * it cannot: failing never advances this.
 */
let systemInfoLatestWritten = 0;

function fetchSystemInfo(): Promise<SystemInfo> {
  const seq = ++systemInfoRequestSeq;
  const request = (async () => {
    const res = await fetch(`${BASE}/system-info`, { credentials: "include" });
    await assertOk(res, "Failed to get system info");
    const info = (await res.json()) as SystemInfo;
    if (seq > systemInfoLatestWritten) {
      systemInfoLatestWritten = seq;
      systemInfoCache = info;
    }
    return info;
  })().finally(() => {
    if (systemInfoInFlight === request) systemInfoInFlight = null;
  });
  systemInfoInFlight = request;
  return request;
}

/**
 * Test seam: forget the cached payload and any in-flight request.
 *
 * Deliberately does **not** reset the two counters. They are monotonic and only
 * ever compared to each other, so leaving them alone costs nothing — while
 * zeroing them would recreate the exact leak they exist to prevent: a request
 * issued before the reset would find itself newer than the fresh watermark and
 * write its pre-reset payload into the cache that just replaced it.
 */
export function resetSystemInfoCache(): void {
  systemInfoCache = null;
  systemInfoInFlight = null;
}

export async function getOpenRouterModels(): Promise<OpenRouterModelInfo[]> {
  const res = await fetch(`${BASE}/openrouter/models`, { credentials: "include" });
  await assertOk(res, "Failed to get OpenRouter models");
  const data = await res.json();
  return Array.isArray(data.models) ? data.models : [];
}

export async function getCodexModels(): Promise<CodexModelInfo[]> {
  const res = await fetch(`${BASE}/codex/models`, { credentials: "include" });
  await assertOk(res, "Failed to get Codex models");
  const data = await res.json();
  return Array.isArray(data.models) ? data.models : [];
}

/** Models plus user-defined aliases (joined with target pricing) in one fetch. */
export async function getOpenRouterCatalog(): Promise<{ models: OpenRouterModelInfo[]; aliases: OpenRouterModelAliasInfo[] }> {
  const res = await fetch(`${BASE}/openrouter/models`, { credentials: "include" });
  await assertOk(res, "Failed to get OpenRouter models");
  const data = await res.json();
  return {
    models: Array.isArray(data.models) ? data.models : [],
    aliases: Array.isArray(data.aliases) ? data.aliases : [],
  };
}

// Server restart API

export async function restartServer(): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${BASE}/restart`, { method: "POST", credentials: "include" });
  await assertOk(res, "Failed to restart server");
  return res.json();
}

// Instance name API

export async function fetchInstanceName(): Promise<string> {
  const res = await fetch(`${BASE}/instance-name`, { credentials: "include" });
  await assertOk(res, "Failed to fetch instance name");
  const data = await res.json();
  return data.name;
}

export async function updateInstanceName(name: string): Promise<string> {
  const res = await fetch(`${BASE}/instance-name`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name }),
  });
  await assertOk(res, "Failed to update instance name");
  const data = await res.json();
  return data.name;
}

export async function randomizeInstanceName(): Promise<string> {
  const res = await fetch(`${BASE}/instance-name/randomize`, {
    method: "POST",
    credentials: "include",
  });
  await assertOk(res, "Failed to randomize instance name");
  const data = await res.json();
  return data.name;
}

// Ignored project directories API

export interface IgnoredProjectDirsResponse {
  prefixes: string[];
  defaults: string[];
}

export async function fetchIgnoredProjectDirs(): Promise<IgnoredProjectDirsResponse> {
  const res = await fetch(`${BASE}/ignored-project-dirs`, { credentials: "include" });
  await assertOk(res, "Failed to fetch ignored project directories");
  return res.json();
}

export async function updateIgnoredProjectDirs(prefixes: string[]): Promise<IgnoredProjectDirsResponse> {
  const res = await fetch(`${BASE}/ignored-project-dirs`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ prefixes }),
  });
  await assertOk(res, "Failed to update ignored project directories");
  return res.json();
}

// User contact info API

export interface ContactChannel {
  value: string;
  enabled: boolean;
}

export interface UserContactInfo {
  discord: ContactChannel;
  telegram: ContactChannel;
  phone: ContactChannel;
  email: ContactChannel;
}

export async function fetchUserContact(): Promise<UserContactInfo> {
  const res = await fetch(`${BASE}/user-contact`, { credentials: "include" });
  await assertOk(res, "Failed to fetch contact info");
  return res.json();
}

/**
 * Read contact-channel availability. `refresh` bypasses the backend's cached
 * route listing (a live daemon call) — for an explicit user gesture only.
 */
export async function fetchUserContactAvailability(opts?: { refresh?: boolean }): Promise<UserContactAvailability> {
  const res = await fetch(`${BASE}/user-contact/availability${opts?.refresh ? "?refresh=1" : ""}`, { credentials: "include" });
  await assertOk(res, "Failed to fetch contact channel availability");
  return res.json();
}

export async function updateUserContact(info: UserContactInfo): Promise<UserContactInfo> {
  const res = await fetch(`${BASE}/user-contact`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(info),
  });
  await assertOk(res, "Failed to update contact info");
  return res.json();
}

// ── Themes ──────────────────────────────────────────────────────────

export async function listThemes(): Promise<ThemeListItem[]> {
  const res = await fetch(`${BASE}/themes`, { credentials: "include" });
  await assertOk(res, "Failed to list themes");
  const data = await res.json();
  return data.themes;
}

export async function getTheme(name: string): Promise<CustomTheme> {
  const res = await fetch(`${BASE}/themes/${encodeURIComponent(name)}`, { credentials: "include" });
  await assertOk(res, "Failed to get theme");
  const data = await res.json();
  return data.theme;
}

export async function createTheme(theme: { name: string; dark: Record<string, string>; light: Record<string, string> }): Promise<CustomTheme> {
  const res = await fetch(`${BASE}/themes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(theme),
  });
  await assertOk(res, "Failed to create theme");
  const data = await res.json();
  return data.theme;
}

export async function generateTheme(name: string, description: string): Promise<CustomTheme> {
  const res = await fetch(`${BASE}/themes/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ name, description }),
  });
  await assertOk(res, "Failed to generate theme");
  const data = await res.json();
  return data.theme;
}

export async function updateTheme(
  originalName: string,
  theme: { name: string; dark: Record<string, string>; light: Record<string, string> },
): Promise<CustomTheme> {
  const res = await fetch(`${BASE}/themes/${encodeURIComponent(originalName)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(theme),
  });
  await assertOk(res, "Failed to update theme");
  const data = await res.json();
  return data.theme;
}

export async function deleteTheme(name: string): Promise<void> {
  const res = await fetch(`${BASE}/themes/${encodeURIComponent(name)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await assertOk(res, "Failed to delete theme");
}

// ── Custom Skills ───────────────────────────────────────────────────

export async function listCustomSkills(): Promise<CustomSkillListItem[]> {
  const res = await fetch(`${BASE}/custom-skills`, { credentials: "include" });
  await assertOk(res, "Failed to list skills");
  const data = await res.json();
  return data.skills;
}

export async function getCustomSkill(name: string): Promise<CustomSkill> {
  const res = await fetch(`${BASE}/custom-skills/${encodeURIComponent(name)}`, { credentials: "include" });
  await assertOk(res, "Failed to get skill");
  const data = await res.json();
  return data.skill;
}

export async function createCustomSkill(skill: { name: string; description: string; content: string }): Promise<CustomSkill> {
  const res = await fetch(`${BASE}/custom-skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(skill),
  });
  await assertOk(res, "Failed to create skill");
  const data = await res.json();
  return data.skill;
}

export async function updateCustomSkill(originalName: string, updates: { name?: string; description?: string; content?: string }): Promise<CustomSkill> {
  const res = await fetch(`${BASE}/custom-skills/${encodeURIComponent(originalName)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(updates),
  });
  await assertOk(res, "Failed to update skill");
  const data = await res.json();
  return data.skill;
}

export async function deleteCustomSkill(name: string): Promise<void> {
  const res = await fetch(`${BASE}/custom-skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await assertOk(res, "Failed to delete skill");
}

// ── Keywords ─────────────────────────────────────────────────────────

export async function listKeywords(): Promise<Keyword[]> {
  const res = await fetch(`${BASE}/keywords`, { credentials: "include" });
  await assertOk(res, "Failed to list keywords");
  const data = await res.json();
  return data.keywords;
}

export async function createKeyword(keyword: { name: string; description?: string; body: string }): Promise<Keyword> {
  const res = await fetch(`${BASE}/keywords`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(keyword),
  });
  await assertOk(res, "Failed to create keyword");
  const data = await res.json();
  return data.keyword;
}

export async function updateKeyword(originalName: string, updates: { name?: string; description?: string; body?: string }): Promise<Keyword> {
  const res = await fetch(`${BASE}/keywords/${encodeURIComponent(originalName)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(updates),
  });
  await assertOk(res, "Failed to update keyword");
  const data = await res.json();
  return data.keyword;
}

export async function deleteKeyword(name: string): Promise<void> {
  const res = await fetch(`${BASE}/keywords/${encodeURIComponent(name)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await assertOk(res, "Failed to delete keyword");
}

// ── MCP Tools ────────────────────────────────────────────────────────

export async function getMcpTools(context?: "chat" | "agent"): Promise<McpToolsResponse> {
  const params = context ? `?context=${context}` : "";
  const res = await fetch(`${BASE}/mcp-tools${params}`, { credentials: "include" });
  await assertOk(res, "Failed to get MCP tools");
  return res.json();
}

// ── Jobs ─────────────────────────────────────────────────────────────

export async function listJobs(): Promise<JobDefinition[]> {
  const res = await fetch(`${BASE}/jobs`, { credentials: "include" });
  await assertOk(res, "Failed to list jobs");
  const data = await res.json();
  return data.jobs;
}

export async function getJob(id: string): Promise<JobDefinition> {
  const res = await fetch(`${BASE}/jobs/${encodeURIComponent(id)}`, { credentials: "include" });
  await assertOk(res, "Failed to get job");
  const data = await res.json();
  return data.job;
}

export interface JobDefinitionPayload {
  id?: string;
  name: string;
  description?: string;
  inputs?: JobDefinition["inputs"];
  defaults?: JobDefinition["defaults"];
  limits?: JobDefinition["limits"];
  steps: JobStep[];
}

export async function createJob(payload: JobDefinitionPayload): Promise<JobDefinition> {
  const res = await fetch(`${BASE}/jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });
  await assertOk(res, "Failed to create job");
  const data = await res.json();
  return data.job;
}

export async function updateJob(id: string, payload: JobDefinitionPayload): Promise<JobDefinition> {
  const res = await fetch(`${BASE}/jobs/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });
  await assertOk(res, "Failed to update job");
  const data = await res.json();
  return data.job;
}

export async function deleteJob(id: string): Promise<void> {
  const res = await fetch(`${BASE}/jobs/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await assertOk(res, "Failed to delete job");
}

// Job export/import API functions

export function getJobExportUrl(id: string): string {
  return `${BASE}/jobs/${encodeURIComponent(id)}/export`;
}

/**
 * Import a job definition. `payload` may be either the full export envelope or a
 * bare job definition object — the backend accepts both.
 *
 * Resolves to `{ job }` on success (201). On a 409 conflict (id already exists
 * and no `mode` was given) it resolves to `{ conflict: { id } }` instead of
 * throwing, so the UI can prompt the user and re-call with a `mode`. Any other
 * non-OK response (validation/parse error) throws with the backend message.
 */
export async function importJob(payload: unknown, mode?: "copy" | "overwrite"): Promise<{ job?: JobDefinition; conflict?: { id: string } }> {
  const body =
    payload && typeof payload === "object" && !Array.isArray(payload) ? { ...(payload as Record<string, unknown>), ...(mode ? { mode } : {}) } : payload;
  const res = await fetch(`${BASE}/jobs/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  if (res.status === 409) {
    const data = await res.json().catch(() => ({}));
    return { conflict: { id: data.conflict?.id } };
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const message =
      Array.isArray(data.errors) && data.errors.length > 0
        ? `${data.error || "Invalid job definition"}: ${data.errors.join("; ")}`
        : data.error || "Failed to import job";
    throw new Error(message);
  }
  const data = await res.json();
  return { job: data.job };
}

export async function spawnJob(id: string, inputs: Record<string, string>): Promise<JobRun> {
  const res = await fetch(`${BASE}/jobs/${encodeURIComponent(id)}/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ inputs }),
  });
  await assertOk(res, "Failed to spawn job");
  const data = await res.json();
  return data.run;
}

export async function listJobRuns(filter?: { jobId?: string; status?: JobRunStatus; limit?: number }): Promise<JobRunListItem[]> {
  const params = new URLSearchParams();
  if (filter?.jobId) params.set("jobId", filter.jobId);
  if (filter?.status) params.set("status", filter.status);
  if (filter?.limit) params.set("limit", String(filter.limit));
  const qs = params.toString();
  const res = await fetch(`${BASE}/jobs/runs${qs ? `?${qs}` : ""}`, { credentials: "include" });
  await assertOk(res, "Failed to list job runs");
  const data = await res.json();
  return data.runs;
}

export async function getJobRun(runId: string): Promise<JobRun> {
  const res = await fetch(`${BASE}/jobs/runs/${encodeURIComponent(runId)}`, { credentials: "include" });
  await assertOk(res, "Failed to get job run");
  const data = await res.json();
  return data.run;
}

async function postJobRunAction(runId: string, action: string, body?: unknown): Promise<JobRun> {
  const res = await fetch(`${BASE}/jobs/runs/${encodeURIComponent(runId)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  await assertOk(res, `Failed to ${action} job run`);
  const data = await res.json();
  return data.run;
}

export function respondJobApproval(runId: string, decision: "approve" | "reject", comment?: string): Promise<JobRun> {
  return postJobRunAction(runId, "approval", { decision, ...(comment && { comment }) });
}

export function cancelJobRun(runId: string): Promise<JobRun> {
  return postJobRunAction(runId, "cancel");
}

export function pauseJobRun(runId: string): Promise<JobRun> {
  return postJobRunAction(runId, "pause");
}

export function resumeJobRun(runId: string): Promise<JobRun> {
  return postJobRunAction(runId, "resume");
}

export function retryJobStep(runId: string): Promise<JobRun> {
  return postJobRunAction(runId, "retry-step");
}

// ── Workspaces (plans/workspace-object.md, Phase 4a) ─────────────────
//
// The read/write split in these five is the safety property, not an accident of
// naming: `listWorkspaces` and `listUnmanagedWorktrees` observe and write
// nothing, `adoptWorktrees` acts only on paths the caller enumerated, and
// `archiveWorkspace` acts on exactly one id. There is deliberately no
// adopt-everything and no archive-many — the backend does not offer them and
// the UI must not synthesise them out of a loop.

/**
 * The rows: records, the observed state of each directory, and (opt-in) sizes.
 *
 * Deliberately **without** removal verdicts. One verdict is ~5 synchronous git
 * subprocesses, so a listing that carried them cost 1.6s of frozen daemon at 65
 * records — every other request, SSE included, waited behind it. Ask
 * {@link fetchWorkspaceRemovability} for the one record a user is acting on.
 *
 * `includeRemovability=false` is sent explicitly — see {@link workspaceListing}
 * for why neither caller may rely on the route's default. The verdict-bearing
 * variant is {@link listWorkspacesWithVerdicts}, and it is not a substitute for
 * this: nothing automatic may call it.
 */
export async function listWorkspaces(status?: "active" | "archived", includeDiskUsage?: boolean): Promise<WorkspaceListResponse> {
  return workspaceListing(status, includeDiskUsage, false);
}

/**
 * The same listing, with a removal verdict on every entry — **the expensive one**.
 *
 * Roughly five synchronous git subprocesses per record, so ~150 of them on a
 * real registry and 1.5–3s in which the daemon serves nobody. That is the whole
 * cost this PR exists to take off the automatic paths, so it lives behind its
 * own name rather than a boolean argument to {@link listWorkspaces}: a call site
 * has to say what it is doing, and there is exactly one — the "Check all" button
 * a user presses on purpose.
 *
 * **Never call this on mount, on a tab switch, on a timer, or after a mutation.**
 * The answer it returns is a point in time and the UI has to render it as one;
 * it is decoration for scanning a list, and never what an action is gated on.
 * The archive confirmation re-fetches a single fresh verdict regardless of
 * whether this has ever run — see {@link fetchWorkspaceRemovability}.
 */
export async function listWorkspacesWithVerdicts(status?: "active" | "archived", includeDiskUsage?: boolean): Promise<WorkspaceVerdictListResponse> {
  return workspaceListing(status, includeDiskUsage, true) as Promise<WorkspaceVerdictListResponse>;
}

async function workspaceListing(
  status: "active" | "archived" | undefined,
  includeDiskUsage: boolean | undefined,
  includeRemovability: boolean,
): Promise<WorkspaceListResponse> {
  // Sent explicitly in both directions, never omitted. The route defaults it to
  // *true* for browser tabs running a bundle from before the verdict was
  // splittable — they read the field unconditionally and take the whole app down
  // without it — and that default is a temporary shim which will flip. A caller
  // that relied on it would silently change behaviour on the day it does.
  const params = new URLSearchParams({ includeRemovability: String(includeRemovability) });
  if (status) params.append("status", status);
  if (includeDiskUsage) params.append("includeDiskUsage", "true");
  const res = await fetch(`${BASE}/workspaces?${params}`);
  await assertOk(res, "Failed to list workspaces");
  return res.json();
}

/**
 * The removal verdict for one workspace, evaluated now.
 *
 * Read-only, and **not** what makes an archive safe: `archiveWorkspace` runs
 * every gate again server-side and there is no way to hand this back to it. What
 * it is for is telling a user what their click is about to do before they make
 * it — which of the two archives they are looking at, and which gitignored files
 * would travel into the trash.
 */
export async function fetchWorkspaceRemovability(id: string): Promise<WorkspaceWithRemovability> {
  const res = await fetch(`${BASE}/workspaces/${id}/removability`);
  await assertOk(res, "Failed to evaluate the workspace");
  const body: WorkspaceRemovabilityResponse = await res.json();
  return body.workspace;
}

/** Read-only discovery. Creates no record and writes nothing. */
export async function listUnmanagedWorktrees(repoPath: string, includeDiskUsage = true): Promise<UnmanagedWorktreeListing> {
  const params = new URLSearchParams({ repoPath });
  if (!includeDiskUsage) params.append("includeDiskUsage", "false");
  const res = await fetch(`${BASE}/workspaces/unmanaged?${params}`);
  await assertOk(res, "Failed to list unmanaged worktrees");
  return res.json();
}

/**
 * Adopt the named worktrees. Paths only — never a filter, never a pattern.
 *
 * The backend cannot tell "a human chose this path" from "an agent generated
 * it", which is Phase 2b's stated limitation; the confirmation step in front of
 * this call is where that gap is closed, so nothing may call it without one.
 */
export async function adoptWorktrees(paths: string[]): Promise<AdoptWorktreesResult> {
  const res = await fetch(`${BASE}/workspaces/adopt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  await assertOk(res, "Failed to adopt worktrees");
  return res.json();
}

/**
 * Rename one workspace record. **Nothing on disk moves.**
 *
 * The name is a label: no directory, branch or worktree path is derived from
 * it anywhere. A rejected name (empty, over 200 characters, or carrying control
 * or text-direction characters) comes back as a 400 whose message is the
 * sentence to show — `assertOk` surfaces it.
 */
export async function renameWorkspace(id: string, name: string): Promise<Workspace> {
  const res = await fetch(`${BASE}/workspaces/${encodeURIComponent(id)}/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  await assertOk(res, "Failed to rename workspace");
  const data = await res.json();
  return data.workspace;
}

/** Archive one workspace, quarantining its worktree only if every gate passes. */
export async function archiveWorkspace(id: string): Promise<ArchiveWorkspaceResult> {
  const res = await fetch(`${BASE}/workspaces/${encodeURIComponent(id)}/archive`, { method: "POST" });
  await assertOk(res, "Failed to archive workspace");
  return res.json();
}

export async function listTrash(includeDiskUsage = true): Promise<TrashListing> {
  const params = new URLSearchParams();
  if (includeDiskUsage) params.append("includeDiskUsage", "true");
  const res = await fetch(`${BASE}/workspaces/trash${params.toString() ? `?${params}` : ""}`);
  await assertOk(res, "Failed to list trash");
  return res.json();
}

/**
 * Restore a quarantined worktree.
 *
 * A refusal comes back as HTTP 409 with a `TrashRestoreResult` body rather than
 * an error, because the refusal *is* the answer the caller wants — and every
 * refusal leaves the trash entry intact.
 */
export async function restoreTrashEntry(entry: string): Promise<TrashRestoreResult> {
  const res = await fetch(`${BASE}/workspaces/trash/${encodeURIComponent(entry)}/restore`, { method: "POST" });
  if (res.status === 409) return res.json();
  await assertOk(res, "Failed to restore trash entry");
  return res.json();
}
