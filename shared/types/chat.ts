import type { SlashCommand } from "./slashCommand.js";
import type { Plugin } from "./plugins.js";

export interface Chat {
  id: string;
  /** The actual working directory (may be a worktree). Logs are stored under this path. */
  folder: string;
  /** Resolved main repo path for display/grouping (equals folder when not a worktree). */
  displayFolder?: string;
  session_id: string;
  session_log_path: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
  // Augmented fields (added at API response time)
  is_git_repo?: boolean;
  git_branch?: string;
  slash_commands?: SlashCommand[];
  plugins?: Plugin[];
  /**
   * True when the chat was returned beyond the pagination window because it
   * belongs to a parentage tree touched by the page (includeLineage=true).
   * Such chats don't count toward pagination offsets.
   */
  _lineage_appended?: boolean;
}

export interface ChatListResponse {
  chats: Chat[];
  hasMore: boolean;
  total: number;
  stale?: boolean;
}

export interface FolderSummary {
  /** Actual folder path (worktrees stay separate) */
  folder: string;
  /** Last path segment for display */
  displayName: string;
  /** ID of the most recently created chat in this folder */
  mostRecentChatId: string;
  /** When the most recent chat was created (ISO) */
  mostRecentChatCreatedAt: string;
  /** Latest updated_at across all chats in this folder (ISO) */
  lastUpdatedAt: string;
  /** Folder status based on most recent chat */
  status: "ongoing" | "waiting" | "stopped";
  isGitRepo: boolean;
  /** True when the folder is a git worktree rather than the main repo checkout. */
  isWorktree: boolean;
  gitBranch?: string;
  /** Whether the most recent chat was triggered */
  isTriggered: boolean;
  /** How the most recent chat was triggered (for icon distinction) */
  triggeredBy?: "cron" | "event" | "trigger" | "tool" | "job";
  /** Total number of chats in this folder */
  chatCount: number;
  /** Custom status label set by agent on most recent chat */
  chatStatus?: string;
  /** Emoji prefix for the custom status */
  chatStatusEmoji?: string;
  /** Whether any chat in this folder has an active summon */
  hasSummon?: boolean;
  /** Custom title set by agent on most recent chat */
  chatTitle?: string;
  /** Provider of the most recent chat ("openrouter"); absent means Claude Code. */
  mostRecentChatProvider?: string;
}

export interface FolderListResponse {
  folders: FolderSummary[];
}

// ── Chat parentage tree ─────────────────────────────────────────────
// Chats spawned by other chats (start_chat_session, forks, engine
// switches) carry `parentChatId` / `rootChatId` / `chatRole` in their
// metadata, forming cross-engine trees. These types describe the
// assembled tree served by GET /api/chats/:id/tree and the
// get_chat_tree MCP tool.

export interface ChatTreeAncestor {
  chatId: string;
  title: string | null;
  /** Free-form role label (e.g. "subagent", "monitor", "router", "fork"). */
  role?: string;
}

export interface ChatTreeNode {
  chatId: string;
  title: string | null;
  /** Free-form role label (e.g. "subagent", "monitor", "router", "fork"). */
  role?: string;
  /** "claude-code" | "openrouter" | "codex" */
  provider: string;
  status: "ongoing" | "waiting" | "stopped";
  chatStatus?: string;
  chatStatusEmoji?: string;
  folder: string;
  createdAt: string;
  updatedAt: string;
  children: ChatTreeNode[];
}

export interface ChatTreeResponse {
  /** The chat the tree was requested for. */
  targetChatId: string;
  /** Highest existing ancestor of the target chat. */
  rootChatId: string;
  /** Ancestors of the target, ordered root-first (empty when target is the root). */
  ancestors: ChatTreeAncestor[];
  /** Full tree rooted at rootChatId. */
  tree: ChatTreeNode;
}
