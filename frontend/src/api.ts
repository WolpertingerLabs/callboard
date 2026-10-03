import { handshakeHeaders } from "shared/types/index.js";
import type { ReasoningCapability } from "shared/types/index.js";
import { normalizePermissions } from "shared/types/permissions.js";
import type {
  UiAgentProviderKind,
  UserContactAvailability,
  ChatActivityResponse,
  SlashCommand,
  Plugin,
  Chat,
  ParsedMessage,
  ChatListResponse,
  ChatTreeResponse,
  FolderListResponse,
  DefaultPermissions,
  ImageUploadResult,
  QueueItem,
  QueueItemImage,
  BrowseResult,
  ValidateResult,
  FolderSuggestion,
  GitDiffResponse,
  AppPluginsData,
  ScanResult,
  AgentConfig,
  SystemMessagePreview,
  CronJob,
  ActivityEntry,
  Trigger,
  TriggerFilter,
  AgentSettings,
  KeyAliasInfo,
  EnrolledCaller,
  CustomTheme,
  ThemeListItem,
  CustomSkill,
  CustomSkillListItem,
  Keyword,
  McpToolsResponse,
  OpenRouterModelInfo,
  OpenRouterModelAliasInfo,
  CodexModelInfo,
  JobDefinition,
  JobStep,
  JobRun,
  JobRunListItem,
  JobRunStatus,
  CardPatch,
  CardSummary,
  CardListResponse,
  CardResponse,
  Workspace,
  WorkspaceWithRemovability,
  WorkspaceListResponse,
  WorkspaceVerdictListResponse,
  WorkspaceRemovabilityResponse,
  UnmanagedWorktreeListing,
  AdoptWorktreesResult,
  ArchiveWorkspaceResult,
  TrashListing,
  TrashRestoreResult,
  EngineStatus,
  EngineStatusResponse,
  EngineRefreshResponse,
  EngineBinaryCheckResponse,
  EngineInstallStartResponse,
  EngineInstallEvent,
  SlashCommandContent,
  StoredEvent,
  ConnectionTestResult,
  ApiKeyInfo,
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
  QueueItemImage,
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
  SlashCommandContent,
  StoredEvent,
  ConnectionTestResult,
  ApiKeyInfo,
} from "shared/types/index.js";

export { CARD_CATEGORY_MAX, WORKSPACE_NAME_MAX } from "shared/types/index.js";

import type {
  StorageItem,
  StorageKeySummary,
  StorageKeyDetail,
  PutStorageItemJsonBody,
  Artifact,
  ArtifactSummary,
  CreateArtifactInput,
  UpdateArtifactInput,
} from "shared/types/index.js";

/**
 * Capability handshake headers (`X-Callboard-Protocol` / `X-Callboard-Caps`).
 * Re-exported here so callers that hand-roll a `fetch` — the SSE streams in
 * Chat.tsx, which need the raw response body — can spread them in without
 * reaching into `shared/` directly. Omitting them is always safe: the server
 * treats a headerless client as protocol 1 with no capabilities.
 */
export { handshakeHeaders } from "shared/types/index.js";

const BASE = "/api";

/**
 * The sentence to show for a failed response body: `message` first (the 409s
 * that carry a machine code in `error` put the prose there), then `error`, then
 * a validation `errors[]` list, then `fallback`.
 */
function errorBodyMessage(body: unknown, fallback: string): string {
  const b = (body && typeof body === "object" ? body : {}) as { message?: unknown; error?: unknown; errors?: unknown };
  if (typeof b.message === "string" && b.message) return b.message;
  if (typeof b.error === "string" && b.error) return b.error;
  if (Array.isArray(b.errors) && b.errors.length > 0) return b.errors.join("; ");
  return fallback;
}

/** Shared error handler: throws with the server's error message or a fallback. */
async function assertOk(res: Response, fallback: string): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(errorBodyMessage(body, fallback));
  }
}

/** One path segment, encoded — ids are opaque and never meant to add a `/`. */
const seg = (value: string | number): string => encodeURIComponent(String(value));

/** `?a=b…`, or nothing for an empty set — so a parameterless request keeps its bare URL. */
const query = (params: URLSearchParams): string => {
  const qs = params.toString();
  return qs ? `?${qs}` : "";
};

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RequestOptions {
  method?: HttpMethod;
  /** Sent as the JSON body, with a JSON Content-Type. Omit for no body. */
  json?: unknown;
  /** A non-JSON body (multipart `FormData`); the browser sets its Content-Type. */
  body?: FormData;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** The error when the server's response names none. */
  error: string;
}

/**
 * The one fetch every JSON wrapper below goes through: `${BASE}${path}`, the
 * one credentials policy, a Content-Type only when there is a JSON body, and
 * {@link assertOk}.
 *
 * `credentials: "include"` everywhere. Every request here is a relative `/api`
 * URL — same-origin in production and through the Vite dev proxy alike — and
 * for a same-origin request `include` and the default `same-origin` send the
 * same cookie, so this is one spelling rather than a behaviour change.
 */
async function send(path: string, opts: RequestOptions): Promise<Response> {
  const init: RequestInit = { credentials: "include" };
  if (opts.method) init.method = opts.method;
  if (opts.json !== undefined) {
    init.headers = { ...opts.headers, "Content-Type": "application/json" };
    init.body = JSON.stringify(opts.json);
  } else {
    if (opts.headers) init.headers = opts.headers;
    if (opts.body !== undefined) init.body = opts.body;
  }
  if (opts.signal) init.signal = opts.signal;
  const res = await fetch(`${BASE}${path}`, init);
  await assertOk(res, opts.error);
  return res;
}

/** {@link send}, parsing the JSON response. */
async function request<T>(path: string, opts: RequestOptions): Promise<T> {
  const res = await send(path, opts);
  return res.json() as Promise<T>;
}

/** {@link request} for the `{ [field]: value }` envelope most list/detail routes answer with. */
async function requestField<T>(path: string, field: string, opts: RequestOptions): Promise<T> {
  const data = await request<Record<string, T>>(path, opts);
  return data[field];
}

/** {@link send} for calls whose response body nobody reads. */
async function requestVoid(path: string, opts: RequestOptions): Promise<void> {
  await send(path, opts);
}

// ── Session poll ─────────────────────────────────────────────────────

export type SessionType = "web" | "cli";

export interface ActiveSessionInfo {
  type: SessionType;
  startedAt?: number;
}

export interface SummonInfo {
  message: string;
  urgency: "normal" | "urgent";
  createdAt: string;
}

/**
 * `GET /sessions/poll`. The counters always come back; each payload only when
 * it differs from what the client echoed in `v` / `mv` / `b` — see the route.
 */
export interface SessionPollResponse {
  version: number;
  metadataVersion: number;
  build?: string;
  sessions?: Record<string, ActiveSessionInfo>;
  activeSummons?: Record<string, SummonInfo>;
}

