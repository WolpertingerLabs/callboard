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
}
