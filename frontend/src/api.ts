import type {
  SlashCommand,
  PluginCommand,
  PluginManifest,
  Plugin,
  Chat,
  ParsedMessage,
  ChatListResponse,
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
  CustomSkill,
  CustomSkillListItem,
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
} from "shared/types/index.js";

export type {
  SlashCommand,
  PluginCommand,
  PluginManifest,
  Plugin,
  Chat,
  ParsedMessage,
  ChatListResponse,
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
  CustomSkill,
  CustomSkillListItem,
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
};

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
): Promise<ChatListResponse> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.append("limit", limit.toString());
  if (offset !== undefined) params.append("offset", offset.toString());
  if (bookmarked) params.append("bookmarked", "true");
  if (excludeTriggered) params.append("excludeTriggered", "true");
  if (cached === false) params.append("cached", "false");

  const res = await fetch(`${BASE}/chats${params.toString() ? `?${params}` : ""}`);
  await assertOk(res, "Failed to list chats");
  return res.json();
}

export async function listFolders(maxAgeDays?: number): Promise<FolderListResponse> {
  const params = new URLSearchParams();
  if (maxAgeDays !== undefined) params.append("maxAgeDays", maxAgeDays.toString());
  const res = await fetch(`${BASE}/chats/folders${params.toString() ? `?${params}` : ""}`);
  await assertOk(res, "Failed to list folders");
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
 * Fork a chat at a message: creates a new chat whose history is a copy of
 * this one up to and including the message at `timestamp`. The forked chat
 * is not auto-started — the user sends the next message themselves.
 */
export async function forkChat(id: string, timestamp: string): Promise<Chat> {
  const res = await fetch(`${BASE}/chats/${id}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamp }),
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

// Claude Code auth status API

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email?: string;
  authMethod?: string;
  subscriptionType?: string;
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
  /** True when the user has an OPENROUTER_API_KEY configured in Settings → API. */
  openRouterConfigured?: boolean;
  /** True when the native Claude Code harness is routed through OpenRouter (toggle on + key set). */
  claudeCodeUseOpenRouter?: boolean;
  /** True when the native Codex harness is routed through OpenRouter (toggle on + key set). */
  codexUseOpenRouter?: boolean;
  /** True when the ambient env already points Claude Code at OpenRouter (ANTHROPIC_BASE_URL). Defaults the toggle on. */
  claudeCodeOpenRouterDetected?: boolean;
  /** True when the ambient env already points Codex at OpenRouter (OPENAI base / config.toml). Defaults the toggle on. */
  codexOpenRouterDetected?: boolean;
  /**
   * Effective per-session OpenRouter spend cap, in USD. The backend resolves
   * the user's override (if any) against the OR library's own default ($1.00)
   * and surfaces the resolved value here so the UI can display "Spend cap:
   * $X.XX per session" without duplicating the default.
   */
  openRouterMaxBudgetUsd?: number;
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
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const res = await fetch(`${BASE}/system-info`, { credentials: "include" });
  await assertOk(res, "Failed to get system info");
  return res.json();
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
export async function importJob(
  payload: unknown,
  mode?: "copy" | "overwrite",
): Promise<{ job?: JobDefinition; conflict?: { id: string } }> {
  const body =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? { ...(payload as Record<string, unknown>), ...(mode ? { mode } : {}) }
      : payload;
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