export async function pollSessions(params: URLSearchParams): Promise<SessionPollResponse> {
  return request(`/sessions/poll?${params}`, { error: "Failed to poll sessions" });
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
   * Scope by the lifecycle of each chat's card. "unarchived" is what the
   * sidebar sends: everything except the trees of closed or hidden cards, so a
   * chat on no card at all (triggered, job-step, or simply never recorded) is
   * IN. "active" is the narrower open-card trees (what `cardsOnly` meant),
   * "inactive" their complement, "all" no scoping. Omitted when "all", so the
   * default request is byte-identical to what it was.
   *
   * "active"/"inactive" have no caller left in this bundle and are kept because
   * an older one still sends them — relabel these values, never rename them.
   */
  cardLifecycle?: "all" | "active" | "inactive" | "unarchived",
  /**
   * Append pinned chats that fall outside the pagination window, so the
   * sidebar's Pinned section survives the chat ageing out of the page. Purely
   * additive: every other argument here still applies to them, so a pinned
   * chat the `cardLifecycle` scope excludes stays excluded, and a pinned chat
   * already in the window is not returned twice.
   *
   * Trailing and optional, so a caller that does not want them — anything
   * paginating for its own purposes rather than rendering the sidebar — reads
   * exactly as it did.
   */
  includePinned?: boolean,
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
  if (includePinned) params.append("includePinned", "true");

  return request(`/chats${query(params)}`, { error: "Failed to list chats" });
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
  return request(`/chats/folders${query(params)}`, { signal, error: "Failed to list folders" });
}

export async function getChatTree(id: string): Promise<ChatTreeResponse> {
  return request(`/chats/${seg(id)}/tree`, { error: "Failed to get chat tree" });
}

export async function searchChatContents(query: string): Promise<{ chatIds: string[] }> {
  const params = new URLSearchParams({ q: query });
  return request(`/chats/search?${params}`, { error: "Failed to search chats" });
}

export async function toggleBookmark(id: string, bookmarked: boolean): Promise<Chat> {
  return request(`/chats/${seg(id)}/bookmark`, { method: "PATCH", json: { bookmarked }, error: "Failed to toggle bookmark" });
}

/**
 * Pin or unpin a chat — the sidebar files pinned chats into their own section
 * at the top of the list.
 *
 * A separate flag from the bookmark, not a second reading of it: a bookmark is
 * a filter you go looking through, a pin is a position you put something in.
 */
export async function togglePin(id: string, pinned: boolean): Promise<Chat> {
  return request(`/chats/${seg(id)}/pin`, { method: "PATCH", json: { pinned }, error: "Failed to toggle pin" });
}

/**
 * Store a hand-written title for the chat. Pass an empty string to clear it and
 * fall back to the auto-derived preview; the response carries what was stored,
 * which is `null` in that case.
 */
export async function setChatTitle(id: string, title: string): Promise<{ title: string | null }> {
  return request(`/chats/${seg(id)}/title`, { method: "PATCH", json: { title }, error: "Failed to save chat title" });
}

/**
 * Re-derive the chat's title from its current contents and persist it. Slow by
 * nature — it runs a model call server-side — so callers are expected to hold
 * a lock while it is in flight rather than let it be fired twice.
 */
export async function regenerateChatTitle(id: string): Promise<{ title: string }> {
  return request(`/chats/${seg(id)}/regenerate-title`, { method: "POST", error: "Failed to regenerate chat title" });
}

export async function updateChatPermissions(id: string, permissions: DefaultPermissions): Promise<Chat> {
  return request(`/chats/${seg(id)}/permissions`, {
    method: "PATCH",
    json: { defaultPermissions: normalizePermissions(permissions) },
    error: "Failed to update chat permissions",
  });
}

export async function markAsRead(id: string): Promise<Chat> {
  return request(`/chats/${seg(id)}/read`, { method: "PATCH", error: "Failed to mark chat as read" });
}

export async function dismissSummon(id: string): Promise<Chat> {
  return request(`/chats/${seg(id)}/summon`, { method: "PATCH", json: { dismiss: true }, error: "Failed to dismiss summon" });
}

// ── Cards (board view) ──────────────────────────────────────────────

/**
 * `includeHidden` is off by default because the board — the caller this was
 * written for — is exactly what a hidden card opted out of.
 *
 * The sidebar passes it, and not as a nicety: `utils/chatDimming` fades a chat
 * whose card is closed *or hidden*, which it can only do for cards it was
 * given. Omit them there and a hidden card's chats look card-less, so the dim
 * says "not archived" while `cardLifecycle=unarchived` withholds them for being
 * archived — the two halves out of step in the one way #440 set out to prevent.
 */
export async function listCards(includeHidden?: boolean): Promise<CardListResponse> {
  return request(`/cards${includeHidden ? "?includeHidden=true" : ""}`, { error: "Failed to list cards" });
}

export async function getCard(id: string): Promise<CardResponse> {
  return request(`/cards/${seg(id)}`, { error: "Failed to get card" });
}

export async function updateCard(id: string, patch: CardPatch): Promise<CardResponse> {
  return request(`/cards/${seg(id)}`, { method: "PATCH", json: patch, error: "Failed to update card" });
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
  return request("/cards/bulk-lifecycle", { method: "POST", json: { ids, lifecycle }, error: "Failed to update cards" });
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
  /**
   * Present, and only ever `true`, when this checkout is on no branch — a
   * detached HEAD, or the vanishing case of a HEAD symref outside
   * `refs/heads`. `git_branch` keeps reporting its long-standing `"main"`
   * fallback in that state, which is why this exists beside it rather than
   * inside it; see `GitInfo.isDetached` in `backend/src/utils/git.ts`.
   *
   * Absent from a daemon older than this bundle, and absent when git could not
   * answer. Treat absence as "no reason to think so".
   */
  isDetached?: boolean;
  slash_commands: SlashCommand[];
  plugins: Plugin[];
  appPlugins?: AppPluginsData;
}

export async function getNewChatInfo(folder: string): Promise<NewChatInfo> {
  return request(`/chats/new/info?folder=${encodeURIComponent(folder)}`, { error: "Failed to get chat info" });
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
export type ForkProvider = Exclude<UiAgentProviderKind, "acp">;

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
  return request(`/chats/${seg(id)}/fork`, {
    method: "POST",
    json: { timestamp, ...(opts?.provider && { provider: opts.provider }), ...(opts?.model && { model: opts.model }) },
    error: "Failed to fork chat",
  });
}

export async function deleteChat(id: string): Promise<void> {
  // The 409 for a native Codex child carries a code in `error` and the
  // explanation in `message`; the sidebar shows this, and `assertOk` prefers the words.
  await requestVoid(`/chats/${seg(id)}`, { method: "DELETE", error: "Failed to delete chat" });
}

/**
 * Per-id outcome of a bulk delete, shaped exactly like
 * {@link BulkLifecycleFailure} — same field names, same reason: the endpoint is
 * deliberately partial rather than all-or-nothing, so one chat failing must not
 * strand the other six, and the caller retries exactly the ids named here.
 */
export interface BulkDeleteFailure {
  id: string;
  error: string;
}

export interface BulkDeleteResponse {
  /** The ids actually deleted — the caller can drop exactly these from its list. */
  deleted: string[];
  failed: BulkDeleteFailure[];
}

