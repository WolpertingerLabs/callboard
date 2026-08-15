import type { SlashCommand } from "./slashCommand.js";
import type { Plugin } from "./plugins.js";
import type { FolderWorkspaceRecord, WorkspaceDirectoryState, WorktreeDiskUsage } from "./workspace.js";

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

/**
 * One sidebar row: a **directory workspace**.
 *
 * The row is keyed by `folder` — the directory work happens in — and a
 * {@link Workspace} record supplies its identity when one claims that
 * directory. Where no record exists (the overwhelming majority: workspace
 * records are only written when a chat starts in a worktree), the row is a
 * *synthesised* directory workspace with the same shape and no persisted
 * state. The projection is uniform either way; see
 * `backend/src/services/workspace-views.ts`.
 *
 * Row membership is deliberately **not** keyed on the chat's own
 * `workspaceId`. A chat's `workspaceId` is provenance — it records which
 * workspace it was started under — and using it to group would split a
 * directory's chats across two identically-named rows for as long as most
 * chats predate the entity. Workspace-owned *state* keys on `workspaceId`;
 * the directory listing keys on the directory. See the keying rule in
 * `.claude/CLAUDE.md`.
 */
export interface FolderSummary {
  /** Actual folder path (worktrees stay separate) */
  folder: string;
  /**
   * What to call this row.
   *
   * The {@link Workspace} record's `name` when **exactly one** active record
   * claims the directory — the same condition under which {@link workspaceId}
   * is unambiguous — and the directory's last path segment otherwise. A record
   * that was never renamed holds the basename anyway, so the two agree for
   * everything except a workspace somebody deliberately named.
   *
   * A directory with several records keeps the path segment on purpose: the row
   * is per-directory, so showing one of two distinct names would label the row
   * with a record the user is not acting on. Per-record names live in the
   * drill-down.
   */
  displayName: string;
  /**
   * The {@link Workspace} record claiming this directory, when exactly one
   * active record does. OPAQUE — never parse it back into a path.
   *
   * Absent when no record claims the directory (a synthesised directory
   * workspace) *or* when several do — in the latter case `workspaceCount`
   * says how many. Nothing may depend on its presence.
   */
  workspaceId?: string;
  /**
   * Number of active workspace records on this directory, present only when
   * more than one. Multiple workspaces sharing a `cwd` is a supported state,
   * not a bug; rendering them as separate rows is Phase 4's job, so this
   * phase reports the count and declines to pick an id.
   */
  workspaceCount?: number;
  /**
   * The main checkout this directory belongs to, when `isWorktree`. Comes
   * from the workspace record when one exists, and from resolving the `.git`
   * file otherwise.
   */
  repoPath?: string;
  /** ID of the most recently created chat in this folder */
  mostRecentChatId: string;
  /** When the most recent chat was created (ISO) */
  mostRecentChatCreatedAt: string;
  /** Latest updated_at across all chats in this folder (ISO) */
  lastUpdatedAt: string;
  /** Folder status based on most recent chat */
  status: "ongoing" | "waiting" | "stopped";
  isGitRepo: boolean;
  /**
   * True when the folder is a git worktree rather than the main repo checkout.
   *
   * Read from the workspace record when one claims this directory, and from
   * the `.git` file otherwise. Note that a record's `isolation: "worktree"`
   * alone does **not** mean this: `ensureWorktreeDetailed` hands back the main
   * checkout when the requested branch is already checked out there, so a
   * record can say "worktree" about a directory that is the main repo. The
   * record is only believed when its `repoPath` names a *different*
   * directory.
   */
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
  /** Provider of the most recent chat ("codex", "cline", …); absent means Claude Code. */
  mostRecentChatProvider?: string;
  /**
   * Which ACP vendor runs the most recent chat, when its provider is `"acp"`.
   * The kind alone does not name a harness — "acp" is a wire format that every
   * vendor speaks — so the badge needs this to say "OC" rather than "ACP".
   */
  mostRecentChatAcpProviderId?: string;
  /**
   * The active workspace records claiming this directory, cheapest-fields-only
   * (Phase 4a). Absent when none do — most directories. Length is the count
   * the row renders; the array is what a drill-down iterates.
   *
   * Carries no removal verdict on purpose: that costs several git subprocesses
   * per record and this listing is polled. See {@link FolderWorkspaceRecord}.
   */
  workspaces?: FolderWorkspaceRecord[];
  /**
   * The worst directory state across {@link workspaces} — `missing` beats
   * `not-a-worktree` beats `present`. Absent when no record claims the
   * directory, which is also the only case in which the row is guaranteed to
   * exist on disk.
   */
  directoryState?: WorkspaceDirectoryState;
  /** Explains {@link directoryState}. Safe to surface directly. */
  directoryDetail?: string;
  /**
   * Approximate size on disk. **Opt-in** — a listing only measures it when the
   * caller passes `includeDiskUsage`, because `du` is the slow part and this
   * endpoint backs a sidebar that re-polls.
   */
  diskUsage?: WorktreeDiskUsage;
}

export interface FolderListResponse {
  folders: FolderSummary[];
  /** Set when the disk-usage budget ran out before every row was measured. */
  diskUsageNote?: string;
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
