import type { SlashCommand } from "./slashCommand.js";
import type { Plugin } from "./plugins.js";

export interface Chat {
  id: string;
  /** The actual working directory (may be a worktree). Logs are stored under this path. */
  folder: string;
  /** Resolved main repo path for display/grouping (equals folder when not a worktree). */
  displayFolder?: string;
  /**
   * The {@link Workspace} this chat runs in, when one was recorded.
   *
   * OPAQUE — never parse it back into a path. `folder`/`displayFolder` above
   * stay the truth for log paths, and most chats (everything predating the
   * entity, and every non-worktree chat) have no workspaceId at all, so
   * nothing may depend on its presence. Where a read could consult either,
   * the workspace wins when present and the path fields are the fallback.
   */
  workspaceId?: string;
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
  /**
   * True when the chat's lineage root is archived — a closed or hidden card,
   * or, for a tree whose root is not a card (triggered, job step), the root's
   * `metadata.treeArchived` flag. Computed per `GET /api/chats` response, never
   * stored on this record, and only on requests that also ask for
   * `includeLineage` or a `cardLifecycle` scope (the sidebar always does).
   * Absent means not archived — or not computed.
   */
  archived?: boolean;
}

export interface ChatListResponse {
  chats: Chat[];
  hasMore: boolean;
  total: number;
  /**
   * Pagination units consumed by this page: raw chats normally, sidebar
   * tree rows when includeLineage folds parentage groups. Advance paging
   * offsets by this rather than counting the returned chats.
   */
  windowRows: number;
  stale?: boolean;
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

export interface NativeCodexAgent {
  parentThreadId: string;
  /** Chat id of the parent as inferred from the rollout, when the parent has a stored chat and no explicit parentage overrides it. */
  inferredParentChatId?: string;
  nickname?: string;
  agentPath?: string;
  role?: string;
  depth?: number;
  lifecycle: "active" | "complete" | "unknown" | "error" | "interrupted";
  management: "read-only";
  controlNote: string;
  evidence?: string;
}

export interface ChatTreeNode {
  /** Additive: old clients retain the existing coarse status field. */
  nativeAgent?: NativeCodexAgent;
  chatId: string;
  title: string | null;
  /** Free-form role label (e.g. "subagent", "monitor", "router", "fork"). */
  role?: string;
  /** "claude-code" | "codex" | "acp" | "cline" | "pi" */
  provider: string;
  /** Which ACP vendor, when `provider` is `"acp"`. Absent otherwise. */
  acpProviderId?: string;
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