/**
 * Delete many chats at once; see BulkDeleteResponse on partial failure.
 *
 * Per id this is exactly `DELETE /api/chats/:id`, children included — which is
 * to say NOT included: deleting a chat has never cascaded to the chats forked
 * from it, and the bulk path deliberately does not invent a different rule.
 */
export async function bulkDeleteChats(ids: string[]): Promise<BulkDeleteResponse> {
  return request("/chats/bulk-delete", { method: "POST", json: { ids }, error: "Failed to delete chats" });
}

export async function getChat(id: string): Promise<Chat> {
  return request(`/chats/${seg(id)}`, { error: "Failed to get chat" });
}

export async function getMessages(id: string): Promise<ParsedMessage[]> {
  return request(`/chats/${seg(id)}/messages`, { error: "Failed to get messages" });
}

/**
 * The prompt a chat is blocked on — a permission request, a question, or a plan
 * to review — as `GET /chats/:id/pending` replays it and `FeedbackPanel` renders it.
 */
export interface PendingAction {
  type: "permission_request" | "user_question" | "plan_review";
  requestId?: string;
  humanOnly?: boolean;
  controlRequest?: boolean;
  toolName?: string;
  input?: Record<string, unknown>;
  questions?: any[];
  suggestions?: any[];
  content?: string;
  /** True when reconstructed from message history (no live backend session) */
  stale?: boolean;
}

export async function getPending(id: string): Promise<PendingAction | null> {
  return requestField(`/chats/${seg(id)}/pending`, "pending", { headers: handshakeHeaders(), error: "Failed to get pending action" });
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
  return request(`/chats/${seg(id)}/activity`, { error: "Failed to get chat activity" });
}

/**
 * End an interruptible activity (a `wait`) early, so the agent resumes now.
 *
 * Throws on refusal — a 404 here means the wait already elapsed on its own, or
 * the activity represents delegated work that cannot be cut short.
 */
export async function releaseActivity(id: string, activityId: string): Promise<{ ok: boolean; kind: string }> {
  return request(`/chats/${seg(id)}/activity/${seg(activityId)}/release`, { method: "POST", error: "Failed to end the wait" });
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
  const res = await fetch(`${BASE}/chats/${seg(id)}/stop`, { method: "POST", credentials: "include" });
  await assertOk(res, `Stop failed (${res.status})`);
  return res.json();
}

export async function respondToChat(
  id: string,
  allow: boolean,
  updatedInput?: Record<string, unknown>,
  updatedPermissions?: unknown[],
  requestId?: string,
): Promise<{ ok: boolean; toolName?: string; error?: string }> {
  const res = await fetch(`${BASE}/chats/${seg(id)}/respond`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ allow, updatedInput, updatedPermissions, requestId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error || "Could not answer this prompt. Retry or refresh the pending request." };
  }
  return res.json();
}

export async function uploadImages(chatId: string, images: File[]): Promise<ImageUploadResult> {
  const formData = new FormData();
  images.forEach((image) => {
    formData.append("images", image);
  });

  return request(`/chats/${seg(chatId)}/images`, { method: "POST", body: formData, error: "Failed to upload images" });
}

/** Upload images without a chat ID (for new chat creation). */
export async function uploadImagesOnly(images: File[]): Promise<ImageUploadResult> {
  const formData = new FormData();
  images.forEach((image) => {
    formData.append("images", image);
  });

  return request("/images/upload", { method: "POST", body: formData, error: "Failed to upload images" });
}

// Draft API functions
export async function getDrafts(chatId?: string): Promise<QueueItem[]> {
  const params = new URLSearchParams();
  if (chatId) params.append("chat_id", chatId);

  return request(`/queue?${params}`, { error: "Failed to load drafts" });
}

export async function createDraft(
  chatId: string | null,
  message: string,
  folder?: string,
  defaultPermissions?: DefaultPermissions,
  images?: QueueItemImage[],
): Promise<QueueItem> {
  return request("/queue", {
    method: "POST",
    json: {
      chat_id: chatId,
      user_message: message,
      ...(folder && { folder }),
      ...(defaultPermissions && { defaultPermissions: normalizePermissions(defaultPermissions) }),
      ...(images?.length && { images }),
    },
    error: "Failed to save draft",
  });
}

/** `images` replaces the draft's images, `[]` included; omit it to leave them alone. */
export async function updateDraft(id: string, message: string, images?: QueueItemImage[]): Promise<QueueItem> {
  return request(`/queue/${seg(id)}`, { method: "PUT", json: { user_message: message, ...(images && { images }) }, error: "Failed to update draft" });
}

/** Upload a draft's attachments through the regular upload route. */
export async function uploadDraftImages(images: File[]): Promise<QueueItemImage[]> {
  if (images.length === 0) return [];
  const result = await uploadImagesOnly(images);
  const stored = result.images ?? [];
  if (stored.length !== images.length) throw new Error(result.errors?.join("; ") || "Failed to upload images");
  return stored.map((image) => ({ id: image.id, originalName: image.originalName }));
}

/**
 * A draft's stored images, back as Files the composer can attach and send.
 * Settled per image, in order: one that fails to load must not take the rest
 * down with it. Aborting `signal` rejects every image still in flight, the
 * same as a failed load.
 */
export async function fetchDraftImages(images: QueueItemImage[], signal?: AbortSignal): Promise<PromiseSettledResult<File>[]> {
  return Promise.allSettled(
    images.map(async (image) => {
      const res = await send(`/images/${seg(image.id)}`, { signal, error: "Failed to load draft image" });
      const blob = await res.blob();
      return new File([blob], image.originalName, { type: blob.type });
    }),
  );
}

export async function deleteDraft(id: string): Promise<void> {
  await requestVoid(`/queue/${seg(id)}`, { method: "DELETE", error: "Failed to delete draft" });
}

export async function getSlashCommandsAndPlugins(chatId: string): Promise<{ slashCommands: string[]; plugins: Plugin[]; appPlugins?: AppPluginsData }> {
  const data = await request<{ slashCommands?: string[]; plugins?: Plugin[]; appPlugins?: AppPluginsData }>(`/chats/${seg(chatId)}/slash-commands`, {
    error: "Failed to get slash commands",
  });
  return {
    slashCommands: data.slashCommands || [],
    plugins: data.plugins || [],
    appPlugins: data.appPlugins,
  };
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
    path = `/chats/${seg(chatId)}/slash-commands/content`;
  } else {
    path = "/chats/new/slash-commands/content";
    params.set("folder", folder!);
  }

  const data = await request<SlashCommandContent>(`${path}?${params.toString()}`, { error: "Failed to get command content" });
  slashCommandContentCache.set(key, data);
  return data;
}

// Branch / worktree configuration

/** A branch that a worktree is sitting on, and the directory it sits in. */
export interface CheckedOutBranch {
  branch: string;
  path: string;
  isMainWorktree: boolean;
}

