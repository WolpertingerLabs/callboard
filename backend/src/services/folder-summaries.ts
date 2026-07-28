/**
 * The sidebar's folder list, as a pure projection.
 *
 * Extracted from the `GET /api/chats/folders` handler so the invariant that
 * matters can actually be tested: **no chat may disappear.** Every discovered
 * session inside the age window whose directory still exists lands in exactly
 * one row, and `chatCount` over all rows equals the number of such sessions.
 * That is asserted directly in folder-summaries.test.ts over a mix of
 * worktrees with records, worktrees without, plain folders, and folders that
 * are gone from disk.
 *
 * Everything that touches the world — the registry, git, the session registry,
 * the chat file store, `existsSync` — arrives as a dependency. The route
 * supplies the real ones.
 */
import type { FolderSummary } from "shared";
import type { WorkspaceIndex } from "./workspace-views.js";
import { viewForDirectory } from "./workspace-views.js";

/** A session as `discoverSessionsPaginated` reports it. */
export interface DiscoveredSession {
  sessionId: string;
  folder: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FolderSummaryDeps {
  /** Oldest `createdAt` a session may have and still be listed. */
  cutoff: Date;
  /** Active workspace records, indexed by directory. */
  workspaces: WorkspaceIndex;
  /**
   * Does the directory still exist?
   *
   * Rows for directories that are gone are dropped, exactly as before this
   * phase — 263 of 324 folders on this machine are in that state and have
   * never been listed. Dropping them is pre-existing behaviour, not something
   * the workspace projection introduces, and the registry going stale (6 of 9
   * records point at removed directories) must not resurrect them as rows
   * pointing nowhere.
   */
  directoryExists(folder: string): boolean;
  /** Parsed metadata of a chat, or `{}` when there is no stored record. */
  chatMetadata(sessionId: string): Record<string, any>;
  isOngoing(sessionId: string): boolean;
  isWaiting(sessionId: string): boolean;
  gitInfo(folder: string): { isGitRepo: boolean; branch?: string };
}

export function buildFolderSummaries(sessions: DiscoveredSession[], deps: FolderSummaryDeps): FolderSummary[] {
  // Group by directory. The chat's own `workspaceId` deliberately plays no
  // part here — see the header of workspace-views.ts for why grouping on it
  // splits a directory's chats across identically-named rows.
  const byFolder = new Map<string, DiscoveredSession[]>();
  for (const session of sessions) {
    if (session.createdAt < deps.cutoff) continue;
    const group = byFolder.get(session.folder);
    if (group) group.push(session);
    else byFolder.set(session.folder, [session]);
  }

  const folders: FolderSummary[] = [];

  for (const [folder, chats] of byFolder) {
    if (!deps.directoryExists(folder)) continue;

    // Sort by created_at descending to find most recent
    chats.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const mostRecent = chats[0];

    // Find latest updated_at across all chats
    const lastUpdatedAt = chats.reduce((latest, c) => (c.updatedAt > latest ? c.updatedAt : latest), chats[0].updatedAt);

    const metadata = deps.chatMetadata(mostRecent.sessionId);

    // Determine status
    let status: "ongoing" | "waiting" | "stopped" = "stopped";
    if (deps.isOngoing(mostRecent.sessionId)) {
      status = "ongoing";
    } else if (deps.isWaiting(mostRecent.sessionId)) {
      status = "waiting";
    }

    const gitInfo = deps.gitInfo(folder);
    // Workspace identity and worktree-ness: the record when one claims this
    // directory, the `.git` file otherwise.
    const view = viewForDirectory(folder, deps.workspaces);

    // Extract folder display name (last path segment)
    const displayName = folder.split("/").pop() || folder;

    folders.push({
      folder,
      displayName,
      ...(view.workspaceId && { workspaceId: view.workspaceId }),
      ...(view.workspaceCount && { workspaceCount: view.workspaceCount }),
      ...(view.repoPath && { repoPath: view.repoPath }),
      mostRecentChatId: mostRecent.sessionId,
      mostRecentChatCreatedAt: mostRecent.createdAt.toISOString(),
      lastUpdatedAt: lastUpdatedAt.toISOString(),
      status,
      isGitRepo: gitInfo.isGitRepo,
      isWorktree: view.isWorktree,
      gitBranch: gitInfo.branch,
      isTriggered: !!metadata.triggered,
      triggeredBy: metadata.triggeredBy,
      chatCount: chats.length,
      chatStatus: metadata.chatStatus || undefined,
      chatStatusEmoji: metadata.chatStatusEmoji || undefined,
      hasSummon: !!metadata.summon,
      chatTitle: metadata.title || undefined,
      mostRecentChatProvider: metadata.provider || undefined,
    });
  }

  // Sort by last updated descending (most recently active folders first)
  folders.sort((a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());

  return folders;
}
