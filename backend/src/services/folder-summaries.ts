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
 *
 * ## Phase 4a: the row carries what a cleanup decision needs
 *
 * The rows gain the registry's view of each directory — which records claim it,
 * whether Callboard owns the worktree, whether the directory is still there —
 * and, when the caller opts in, its size on disk. What they deliberately do
 * *not* carry is the removal verdict: `evaluateWorktreeRemoval` runs `git
 * status`, `git rev-list`, a submodule scan and a token read **per record**, and
 * this listing is polled every fifteen seconds while a session is live. The row
 * says what an `lstat` can prove and hands the rest to the management view.
 *
 * ### One deliberate change to Phase 3's row set
 *
 * Phase 3 dropped every row whose directory was gone, and tested that an active
 * record could not resurrect one. That rule is kept for directories the registry
 * does not claim — the 263-of-324 case, chats in projects deleted years ago,
 * which have never been listed and must not start being listed now.
 *
 * The exception is narrow and it is the point of this phase: a directory that
 * **an active workspace record claims** is listed even when it is gone, marked
 * `missing`. Seven of the ten real records are in that state, and they are
 * exactly the records a user needs to see in order to clean them up. The
 * property Phase 3 was protecting still holds — a record alone never creates a
 * row; there must also be a chat inside the age window — so the registry can
 * never become the row source by the back door.
 */
import type { FolderSummary, FolderWorkspaceRecord, Workspace, WorkspaceDirectory, WorkspaceDirectoryState, WorktreeDiskUsage } from "shared";
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
   * Rows for directories that are gone are dropped — 263 of 324 folders on this
   * machine are in that state and have never been listed. The single exception
   * is a directory an active workspace record claims; see the module header.
   */
  directoryExists(folder: string): boolean;
  /** Parsed metadata of a chat, or `{}` when there is no stored record. */
  chatMetadata(sessionId: string): Record<string, any>;
  isOngoing(sessionId: string): boolean;
  isWaiting(sessionId: string): boolean;
  gitInfo(folder: string): { isGitRepo: boolean; branch?: string };
  /**
   * Freshly observed state of one record's directory —
   * `describeWorkspaceDirectory` in workspace-service.ts. Cheap: an `existsSync`
   * plus, for a record that claims its cwd is a worktree, one `lstat` of `.git`.
   */
  describeDirectory(workspace: Workspace): WorkspaceDirectory;
  /**
   * Size of a directory. **Absent means sizes were not requested** — this is
   * how the opt-in reaches the projection, so a listing that does not want to
   * pay for `du` simply does not supply the dependency.
   */
  diskUsage?(folder: string): WorktreeDiskUsage;
}

/**
 * What the row is called.
 *
 * Phase 4b sources this from the workspace record — but only when **exactly
 * one** active record claims the directory, which is the same condition
 * `viewForDirectory` uses to report an unambiguous `workspaceId`. That is not a
 * coincidence and it is the whole rule: the row may show a record's name
 * exactly when the row unambiguously *is* that record.
 *
 * A directory with two records is the case rename makes newly interesting,
 * because those two records can now have different names. The row keeps showing
 * the directory's own last segment there, for one reason: the row is
 * per-directory (the Phase 4a ruling — keying on the record splits one folder
 * into two identically-pathed rows), so a row that displayed one of two
 * distinct names would be labelled with a record the user is not acting on.
 * Picking "the most recent" would make it worse, not better — the label would
 * change under them when a chat starts in the folder. Whichever record they
 * mean, they reach it through the drill-down, where every record is listed with
 * its own name.
 *
 * The fallback is also the *common* path, not an edge case: records exist for
 * ~0.1% of directories, and one that was never renamed holds the basename
 * anyway, so this changes what is on screen only where somebody chose a name.
 */
function displayNameFor(folder: string, records: FolderWorkspaceRecord[]): string {
  const basename = folder.split("/").pop() || folder;
  if (records.length !== 1) return basename;
  return records[0].name.trim() || basename;
}

/**
 * Worst state wins. A directory with two records — the shape the registry
 * hygiene fix made routine — reports the one a user needs to act on, and the
 * per-record detail stays available in `workspaces[]`.
 */
const DIRECTORY_STATE_SEVERITY: Record<WorkspaceDirectoryState, number> = { present: 0, "not-a-worktree": 1, missing: 2 };

function worstDirectoryState(records: FolderWorkspaceRecord[]): WorkspaceDirectory | undefined {
  let worst: WorkspaceDirectory | undefined;
  for (const record of records) {
    if (!worst || DIRECTORY_STATE_SEVERITY[record.directory.state] > DIRECTORY_STATE_SEVERITY[worst.state]) worst = record.directory;
  }
  return worst;
}

/** The cheap half of a workspace record — everything a row can afford. */
function summariseRecord(workspace: Workspace, deps: FolderSummaryDeps): FolderWorkspaceRecord {
  return {
    id: workspace.id,
    name: workspace.name,
    isolation: workspace.isolation,
    // A local record owns nothing; `owned` lives on the worktree block, and its
    // absence is the same answer as `false`.
    owned: workspace.worktree?.owned === true,
    ...(workspace.worktree?.branch && { branch: workspace.worktree.branch }),
    createdAt: workspace.createdAt,
    directory: deps.describeDirectory(workspace),
  };
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
    // Registry first, because it decides whether a directory that is gone is
    // still worth a row.
    const records = deps.workspaces.recordsFor(folder).map((workspace) => summariseRecord(workspace, deps));
    const exists = deps.directoryExists(folder);
    if (!exists && records.length === 0) continue;

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

    // Nothing on disk to ask git about. The branch still has an answer — the
    // record remembers it — and that is the branch a restore would need.
    const gitInfo = exists ? deps.gitInfo(folder) : { isGitRepo: false, branch: records.find((r) => r.branch)?.branch };
    // Workspace identity and worktree-ness: the record when one claims this
    // directory, the `.git` file otherwise.
    const view = viewForDirectory(folder, deps.workspaces);
    const directory = worstDirectoryState(records);

    folders.push({
      folder,
      displayName: displayNameFor(folder, records),
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
      mostRecentChatAcpProviderId: metadata.acpProviderId || undefined,
      ...(records.length > 0 && { workspaces: records }),
      ...(directory && { directoryState: directory.state, directoryDetail: directory.detail }),
      // A directory that is gone has no size to measure, and asking would just
      // produce an error string in every such row.
      ...(deps.diskUsage && exists && { diskUsage: deps.diskUsage(folder) }),
    });
  }

  // Sort by last updated descending (most recently active folders first)
  folders.sort((a, b) => new Date(b.lastUpdatedAt).getTime() - new Date(a.lastUpdatedAt).getTime());

  return folders;
}