/**
 * `checkedOut` is optional because a daemon older than this bundle does not send
 * it. `BranchSelector` renders absence and emptiness identically — as "nothing
 * is checked out elsewhere" — and that is deliberate rather than a gap left to
 * close: what the field buys is one extra sentence about a redirect, so losing
 * it costs the enhancement, not correctness. The fallback sentence is the one
 * the box showed before this field existed, and the request it describes is
 * unchanged either way. A third "we cannot tell" state would spend the user's
 * attention on the daemon's version rather than on their own choice.
 */
export async function getGitBranches(folder: string): Promise<{ branches: string[]; checkedOut?: CheckedOutBranch[] }> {
  return request(`/git/branches?folder=${encodeURIComponent(folder)}`, { error: "Failed to list branches" });
}

export async function getGitDiff(folder: string): Promise<GitDiffResponse> {
  return request(`/git/diff?folder=${encodeURIComponent(folder)}`, { error: "Failed to get diff" });
}

export async function getGitFileDiff(folder: string, filename: string): Promise<{ diff: string; additions: number; deletions: number }> {
  const params = new URLSearchParams({ folder, filename });
  return request(`/git/diff/file?${params}`, { error: "Failed to get file diff" });
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

  return request(`/folders/browse?${params}`, { error: "Failed to browse directory" });
}

export async function validatePath(path: string): Promise<ValidateResult> {
  const params = new URLSearchParams({ path });

  return request(`/folders/validate?${params}`, { error: "Failed to validate path" });
}

export async function getFolderSuggestions(): Promise<SuggestionsResponse> {
  return request("/folders/suggestions", { error: "Failed to get folder suggestions" });
}

export async function clearFolderCache(): Promise<void> {
  await requestVoid("/folders/clear-cache", { method: "POST", error: "Failed to clear folder cache" });
}

// App-wide Plugins & MCP Servers API functions

export async function getAppPlugins(): Promise<AppPluginsData> {
  return request("/app-plugins", { error: "Failed to get app plugins" });
}

export async function scanForPlugins(directory: string): Promise<ScanResult> {
  return request("/app-plugins/scan", { method: "POST", json: { directory }, error: "Failed to scan for plugins" });
}

export async function rescanPlugins(directory?: string): Promise<AppPluginsData> {
  return request("/app-plugins/rescan", { method: "POST", json: { directory }, error: "Failed to rescan plugins" });
}

export async function removeScanRoot(directory: string): Promise<void> {
  await requestVoid("/app-plugins/scan-root", { method: "DELETE", json: { directory }, error: "Failed to remove scan root" });
}

export async function toggleAppPlugin(pluginId: string, enabled: boolean): Promise<void> {
  await requestVoid(`/app-plugins/plugins/${seg(pluginId)}`, { method: "PATCH", json: { enabled }, error: "Failed to toggle plugin" });
}

export async function toggleMcpServer(serverId: string, enabled: boolean): Promise<void> {
  await requestVoid(`/app-plugins/mcp-servers/${seg(serverId)}`, { method: "PATCH", json: { enabled }, error: "Failed to toggle MCP server" });
}

export async function updateMcpServerEnv(serverId: string, env: Record<string, string>): Promise<void> {
  await requestVoid(`/app-plugins/mcp-servers/${seg(serverId)}/env`, { method: "PATCH", json: { env }, error: "Failed to update MCP server env" });
}

// Agent API functions

export async function listAgents(): Promise<AgentConfig[]> {
  return requestField("/agents", "agents", { error: "Failed to list agents" });
}

export async function getAgent(alias: string): Promise<AgentConfig> {
  return requestField(`/agents/${seg(alias)}`, "agent", { error: "Failed to get agent" });
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
  return requestField("/agents", "agent", { method: "POST", json: agent, error: "Failed to create agent" });
}

export async function updateAgent(alias: string, updates: Partial<AgentConfig>): Promise<AgentConfig> {
  return requestField(`/agents/${seg(alias)}`, "agent", { method: "PUT", json: updates, error: "Failed to update agent" });
}

export async function toggleAgent(alias: string, enabled: boolean): Promise<AgentConfig> {
  return requestField(`/agents/${seg(alias)}/toggle`, "agent", { method: "PATCH", json: { enabled }, error: "Failed to toggle agent" });
}

export async function deleteAgent(alias: string): Promise<void> {
  await requestVoid(`/agents/${seg(alias)}`, { method: "DELETE", error: "Failed to delete agent" });
}

export async function getAgentIdentityPrompt(alias: string): Promise<string> {
  return requestField(`/agents/${seg(alias)}/identity-prompt`, "prompt", { error: "Failed to get agent identity prompt" });
}

export async function getAgentSystemMessagePreview(alias: string): Promise<SystemMessagePreview> {
  return request(`/agents/${seg(alias)}/system-message-preview`, { error: "Failed to get system message preview" });
}

// Agent export/import API functions

export function getAgentExportUrl(alias: string): string {
  return `${BASE}/agents/${seg(alias)}/export`;
}

export async function importAgent(file: File): Promise<AgentConfig> {
  const formData = new FormData();
  formData.append("file", file);

  return requestField("/agents/import", "agent", { method: "POST", body: formData, error: "Failed to import agent" });
}

// Agent workspace file API functions

export async function getWorkspaceFiles(alias: string): Promise<string[]> {
  return requestField(`/agents/${seg(alias)}/workspace`, "files", { error: "Failed to list workspace files" });
}

export async function getWorkspaceFile(alias: string, filename: string): Promise<string> {
  return requestField(`/agents/${seg(alias)}/workspace/${seg(filename)}`, "content", { error: "Failed to read workspace file" });
}

export async function updateWorkspaceFile(alias: string, filename: string, content: string): Promise<void> {
  await requestVoid(`/agents/${seg(alias)}/workspace/${seg(filename)}`, { method: "PUT", json: { content }, error: "Failed to update workspace file" });
}

// Agent memory API functions

export async function getAgentMemory(alias: string): Promise<{ curatedMemory: string; dailyFiles: string[] }> {
  return request(`/agents/${seg(alias)}/memory`, { error: "Failed to get agent memory" });
}

export async function getAgentDailyMemory(alias: string, date: string): Promise<string> {
  return requestField(`/agents/${seg(alias)}/memory/${seg(date)}`, "content", { error: "Failed to get daily memory" });
}

// Agent cron jobs API functions

export async function getAgentCronJobs(alias: string): Promise<CronJob[]> {
  return requestField(`/agents/${seg(alias)}/cron-jobs`, "jobs", { error: "Failed to list cron jobs" });
}

export async function createAgentCronJob(alias: string, job: Omit<CronJob, "id">): Promise<CronJob> {
  return requestField(`/agents/${seg(alias)}/cron-jobs`, "job", { method: "POST", json: job, error: "Failed to create cron job" });
}

export async function updateAgentCronJob(alias: string, jobId: string, updates: Partial<CronJob>): Promise<CronJob> {
  return requestField(`/agents/${seg(alias)}/cron-jobs/${seg(jobId)}`, "job", { method: "PUT", json: updates, error: "Failed to update cron job" });
}

export async function deleteAgentCronJob(alias: string, jobId: string): Promise<void> {
  await requestVoid(`/agents/${seg(alias)}/cron-jobs/${seg(jobId)}`, { method: "DELETE", error: "Failed to delete cron job" });
}

