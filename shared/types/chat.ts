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
  gitBranch?: string;
  /** Whether the most recent chat was triggered */
  isTriggered: boolean;
  /** How the most recent chat was triggered (for icon distinction) */
  triggeredBy?: "cron" | "event" | "trigger" | "tool";
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
}

export interface FolderListResponse {
  folders: FolderSummary[];
}
