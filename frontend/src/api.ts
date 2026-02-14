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
  SessionStatus,
  BranchConfig,
  FolderItem,
  BrowseResult,
  ValidateResult,
  FolderSuggestion,
  GitDiffResponse,
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
  SessionStatus,
  BranchConfig,
  FolderItem,
  BrowseResult,
  ValidateResult,
  FolderSuggestion,
  GitDiffResponse,
};

const BASE = "/api";

/** Shared error handler: throws with the server's error message or a fallback. */
async function assertOk(res: Response, fallback: string): Promise<void> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || fallback);
  }
}

export async function listChats(limit?: number, offset?: number): Promise<ChatListResponse> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.append("limit", limit.toString());
  if (offset !== undefined) params.append("offset", offset.toString());

  const res = await fetch(`${BASE}/chats${params.toString() ? `?${params}` : ""}`);
  await assertOk(res, "Failed to list chats");
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

export async function getSessionStatus(id: string): Promise<SessionStatus> {
  const res = await fetch(`${BASE}/chats/${id}/status`, { credentials: "include" });
  await assertOk(res, "Failed to get session status");
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

export async function deleteDraft(id: string): Promise<void> {
  const res = await fetch(`${BASE}/queue/${id}`, { method: "DELETE" });
  await assertOk(res, "Failed to delete draft");
}

export async function executeDraft(id: string): Promise<void> {
  const res = await fetch(`${BASE}/queue/${id}/execute-now`, { method: "POST" });
  await assertOk(res, "Failed to execute draft");
}

export async function getSlashCommandsAndPlugins(chatId: string): Promise<{ slashCommands: string[]; plugins: Plugin[] }> {
  const res = await fetch(`${BASE}/chats/${chatId}/slash-commands`);
  await assertOk(res, "Failed to get slash commands");
  const data = await res.json();
  return {
    slashCommands: data.slashCommands || [],
    plugins: data.plugins || [],
  };
}

// Branch / worktree configuration
export async function getGitBranches(folder: string): Promise<{ branches: string[] }> {
  const res = await fetch(`${BASE}/git/branches?folder=${encodeURIComponent(folder)}`);
  await assertOk(res, "Failed to list branches");
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