export async function runAgentCronJob(alias: string, jobId: string): Promise<CronJob> {
  return requestField(`/agents/${seg(alias)}/cron-jobs/${seg(jobId)}/run`, "job", { method: "POST", error: "Failed to run cron job" });
}

// Agent trigger API functions

export interface BacktestResult {
  totalScanned: number;
  matchCount: number;
  matches: StoredEvent[];
}

export async function getAgentTriggers(alias: string): Promise<Trigger[]> {
  return requestField(`/agents/${seg(alias)}/triggers`, "triggers", { error: "Failed to list triggers" });
}

export async function createAgentTrigger(alias: string, trigger: Omit<Trigger, "id">): Promise<Trigger> {
  return requestField(`/agents/${seg(alias)}/triggers`, "trigger", { method: "POST", json: trigger, error: "Failed to create trigger" });
}

export async function updateAgentTrigger(alias: string, triggerId: string, updates: Partial<Trigger>): Promise<Trigger> {
  return requestField(`/agents/${seg(alias)}/triggers/${seg(triggerId)}`, "trigger", { method: "PUT", json: updates, error: "Failed to update trigger" });
}

export async function deleteAgentTrigger(alias: string, triggerId: string): Promise<void> {
  await requestVoid(`/agents/${seg(alias)}/triggers/${seg(triggerId)}`, { method: "DELETE", error: "Failed to delete trigger" });
}

export async function backtestTriggerFilter(alias: string, filter: TriggerFilter, limit?: number): Promise<BacktestResult> {
  return request(`/agents/${seg(alias)}/triggers/backtest`, { method: "POST", json: { filter, limit }, error: "Failed to backtest filter" });
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
  return request(`/proxy/routes${params}`, { error: "Failed to get proxy routes" });
}

export async function getProxyIngestors(alias?: string): Promise<{ ingestors: IngestorStatus[]; configured: boolean }> {
  const params = alias ? `?alias=${encodeURIComponent(alias)}` : "";
  return request(`/proxy/ingestors${params}`, { error: "Failed to get ingestor status" });
}

export async function getProxyEvents(caller: string, limit?: number, offset?: number): Promise<{ events: StoredEvent[]; sources: string[] }> {
  const params = new URLSearchParams();
  params.append("caller", caller);
  if (limit !== undefined) params.append("limit", limit.toString());
  if (offset !== undefined) params.append("offset", offset.toString());

  return request(`/proxy/events?${params}`, { error: "Failed to get proxy events" });
}

// Agent settings API functions

export async function getAgentSettings(): Promise<AgentSettings> {
  return request("/agent-settings", { error: "Failed to get agent settings" });
}

export async function updateAgentSettings(settings: Partial<AgentSettings>): Promise<AgentSettings> {
  return request("/agent-settings", { method: "PUT", json: settings, error: "Failed to update agent settings" });
}

/**
 * The favorites pair — the only part of agent settings the New Chat launchpad
 * needs. Deliberately NOT fetched via `getAgentSettings`: that response carries
 * every credential in the install unredacted, and the launchpad asks for this
 * on every new-chat open from whatever device is on the tunnel. See the route's
 * doc-comment in `backend/src/routes/agent-settings.ts`.
 */
export interface FavoriteLists {
  favoriteSkills: string[];
  favoriteJobs: string[];
}

export async function getFavorites(): Promise<FavoriteLists> {
  return request("/agent-settings/favorites", { error: "Failed to get favorites" });
}

/**
 * Replace one or both lists. The response is the authoritative post-write pair —
 * callers adopt it rather than keeping their optimistic copy.
 *
 * NOT what a star click sends: the body has to be computed from a snapshot,
 * and a stale snapshot deletes favorites the writer never saw. See
 * {@link patchFavorites}.
 */
export async function updateFavorites(lists: Partial<FavoriteLists>): Promise<FavoriteLists> {
  return request("/agent-settings/favorites", { method: "PUT", json: lists, error: "Failed to update favorites" });
}

/** Ids to add to / remove from one favorites list. */
export interface IdDelta {
  add?: string[];
  remove?: string[];
}

/** What changed, per side. An absent side is not touched. */
export interface FavoritesDelta {
  skills?: IdDelta;
  jobs?: IdDelta;
}

/**
 * Change the favorites by naming only what changed.
 *
 * This is what a star click sends. The daemon applies the delta to the list as
 * *it* has it, so a tab holding a list from five minutes ago can no longer
 * delete an entry another tab added in the meantime — the worst it can do is
 * re-add something, which is visible and one click to undo. The response is
 * the authoritative post-write pair.
 */
export async function patchFavorites(delta: FavoritesDelta): Promise<FavoriteLists> {
  return request("/agent-settings/favorites", { method: "PATCH", json: delta, error: "Failed to update favorites" });
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
  return request("/agent-settings/remote-access-status", { error: "Failed to get remote-access status" });
}

export async function getKeyAliases(proxyMode?: "local" | "remote"): Promise<KeyAliasInfo[]> {
  const params = proxyMode ? `?proxyMode=${proxyMode}` : "";
  return requestField(`/agent-settings/key-aliases${params}`, "aliases", { error: "Failed to get key aliases" });
}

export async function testProxyConnection(url: string, alias?: string): Promise<ConnectionTestResult> {
  return request("/agent-settings/test-connection", { method: "POST", json: { url, alias }, error: "Failed to test connection" });
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
  return request("/agent-settings/daemon-status", { error: "Failed to get daemon status" });
}

// Enrolled caller management (Proxy Settings panel)

export async function getEnrolledCallers(proxyMode?: "local" | "remote"): Promise<EnrolledCaller[]> {
  const params = proxyMode ? `?proxyMode=${proxyMode}` : "";
  return requestField(`/agent-settings/callers${params}`, "callers", { error: "Failed to list enrolled callers" });
}

/**
 * Set (or clear) the default enrolled caller for regular (non-agent) sessions.
 * Pass a caller alias to make it the default, or `null` to clear it so regular
 * sessions have no MCP-proxy access. Mode defaults to the active proxy mode.
 */
export async function setDefaultCaller(alias: string | null, proxyMode?: "local" | "remote"): Promise<void> {
  const params = proxyMode ? `?proxyMode=${proxyMode}` : "";
  await requestVoid(`/agent-settings/default-caller${params}`, { method: "PUT", json: { alias }, error: "Failed to set default caller" });
}

/**
 * Delete an enrolled caller. Rejects with the server's message when the caller
 * is still bound to agents (HTTP 409) — deletion requires zero associated agents.
 */
export async function deleteEnrolledCaller(alias: string, proxyMode?: "local" | "remote"): Promise<void> {
  const params = proxyMode ? `?proxyMode=${proxyMode}` : "";
  await requestVoid(`/agent-settings/callers/${seg(alias)}${params}`, { method: "DELETE", error: "Failed to delete enrolled caller" });
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
  return request("/agent-settings/import-bundle", {
    method: "POST",
    json: { bundle, ...(passphrase ? { passphrase } : {}) },
    error: "Failed to import caller bundle",
  });
}

// Agent activity API functions

