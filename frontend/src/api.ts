import type {
  SlashCommand,
  PluginCommand,
  PluginManifest,
  Plugin,
  Chat,
  ParsedMessage,
  ChatListResponse,
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
  CronJob,
  ActivityEntry,
  Trigger,
  TriggerFilter,
  FilterCondition,
  AgentSettings,
  KeyAliasInfo,
  CallerInfo,
  ConnectionStatus,
} from "shared/types/index.js";

export type {
  SlashCommand,
  PluginCommand,
  PluginManifest,
  Plugin,
  Chat,
  ParsedMessage,
  ChatListResponse,
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
  CronJob,
  ActivityEntry,
  Trigger,
  TriggerFilter,
  FilterCondition,
  AgentSettings,
  KeyAliasInfo,
  CallerInfo,
  ConnectionStatus,
};

const BASE = "/api";

/** Shared error handler: throws with the server's error message or a fallback. */
async function assertOk(res: Response, fallback: string): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || fallback);
  }
}

export async function listChats(limit?: number, offset?: number, bookmarked?: boolean): Promise<ChatListResponse> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.append("limit", limit.toString());
  if (offset !== undefined) params.append("offset", offset.toString());
  if (bookmarked) params.append("bookmarked", "true");

  const res = await fetch(`${BASE}/chats${params.toString() ? `?${params}` : ""}`);
  await assertOk(res, "Failed to list chats");
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

// Proxy API functions

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
  source: string;
  eventType: string;
  data: unknown;
  storedAt: number;
}

export async function getProxyEvents(limit?: number, offset?: number): Promise<{ events: StoredEvent[]; sources: string[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.append("limit", limit.toString());
  if (offset !== undefined) params.append("offset", offset.toString());

  const res = await fetch(`${BASE}/proxy/events${params.toString() ? `?${params}` : ""}`, { credentials: "include" });
  await assertOk(res, "Failed to get proxy events");
  return res.json();
}

export async function getProxyEventsBySource(source: string, limit?: number, offset?: number): Promise<{ events: StoredEvent[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.append("limit", limit.toString());
  if (offset !== undefined) params.append("offset", offset.toString());

  const res = await fetch(`${BASE}/proxy/events/${encodeURIComponent(source)}${params.toString() ? `?${params}` : ""}`, { credentials: "include" });
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

export async function getKeyAliases(): Promise<KeyAliasInfo[]> {
  const res = await fetch(`${BASE}/agent-settings/key-aliases`, { credentials: "include" });
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

// Connection management API functions

export interface ConnectionsListResponse {
  templates: ConnectionStatus[];
  callers: CallerInfo[];
  localModeActive: boolean;
}

export async function getConnections(caller?: string): Promise<ConnectionsListResponse> {
  const params = caller ? `?caller=${encodeURIComponent(caller)}` : "";
  const res = await fetch(`${BASE}/connections${params}`, { credentials: "include" });
  await assertOk(res, "Failed to get connections");
  return res.json();
}

export async function setConnectionEnabled(alias: string, enabled: boolean, caller?: string): Promise<{ alias: string; enabled: boolean }> {
  const res = await fetch(`${BASE}/connections/${encodeURIComponent(alias)}/enable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ enabled, ...(caller && { caller }) }),
  });
  await assertOk(res, "Failed to toggle connection");
  return res.json();
}

export async function setConnectionSecrets(alias: string, secrets: Record<string, string>, caller?: string): Promise<{ secretsSet: Record<string, boolean> }> {
  const res = await fetch(`${BASE}/connections/${encodeURIComponent(alias)}/secrets`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ secrets, ...(caller && { caller }) }),
  });
  await assertOk(res, "Failed to set connection secrets");
  return res.json();
}

// Caller alias management

export async function getCallerAliases(): Promise<{ callers: CallerInfo[] }> {
  const res = await fetch(`${BASE}/connections/callers`, { credentials: "include" });
  await assertOk(res, "Failed to get caller aliases");
  return res.json();
}

export async function createCallerAlias(alias: string, name?: string): Promise<{ caller: CallerInfo }> {
  const res = await fetch(`${BASE}/connections/callers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ alias, ...(name && { name }) }),
  });
  await assertOk(res, "Failed to create caller alias");
  return res.json();
}

export async function deleteCallerAlias(callerAlias: string): Promise<void> {
  const res = await fetch(`${BASE}/connections/callers/${encodeURIComponent(callerAlias)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await assertOk(res, "Failed to delete caller alias");
}