export async function getAgentActivity(alias: string, type?: string, limit?: number, offset?: number): Promise<ActivityEntry[]> {
  const params = new URLSearchParams();
  if (type) params.append("type", type);
  if (limit !== undefined) params.append("limit", limit.toString());
  if (offset !== undefined) params.append("offset", offset.toString());

  return requestField(`/agents/${seg(alias)}/activity${query(params)}`, "entries", { error: "Failed to get agent activity" });
}

// Password change API

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await requestVoid("/auth/change-password", { method: "POST", json: { currentPassword, newPassword }, error: "Failed to change password" });
}

// API keys (bearer tokens for external integrations)

export async function listApiKeys(): Promise<ApiKeyInfo[]> {
  return requestField("/api-keys", "keys", { error: "Failed to load API keys" });
}

export async function createApiKey(name: string, description: string, expiresAt: number | null): Promise<{ key: ApiKeyInfo; token: string }> {
  return request("/api-keys", { method: "POST", json: { name, description, expiresAt }, error: "Failed to create API key" });
}

export async function deleteApiKey(id: string): Promise<void> {
  await requestVoid(`/api-keys/${seg(id)}`, { method: "DELETE", error: "Failed to revoke API key" });
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
  return request("/auth/claude-status", { error: "Failed to check Claude status" });
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
   * Which **native** credential source backs Codex ("auth.json", "config.toml",
   * api key, or `null` for none).
   *
   * Narrower than `codexConfigured`, deliberately: OpenRouter routing forces
   * that flag true so the New Chat gate lets Codex through on an OpenRouter key
   * alone, and this field is what says whether there is also a ChatGPT login to
   * switch back to. `null` alongside `codexConfigured: true` means routing is
   * carrying it — see `codexAuthNote`.
   */
  codexAuthSource?: "api-key" | "auth.json" | "config.toml" | null;
  /**
   * What is authenticating Codex while OpenRouter routing is in effect.
   *
   * Present whenever routing is on, *including* alongside a real
   * `codexAuthSource`: those answer different questions — what is running now
   * against what switching back would land on — and a routed user who also has
   * a ChatGPT login is entitled to see both. Only its pairing with
   * `codexAuthSource: null` is the "why is `codexConfigured` true, then?" case.
   *
   * Absent when nothing is routed, and on servers older than the Credentials
   * control.
   */
  codexAuthNote?: string;
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
  const data = await request<EngineStatusResponse>(`/engines${refresh ? "?refresh=1" : ""}`, { error: "Failed to get engine status" });
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
  const data = await request<EngineBinaryCheckResponse>(`/engines/binary-check?${query.toString()}`, { signal, error: "Failed to check the binary path" });
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
  const data = await request<EngineRefreshResponse>("/engines/refresh", { method: "POST", error: "Failed to re-check engine status" });
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
  return request(`/engines/${seg(engineId)}/install`, { method: "POST", error: "Failed to start the install" });
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
  const res = await fetch(`${BASE}/engines/installs/${seg(installId)}/stream`, { credentials: "include", signal });
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
  return request(`/acp/models?providerId=${encodeURIComponent(providerId)}`, { error: "Failed to get ACP models" });
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
  return request("/cline/providers", { error: "Failed to get Cline providers" });
}

/**
 * Models for one Cline provider.
 *
 * An empty list means the provider could not be reached, not that it has no
 * models — every model field accepts free text, so the picker degrades to an
 * input rather than blocking.
 */
export async function getClineModels(providerId: string): Promise<{ providerId: string; models: ClineModelInfo[] }> {
  return request(`/cline/models?providerId=${encodeURIComponent(providerId)}`, { error: "Failed to get Cline models" });
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
  return request("/pi/providers", { error: "Failed to get pi providers" });
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
  return request(`/pi/models?providerId=${encodeURIComponent(providerId)}`, { error: "Failed to get pi models" });
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
  const inFlight = (async () => {
    const info = await request<SystemInfo>("/system-info", { error: "Failed to get system info" });
    if (seq > systemInfoLatestWritten) {
      systemInfoLatestWritten = seq;
      systemInfoCache = info;
    }
    return info;
  })().finally(() => {
    if (systemInfoInFlight === inFlight) systemInfoInFlight = null;
  });
  systemInfoInFlight = inFlight;
  return inFlight;
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

export async function getCodexModels(): Promise<CodexModelInfo[]> {
  const data = await request<{ models?: CodexModelInfo[] }>("/codex/models", { error: "Failed to get Codex models" });
  return Array.isArray(data.models) ? data.models : [];
}

/**
 * The OpenRouter model catalog. `aliases` is always empty: the route stopped
 * serving the deprecated OpenRouter-only aliases (#465), whose `openrouter`
 * target resolves nowhere. It is read here only so the type stays honest.
 */
export async function getOpenRouterCatalog(): Promise<{ models: OpenRouterModelInfo[]; aliases: OpenRouterModelAliasInfo[] }> {
  const data = await request<{ models?: OpenRouterModelInfo[]; aliases?: OpenRouterModelAliasInfo[] }>("/openrouter/models", {
    error: "Failed to get OpenRouter models",
  });
  return {
    models: Array.isArray(data.models) ? data.models : [],
    aliases: Array.isArray(data.aliases) ? data.aliases : [],
  };
}

// Instance name API

export async function fetchInstanceName(): Promise<string> {
  return requestField("/instance-name", "name", { error: "Failed to fetch instance name" });
}

export async function updateInstanceName(name: string): Promise<string> {
  return requestField("/instance-name", "name", { method: "PUT", json: { name }, error: "Failed to update instance name" });
}

export async function randomizeInstanceName(): Promise<string> {
  return requestField("/instance-name/randomize", "name", { method: "POST", error: "Failed to randomize instance name" });
}

// Ignored project directories API

export interface IgnoredProjectDirsResponse {
  prefixes: string[];
  defaults: string[];
}

export async function fetchIgnoredProjectDirs(): Promise<IgnoredProjectDirsResponse> {
  return request("/ignored-project-dirs", { error: "Failed to fetch ignored project directories" });
}

export async function updateIgnoredProjectDirs(prefixes: string[]): Promise<IgnoredProjectDirsResponse> {
  return request("/ignored-project-dirs", { method: "PUT", json: { prefixes }, error: "Failed to update ignored project directories" });
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
  return request("/user-contact", { error: "Failed to fetch contact info" });
}

/**
 * Read contact-channel availability. `refresh` bypasses the backend's cached
 * route listing (a live daemon call) — for an explicit user gesture only.
 */
export async function fetchUserContactAvailability(opts?: { refresh?: boolean }): Promise<UserContactAvailability> {
  return request(`/user-contact/availability${opts?.refresh ? "?refresh=1" : ""}`, { error: "Failed to fetch contact channel availability" });
}

export async function updateUserContact(info: UserContactInfo): Promise<UserContactInfo> {
  return request("/user-contact", { method: "PUT", json: info, error: "Failed to update contact info" });
}

// ── Themes ──────────────────────────────────────────────────────────

export async function listThemes(): Promise<ThemeListItem[]> {
  return requestField("/themes", "themes", { error: "Failed to list themes" });
}

export async function getTheme(name: string): Promise<CustomTheme> {
  return requestField(`/themes/${seg(name)}`, "theme", { error: "Failed to get theme" });
}

export async function generateTheme(name: string, description: string): Promise<CustomTheme> {
  return requestField("/themes/generate", "theme", { method: "POST", json: { name, description }, error: "Failed to generate theme" });
}

export async function deleteTheme(name: string): Promise<void> {
  await requestVoid(`/themes/${seg(name)}`, { method: "DELETE", error: "Failed to delete theme" });
}

// ── Custom Skills ───────────────────────────────────────────────────

export async function listCustomSkills(): Promise<CustomSkillListItem[]> {
  return requestField("/custom-skills", "skills", { error: "Failed to list skills" });
}

export async function getCustomSkill(name: string): Promise<CustomSkill> {
  return requestField(`/custom-skills/${seg(name)}`, "skill", { error: "Failed to get skill" });
}

export async function createCustomSkill(skill: { name: string; description: string; content: string }): Promise<CustomSkill> {
  return requestField("/custom-skills", "skill", { method: "POST", json: skill, error: "Failed to create skill" });
}

export async function updateCustomSkill(originalName: string, updates: { name?: string; description?: string; content?: string }): Promise<CustomSkill> {
  return requestField(`/custom-skills/${seg(originalName)}`, "skill", { method: "PUT", json: updates, error: "Failed to update skill" });
}

export async function deleteCustomSkill(name: string): Promise<void> {
  await requestVoid(`/custom-skills/${seg(name)}`, { method: "DELETE", error: "Failed to delete skill" });
}

// ── Keywords ─────────────────────────────────────────────────────────

export async function listKeywords(): Promise<Keyword[]> {
  return requestField("/keywords", "keywords", { error: "Failed to list keywords" });
}

export async function createKeyword(keyword: { name: string; description?: string; body: string }): Promise<Keyword> {
  return requestField("/keywords", "keyword", { method: "POST", json: keyword, error: "Failed to create keyword" });
}

export async function updateKeyword(originalName: string, updates: { name?: string; description?: string; body?: string }): Promise<Keyword> {
  return requestField(`/keywords/${seg(originalName)}`, "keyword", { method: "PUT", json: updates, error: "Failed to update keyword" });
}

export async function deleteKeyword(name: string): Promise<void> {
  await requestVoid(`/keywords/${seg(name)}`, { method: "DELETE", error: "Failed to delete keyword" });
}

// ── MCP Tools ────────────────────────────────────────────────────────

export async function getMcpTools(context?: "chat" | "agent"): Promise<McpToolsResponse> {
  const params = context ? `?context=${context}` : "";
  return request(`/mcp-tools${params}`, { error: "Failed to get MCP tools" });
}

// ── Jobs ─────────────────────────────────────────────────────────────

export async function listJobs(): Promise<JobDefinition[]> {
  return requestField("/jobs", "jobs", { error: "Failed to list jobs" });
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
  return requestField("/jobs", "job", { method: "POST", json: payload, error: "Failed to create job" });
}

export async function updateJob(id: string, payload: JobDefinitionPayload): Promise<JobDefinition> {
  return requestField(`/jobs/${seg(id)}`, "job", { method: "PUT", json: payload, error: "Failed to update job" });
}

export async function deleteJob(id: string): Promise<void> {
  await requestVoid(`/jobs/${seg(id)}`, { method: "DELETE", error: "Failed to delete job" });
}

// Job export/import API functions

export function getJobExportUrl(id: string): string {
  return `${BASE}/jobs/${seg(id)}/export`;
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
  return requestField(`/jobs/${seg(id)}/spawn`, "run", { method: "POST", json: { inputs }, error: "Failed to spawn job" });
}

export async function listJobRuns(filter?: { jobId?: string; status?: JobRunStatus; limit?: number }): Promise<JobRunListItem[]> {
  const params = new URLSearchParams();
  if (filter?.jobId) params.set("jobId", filter.jobId);
  if (filter?.status) params.set("status", filter.status);
  if (filter?.limit) params.set("limit", String(filter.limit));
  return requestField(`/jobs/runs${query(params)}`, "runs", { error: "Failed to list job runs" });
}

export async function getJobRun(runId: string): Promise<JobRun> {
  return requestField(`/jobs/runs/${seg(runId)}`, "run", { error: "Failed to get job run" });
}

async function postJobRunAction(runId: string, action: string, body?: unknown): Promise<JobRun> {
  return requestField(`/jobs/runs/${seg(runId)}/${action}`, "run", { method: "POST", json: body, error: `Failed to ${action} job run` });
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
  return request(`/workspaces?${params}`, { error: "Failed to list workspaces" });
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
  const body = await request<WorkspaceRemovabilityResponse>(`/workspaces/${seg(id)}/removability`, { error: "Failed to evaluate the workspace" });
  return body.workspace;
}

/** Read-only discovery. Creates no record and writes nothing. */
export async function listUnmanagedWorktrees(repoPath: string, includeDiskUsage = true): Promise<UnmanagedWorktreeListing> {
  const params = new URLSearchParams({ repoPath });
  if (!includeDiskUsage) params.append("includeDiskUsage", "false");
  return request(`/workspaces/unmanaged?${params}`, { error: "Failed to list unmanaged worktrees" });
}

/**
 * Adopt the named worktrees. Paths only — never a filter, never a pattern.
 *
 * The backend cannot tell "a human chose this path" from "an agent generated
 * it", which is Phase 2b's stated limitation; the confirmation step in front of
 * this call is where that gap is closed, so nothing may call it without one.
 */
export async function adoptWorktrees(paths: string[]): Promise<AdoptWorktreesResult> {
  return request("/workspaces/adopt", { method: "POST", json: { paths }, error: "Failed to adopt worktrees" });
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
  return requestField(`/workspaces/${seg(id)}/rename`, "workspace", { method: "POST", json: { name }, error: "Failed to rename workspace" });
}

/** Archive one workspace, quarantining its worktree only if every gate passes. */
export async function archiveWorkspace(id: string): Promise<ArchiveWorkspaceResult> {
  return request(`/workspaces/${seg(id)}/archive`, { method: "POST", error: "Failed to archive workspace" });
}

export async function listTrash(includeDiskUsage = true): Promise<TrashListing> {
  const params = new URLSearchParams();
  if (includeDiskUsage) params.append("includeDiskUsage", "true");
  return request(`/workspaces/trash${query(params)}`, { error: "Failed to list trash" });
}

/**
 * Restore a quarantined worktree.
 *
 * A refusal comes back as HTTP 409 with a `TrashRestoreResult` body rather than
 * an error, because the refusal *is* the answer the caller wants — and every
 * refusal leaves the trash entry intact.
 */
export async function restoreTrashEntry(entry: string): Promise<TrashRestoreResult> {
  const res = await fetch(`${BASE}/workspaces/trash/${seg(entry)}/restore`, { method: "POST", credentials: "include" });
  if (res.status === 409) return res.json();
  await assertOk(res, "Failed to restore trash entry");
  return res.json();
}

/** Resolved by the same backend routing/model defaults used for execution. */
export async function getReasoningCapability(provider: string, model: string, cwd?: string): Promise<ReasoningCapability> {
  const params = new URLSearchParams({ provider, model });
  if (cwd) params.set("cwd", cwd);
  const data = await request<ReasoningCapability | null>(`/codex/reasoning?${params}`, { error: "Failed to get reasoning capabilities" });
  if (
    !data ||
    !Array.isArray(data.efforts) ||
    !data.efforts.every((effort: unknown) => typeof effort === "string") ||
    (data.status !== "known" && data.status !== "unknown")
  ) {
    throw new Error("Invalid reasoning capability response");
  }
  return data;
}

// ── Storage ─────────────────────────────────────────────────────────
//
// Key-catalogued named buckets of flat items (plan §2).

export type {
  StorageItem,
  StorageKeySummary,
  StorageKeyDetail,
  ArtifactStorageAccess,
  Artifact,
  ArtifactSummary,
  ArtifactVersion,
  ArtifactContentType,
  RenderArtifactToolResult,
  ArtifactBridgeHello,
  ArtifactBridgeInit,
  ArtifactBridgeOp,
  ArtifactBridgeRequest,
  ArtifactBridgeReply,
  ArtifactBridgeReady,
} from "shared/types/index.js";

export {
  ARTIFACT_BRIDGE_LIMITS,
  ARTIFACT_BRIDGE_READ_RECHECK_MS,
  ARTIFACT_BRIDGE_WRITE_RECHECK_MS,
  ARTIFACT_BRIDGE_TOKEN_PATTERN,
  ARTIFACT_RENDER_SHA256_PATTERN,
  ARTIFACT_ID_PATTERN,
  STORAGE_ITEM_MIME_HEADER,
  STORAGE_MAX_ITEM_BYTES,
  isValidStorageItemName,
  isValidStorageKey,
  minArtifactStorageAccess,
} from "shared/types/index.js";

/** Same-origin URL of one stored item's raw bytes (inline only for raster images and text/plain). */
export function storageItemUrl(key: string, name: string): string {
  return `${BASE}${storageItemPath(key, name)}`;
}

function storageItemPath(key: string, name: string): string {
  return `/storage/${seg(key)}/items/${seg(name)}`;
}

export async function listStorageKeys(): Promise<StorageKeySummary[]> {
  return requestField("/storage", "keys", { error: "Failed to list storage keys" });
}

export async function createStorageKey(key: string, description?: string): Promise<StorageKeyDetail> {
  return requestField("/storage", "key", { method: "POST", json: { key, description }, error: "Failed to create storage key" });
}

export async function getStorageKey(key: string): Promise<StorageKeyDetail> {
  return requestField(`/storage/${seg(key)}`, "key", { error: "Failed to get storage key" });
}

export async function updateStorageKey(key: string, description: string): Promise<StorageKeyDetail> {
  return requestField(`/storage/${seg(key)}`, "key", { method: "PATCH", json: { description }, error: "Failed to update storage key" });
}

export async function deleteStorageKey(key: string): Promise<void> {
  await requestVoid(`/storage/${seg(key)}`, { method: "DELETE", error: "Failed to delete storage key" });
}

/** The raw response for one item; callers pick `.text()` or `.blob()`. */
export async function fetchStorageItem(key: string, name: string): Promise<Response> {
  return send(storageItemPath(key, name), { error: "Failed to read storage item" });
}

/**
 * Create or overwrite one item. Exactly one of `content` (utf-8) or
 * `content_base64` travels as JSON; a `File`/`Blob` goes up as multipart `file`.
 * Resolves to the saved item's meta (`{ item }`).
 */
export async function putStorageItem(key: string, name: string, body: PutStorageItemJsonBody | { file: Blob }): Promise<StorageItem> {
  let payload: Pick<RequestOptions, "json" | "body">;
  if ("file" in body) {
    const form = new FormData();
    form.append("file", body.file, name);
    payload = { body: form };
  } else {
    payload = { json: body };
  }
  return requestField(storageItemPath(key, name), "item", { method: "PUT", ...payload, error: "Failed to save storage item" });
}

export async function deleteStorageItem(key: string, name: string): Promise<void> {
  await requestVoid(storageItemPath(key, name), { method: "DELETE", error: "Failed to delete storage item" });
}

// ── Artifacts ───────────────────────────────────────────────────────
//
// Named, versioned single-file apps rendered in a sandboxed iframe (plan §3).

/**
 * The served document for one version — the only thing an artifact iframe may
 * load. `bridgeToken` (HTML only) is the mount's bridge token; the server
 * injects it into the shim of that one response.
 */
/**
 * The served document of one artifact version. A framed HTML render passes its
 * bridge token AND the sha256 it checked: the route refuses to serve bytes that
 * no longer hash to it (and requires it alongside a token).
 */
export function artifactRenderUrl(id: string, version: number, pin?: { bridgeToken?: string; sha256: string }): string {
  const url = `${BASE}/artifacts/${seg(id)}/versions/${seg(version)}/render`;
  if (!pin) return url;
  const bridge = pin.bridgeToken === undefined ? "" : `bridge=${encodeURIComponent(pin.bridgeToken)}&`;
  return `${url}?${bridge}sha256=${encodeURIComponent(pin.sha256)}`;
}

/** Summaries only — no version list; `getArtifact` for that. */
export async function listArtifacts(): Promise<ArtifactSummary[]> {
  return requestField("/artifacts", "artifacts", { error: "Failed to list artifacts" });
}

export async function getArtifact(id: string): Promise<Artifact> {
  return requestField(`/artifacts/${seg(id)}`, "artifact", { error: "Failed to get artifact" });
}

export async function createArtifact(input: CreateArtifactInput): Promise<Artifact> {
  return requestField("/artifacts", "artifact", { method: "POST", json: input, error: "Failed to create artifact" });
}

export async function updateArtifact(id: string, updates: UpdateArtifactInput): Promise<Artifact> {
  return requestField(`/artifacts/${seg(id)}`, "artifact", { method: "PATCH", json: updates, error: "Failed to update artifact" });
}

export async function deleteArtifact(id: string): Promise<void> {
  await requestVoid(`/artifacts/${seg(id)}`, { method: "DELETE", error: "Failed to delete artifact" });
}

export async function saveArtifactVersion(id: string, content: string, note?: string): Promise<Artifact> {
  return requestField(`/artifacts/${seg(id)}/versions`, "artifact", { method: "POST", json: { content, note }, error: "Failed to save artifact version" });
}

/** One version's source as text — never executed, only shown or fed to MarkdownRenderer. */
/** `sha256` pins the bytes: the server answers 409 if the version no longer hashes to it. */
export async function getArtifactVersionSource(id: string, version: number, sha256?: string): Promise<string> {
  const pin = sha256 === undefined ? "" : `?sha256=${encodeURIComponent(sha256)}`;
  const res = await send(`/artifacts/${seg(id)}/versions/${seg(version)}${pin}`, { error: "Failed to read artifact version" });
  return res.text();
}
