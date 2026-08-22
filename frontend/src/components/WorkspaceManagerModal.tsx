/**
 * Manage worktrees — the surface that makes 43 leaked directories a two-minute
 * job instead of an agent-driven one.
 *
 * Three tabs, in the order a cleanup actually goes:
 *
 *  1. **Workspaces** — what Callboard has a record for, why each one can or
 *     cannot be cleaned up, and the archive action.
 *  2. **Unmanaged** — the backlog: worktrees with no record, which Phase 2 will
 *     never touch, and the adoption that changes that.
 *  3. **Trash** — what quarantine is holding, when the 30-day sweep takes it,
 *     and restore.
 *
 * ## The rules this component is not allowed to bend
 *
 * - **One row per directory, never per record.** Several workspaces may share a
 *   `cwd` and that is supported; after the registry-hygiene fix a `useWorktree`
 *   chat on the main checkout produces exactly that. The directory is the
 *   group; the records inside it are the drill-down.
 * - **Nothing acts in bulk.** Archive is one workspace at a time, each behind
 *   its own confirmation. Adoption takes only paths a person ticked, and there
 *   is deliberately no select-all — see AdoptWorktreesConfirm for why the
 *   tedium is the point.
 * - **The naming heuristic only ever offers.** It is rendered as a labelled
 *   guess next to a candidate and is never read by anything that decides.
 * - **The removal verdict is fetched per click, never per row.** Evaluating one
 *   is ~5 synchronous git subprocesses; a listing that carried 65 of them froze
 *   the whole daemon for 1.6s, SSE and chat input included. So the rows say what
 *   is cheap to know and the Archive button asks for the verdict, which is the
 *   only moment it decides anything. It decides what the *user* is shown — the
 *   backend re-runs every gate on the archive itself and takes no verdict from
 *   here.
 *
 * Phase 4b adds rename, and it is per record rather than per directory for the
 * same reason the archive is: the name belongs to a record, and a directory may
 * hold several. It moves nothing on disk — see the note on the rename control.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Ban, Check, FolderGit2, HardDrive, Loader2, Pencil, RotateCcw, X } from "lucide-react";
import {
  adoptWorktrees,
  archiveWorkspace,
  fetchWorkspaceRemovability,
  listTrash,
  listUnmanagedWorktrees,
  listWorkspaces,
  renameWorkspace,
  restoreTrashEntry,
  type TrashEntryView,
  type TrashRestoreResult,
  type UnmanagedWorktree,
  type UnmanagedWorktreeListing,
  type WorkspaceEntry,
  type WorkspaceWithRemovability,
  WORKSPACE_NAME_MAX,
} from "../api";
import { blockerLabel, formatDiskUsage, isFixedByAdoption } from "../utils/workspaceFormat";
import AdoptWorktreesConfirm from "./AdoptWorktreesConfirm";
import ArchiveWorkspaceConfirm from "./ArchiveWorkspaceConfirm";
import ConfirmModal from "./ConfirmModal";
import ModalOverlay from "./ModalOverlay";

type Tab = "managed" | "unmanaged" | "trash";

interface Props {
  onClose: () => void;
  /**
   * Repositories the unmanaged tab can be pointed at, derived by the caller
   * from the directories it is already showing. Discovery is per-repository —
   * `git worktree list` is — so there is no "everything everywhere" listing to
   * offer, and inventing one by scanning the disk is not something a cleanup
   * tool should do.
   */
  repoCandidates: string[];
  /** Called after anything mutates, so the list behind the modal catches up. */
  onChanged?: () => void;
  /**
   * Open on this directory — the drill-down a sidebar row links to.
   *
   * A filter, not a different view: the same Workspaces tab, narrowed to one
   * `cwd`, with a visible way back to all of them. That is what makes the row's
   * "2 workspaces" chip answer its own question — the row cannot say *which*
   * record you would be acting on (it is per-directory and there are two), so
   * it hands off to the place that lists both by name.
   */
  focusCwd?: string;
}

const TABS: { id: Tab; label: string }[] = [
  { id: "managed", label: "Workspaces" },
  { id: "unmanaged", label: "Unmanaged worktrees" },
  { id: "trash", label: "Trash" },
];

const monoStyle = { fontFamily: "var(--font-mono, monospace)", wordBreak: "break-all" as const };

function chipStyle(tone: "neutral" | "warn" | "danger" = "neutral") {
  return {
    display: "inline-flex" as const,
    alignItems: "center" as const,
    gap: 4,
    fontSize: 10,
    padding: "1px 6px",
    borderRadius: 3,
    background: tone === "warn" ? "var(--warning-bg)" : tone === "danger" ? "var(--danger-bg)" : "var(--bg-secondary)",
    color: tone === "warn" ? "var(--warning)" : tone === "danger" ? "var(--danger)" : "var(--text-muted)",
    border: "1px solid var(--border)",
  };
}

function primaryButton(disabled?: boolean) {
  return {
    padding: "6px 12px",
    borderRadius: 6,
    fontSize: 12,
    background: disabled ? "var(--bg-secondary)" : "var(--accent)",
    color: disabled ? "var(--text-muted)" : "var(--text-on-accent)",
    border: disabled ? "1px solid var(--border)" : "none",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

/** Days until an ISO timestamp, floored. Negative means it is already due. */
function daysUntil(iso: string, now: number): number {
  return Math.floor((Date.parse(iso) - now) / 86_400_000);
}

/** `1 file` / `4 files`. */
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Join backend sentences into a paragraph, terminating each one.
 *
 * Blocker details are written as sentences but only some end in a full stop, so
 * concatenating them raw runs the last one into whatever follows ("…no longer
 * exists It is not inert, though"). Added here rather than in the backend
 * strings because the same details are also rendered on their own, where a
 * trailing stop the author did not write would be equally wrong.
 */
function sentences(parts: string[]): string {
  return parts.map((part) => (/[.!?]$/.test(part.trim()) ? part.trim() : `${part.trim()}.`)).join(" ");
}

/**
 * What a restore actually did, in the terms a user can check.
 *
 * The copy count on its own is the reading that hid a data-loss bug: a restore
 * that skipped every tracked directory reported "2 entries copied" and `ok`,
 * while the `.env` files underneath them stayed in the trash for the sweep. So
 * the skips are stated too, and — because a skip is only harmless when git
 * wrote the *same* commit back — so is which commit that was.
 */
function describeRestore(entry: TrashEntryView, result: TrashRestoreResult): string {
  const parts = [`${plural(result.copiedEntries ?? 0, "file")} that git does not track ${result.copiedEntries === 1 ? "was" : "were"} copied back.`];
  if (result.skippedCount) {
    parts.push(`${plural(result.skippedCount, "path")} already existed and ${result.skippedCount === 1 ? "was" : "were"} left exactly as git checked it out.`);
  }
  const branch = entry.branch ?? "the branch";
  if (result.branchOutcome === "detached" && result.restoredCommit) {
    parts.push(
      `Note: ${branch} no longer points at the commit this was quarantined at, so the checkout was recreated detached at ${result.restoredCommit.slice(0, 8)} — ` +
        `the commit you actually had. Nothing followed the branch name to a different tree.`,
    );
  } else if (result.branchOutcome === "branch-recreated" && result.restoredCommit) {
    parts.push(`${branch} had been deleted; it was recreated at ${result.restoredCommit.slice(0, 8)}, the commit this was quarantined at.`);
  } else if (result.branchOutcome === "branch-unverified") {
    parts.push(`This entry was quarantined before Callboard recorded commits, so it was restored by branch name — check that HEAD is where you expect.`);
  }
  return parts.join(" ");
}

/** The paths a restore could not bring back. Empty string when there were none. */
function describeUnrestored(result: TrashRestoreResult): string {
  if (!result.failedCount) return "";
  const listed = (result.failedEntries ?? []).map((f) => `${f.path} (${f.error})`).join("; ");
  const more = result.failedCount > (result.failedEntries?.length ?? 0) ? `, and ${result.failedCount - (result.failedEntries?.length ?? 0)} more` : "";
  return `Not restored — still only in the trash entry: ${listed}${more}. Copy them out by hand before the retention sweep takes it.`;
}

export default function WorkspaceManagerModal({ onClose, repoCandidates, onChanged, focusCwd }: Props) {
  const [tab, setTab] = useState<Tab>("managed");
  /**
   * The directory the caller drilled into, until the user clears it. Held in
   * state rather than read from the prop so "show all" works without the parent
   * having to know a modal is filtered.
   */
  const [focused, setFocused] = useState<string | undefined>(focusCwd);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ── Managed workspaces ────────────────────────────────────────────
  //
  // The rows carry no verdict (see the header). Both confirmation targets do,
  // and their type says so — an archive confirmation cannot be constructed from
  // a row, only from something that has been evaluated.
  const [workspaces, setWorkspaces] = useState<WorkspaceEntry[] | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<WorkspaceWithRemovability | null>(null);
  const [recordOnlyTarget, setRecordOnlyTarget] = useState<WorkspaceWithRemovability | null>(null);
  /** The record whose verdict is in flight, so its own button can say so. */
  const [evaluating, setEvaluating] = useState<string | null>(null);

  const [workspacesNote, setWorkspacesNote] = useState<string | undefined>(undefined);

  const loadWorkspaces = useCallback(async () => {
    try {
      const listing = await listWorkspaces("active", true);
      setWorkspaces(listing.workspaces);
      // The listing's `du` budget ran out. Saying so is the difference between
      // "these are small" and "these were never measured".
      setWorkspacesNote(listing.diskUsageNote);
    } catch (err: any) {
      setError(err.message || "Failed to load workspaces");
    }
  }, []);

  // ── Unmanaged worktrees ───────────────────────────────────────────
  const [repoPath, setRepoPath] = useState(repoCandidates[0] ?? "");
  const [unmanaged, setUnmanaged] = useState<UnmanagedWorktreeListing | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingAdoption, setConfirmingAdoption] = useState(false);

  const loadUnmanaged = useCallback(async (repo: string) => {
    if (!repo) return;
    setScanning(true);
    setUnmanaged(null);
    // A stale tick would carry a path from the previous repository into an
    // adoption. Selections never survive a rescan.
    setSelected(new Set());
    try {
      setUnmanaged(await listUnmanagedWorktrees(repo));
    } catch (err: any) {
      setError(err.message || "Failed to scan for unmanaged worktrees");
    } finally {
      setScanning(false);
    }
  }, []);

  // ── Trash ─────────────────────────────────────────────────────────
  const [trash, setTrash] = useState<TrashEntryView[] | null>(null);
  const [retentionDays, setRetentionDays] = useState(30);
  const [trashNote, setTrashNote] = useState<string | undefined>(undefined);
  const [restoreTarget, setRestoreTarget] = useState<TrashEntryView | null>(null);
  const now = useMemo(() => Date.now(), [trash]);

  const loadTrash = useCallback(async () => {
    try {
      const listing = await listTrash();
      setTrash(listing.entries);
      setRetentionDays(listing.retentionDays);
      setTrashNote(listing.diskUsageNote);
    } catch (err: any) {
      setError(err.message || "Failed to load the trash");
    }
  }, []);

  useEffect(() => {
    if (tab === "managed" && workspaces === null) loadWorkspaces();
    if (tab === "trash" && trash === null) loadTrash();
  }, [tab, workspaces, trash, loadWorkspaces, loadTrash]);

  // ── Actions ───────────────────────────────────────────────────────

  /**
   * Evaluate one workspace and open the confirmation its verdict calls for.
   *
   * This is where the removal verdict is paid for — once, for the record the
   * user pointed at, rather than 65 times for a list they were only reading.
   * The two outcomes are genuinely different actions and have always had
   * different confirmations; what changed is that the *verdict* now arrives with
   * the click instead of with the page, so it is also fresher than a row could
   * ever be.
   *
   * The listing's row is spread in underneath so the size it already measured
   * survives — the verdict call does not run `du`, and re-running it per click
   * would put a synchronous `du` back on the path this whole change exists to
   * get off it.
   */
  const openArchive = async (entry: WorkspaceEntry) => {
    setEvaluating(entry.id);
    setError(null);
    try {
      const evaluated = await fetchWorkspaceRemovability(entry.id);
      const target: WorkspaceWithRemovability = { ...entry, ...evaluated, diskUsage: evaluated.diskUsage ?? entry.diskUsage };
      if (target.removability.removable) setArchiveTarget(target);
      else setRecordOnlyTarget(target);
    } catch (err: any) {
      setError(err.message || "Failed to work out whether this workspace can be removed");
    } finally {
      setEvaluating(null);
    }
  };

  /**
   * One workspace, one call. There is no loop over a selection here and there
   * must never be: bulk archive is how 40 GB moves on a misclick.
   */
  const runArchive = async (workspace: WorkspaceWithRemovability) => {
    setBusy(true);
    setError(null);
    try {
      const result = await archiveWorkspace(workspace.id);
      const { disposition, trashPath, blockers } = result.worktree;
      // The archive runs the retention sweep, which is the one thing in this
      // whole flow that deletes. What it took is reported here rather than left
      // in a log file the user will never open.
      const swept = result.trashSweep?.removed ?? [];
      const sweepNote =
        swept.length > 0
          ? ` The retention sweep also permanently deleted ${swept.length} trash entr${swept.length === 1 ? "y" : "ies"} past the ${retentionDays}-day window: ${swept.join(", ")}.`
          : "";
      if (disposition === "quarantined") {
        setNotice(`Archived “${workspace.name}”. Its worktree is in ${trashPath} and can be restored from the Trash tab.${sweepNote}`);
      } else if (disposition === "partial") {
        setError(
          `Archived “${workspace.name}”, but the removal did not complete cleanly. The directory was moved to ${trashPath ?? "the trash"} and git's ` +
            `bookkeeping did not follow — check "git worktree prune" in ${workspace.repoPath ?? "the repository"}.`,
        );
      } else {
        setNotice(
          `Archived the record for “${workspace.name}”. The directory was left exactly where it is${
            blockers.length > 0 ? `: ${blockers.map((b) => b.detail).join(" ")}` : "."
          }${sweepNote}`,
        );
      }
      setWorkspaces(null);
      setTrash(null);
      onChanged?.();
    } catch (err: any) {
      setError(err.message || "Failed to archive workspace");
    } finally {
      setBusy(false);
      setArchiveTarget(null);
      setRecordOnlyTarget(null);
    }
  };

  /**
   * `paths` comes from the confirmation, which is the screen that rendered
   * them. Reading `selected` here instead would post a set the user may never
   * have seen — today those agree, but only because a rescan happens to clear
   * the selection.
   */
  const runAdoption = async (paths: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const result = await adoptWorktrees(paths);
      const refused = result.outcomes.filter((o) => !o.adopted);
      setNotice(
        `Adopted ${result.adopted} worktree${result.adopted === 1 ? "" : "s"}.` +
          (refused.length > 0 ? ` ${refused.length} refused: ${refused.map((o) => `${o.path} (${o.refusal?.detail ?? "unknown reason"})`).join("; ")}` : ""),
      );
      setSelected(new Set());
      setWorkspaces(null);
      await loadUnmanaged(repoPath);
      onChanged?.();
    } catch (err: any) {
      setError(err.message || "Failed to adopt worktrees");
    } finally {
      setBusy(false);
      setConfirmingAdoption(false);
    }
  };

  /**
   * Rename one record. The only mutation on this surface with no confirmation,
   * and deliberately: it changes a label on a record, moves nothing, deletes
   * nothing, and is undone by typing the old name back.
   *
   * Returns whether it landed, so the inline editor closes on success and stays
   * open — with the text still in it — on a rejected name.
   */
  const runRename = async (workspace: WorkspaceEntry, name: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const renamed = await renameWorkspace(workspace.id, name);
      // Patch in place rather than refetching. The listing is cheap now, but the
      // response already carries the only field a rename can have changed, and a
      // refetch would re-`du` every directory and redraw the list under a user
      // who is still reading it.
      setWorkspaces((current) => current?.map((w) => (w.id === renamed.id ? { ...w, name: renamed.name } : w)) ?? current);
      setNotice(`Renamed to “${renamed.name}”. Nothing on disk moved — ${renamed.cwd} is exactly where it was.`);
      onChanged?.();
      return true;
    } catch (err: any) {
      setError(err.message || "Failed to rename workspace");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const runRestore = async (entry: TrashEntryView) => {
    setBusy(true);
    setError(null);
    try {
      const result = await restoreTrashEntry(entry.entry);
      if (result.ok) {
        setNotice(`Restored ${result.originalPath}. ${describeRestore(entry, result)} The trash copy was kept.`);
      } else {
        // A restore that copied some of the tree and could not copy the rest is
        // a failure *with contents*, and the paths it could not bring back are
        // the only part a user can act on. Never collapse it to the sentence.
        setError([result.failure?.detail ?? "The restore did not run. Nothing was changed.", describeUnrestored(result)].filter(Boolean).join(" "));
      }
      setTrash(null);
      onChanged?.();
    } catch (err: any) {
      setError(err.message || "Failed to restore");
    } finally {
      setBusy(false);
      setRestoreTarget(null);
    }
  };

  // ── Managed tab, grouped by directory ─────────────────────────────

  const byDirectory = useMemo(() => {
    const groups = new Map<string, WorkspaceEntry[]>();
    for (const workspace of workspaces ?? []) {
      const bucket = groups.get(workspace.cwd);
      if (bucket) bucket.push(workspace);
      else groups.set(workspace.cwd, [workspace]);
    }
    return [...groups.entries()];
  }, [workspaces]);

  /**
   * The drill-down. A trailing slash is the only spelling difference worth
   * tolerating — records store a resolved path and so does the row that links
   * here — and a focus that matches nothing renders as an explicit empty state
   * with a way back, never as a silently empty list.
   */
  const visibleDirectories = useMemo(() => {
    if (!focused) return byDirectory;
    const target = focused.replace(/\/+$/, "");
    return byDirectory.filter(([cwd]) => cwd.replace(/\/+$/, "") === target);
  }, [byDirectory, focused]);

  const totalManagedBytes = useMemo(() => byDirectory.reduce((sum, [, records]) => sum + (records[0].diskUsage?.bytes ?? 0), 0), [byDirectory]);

  const selectedWorktrees = useMemo(() => (unmanaged?.worktrees ?? []).filter((w) => selected.has(w.path)), [unmanaged, selected]);

  const unmanagedBytes = useMemo(() => (unmanaged?.worktrees ?? []).reduce((sum, w) => sum + (w.diskUsage.bytes ?? 0), 0), [unmanaged]);

  const toggle = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <ModalOverlay>
      <div
        style={{
          background: "var(--bg)",
          borderRadius: 8,
          border: "1px solid var(--border)",
          width: "94%",
          maxWidth: 860,
          height: "88vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div style={{ padding: "16px 20px 0", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <h2 style={{ margin: 0, fontSize: 17, display: "flex", alignItems: "center", gap: 8 }}>
              <FolderGit2 size={17} />
              Manage worktrees
            </h2>
            <button
              onClick={onClose}
              title="Close"
              style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 4, display: "flex" }}
            >
              <X size={18} />
            </button>
          </div>
          <div style={{ display: "flex", gap: 4, marginTop: 12 }}>
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                style={{
                  padding: "8px 14px",
                  fontSize: 13,
                  background: "none",
                  border: "none",
                  borderBottom: tab === id ? "2px solid var(--accent)" : "2px solid transparent",
                  color: tab === id ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  fontWeight: tab === id ? 600 : 400,
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Messages */}
        {(error || notice) && (
          <div
            style={{
              margin: "12px 20px 0",
              padding: "8px 10px",
              borderRadius: 6,
              fontSize: 12,
              lineHeight: 1.5,
              background: error ? "var(--danger-bg)" : "var(--success-bg, var(--bg-secondary))",
              color: error ? "var(--danger)" : "var(--text)",
              border: "1px solid var(--border)",
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
            }}
          >
            <span style={{ flex: 1 }}>{error ?? notice}</span>
            <button
              onClick={() => {
                setError(null);
                setNotice(null);
              }}
              style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, display: "flex" }}
            >
              <X size={14} />
            </button>
          </div>
        )}

        {/* Body */}
        <div style={{ flex: 1, overflow: "auto", padding: "16px 20px" }}>
          {tab === "managed" && (
            <>
              <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                Directories Callboard holds a workspace record for
                {totalManagedBytes > 0 && <> · {formatDiskUsage({ bytes: totalManagedBytes })} in total</>}. A worktree is only ever moved to the trash when
                every gate passes; “Archive…” checks this one against all of them and tells you which it is — a removal, or a record archived with the directory
                left exactly where it is — before anything happens.
                {workspacesNote && <span style={{ display: "block", marginTop: 4 }}>{workspacesNote}</span>}
              </p>
              {/*
                The drill-down banner. A filtered list that does not say it is
                filtered is the same bug as a row that lies about which record
                it acts on — the count and the way out are both stated.
              */}
              {focused && workspaces !== null && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    marginBottom: 12,
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid var(--border)",
                    background: "var(--bg-secondary)",
                    fontSize: 12,
                    color: "var(--text-muted)",
                  }}
                >
                  <span style={{ ...monoStyle, minWidth: 0 }}>
                    Showing {visibleDirectories.length} of {byDirectory.length} directories · {focused}
                  </span>
                  <button
                    onClick={() => setFocused(undefined)}
                    style={{ ...primaryButton(false), background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", flexShrink: 0 }}
                  >
                    Show all
                  </button>
                </div>
              )}
              {workspaces === null ? (
                <Loading />
              ) : visibleDirectories.length === 0 ? (
                <Empty
                  text={
                    focused
                      ? `No active workspace record for ${focused}. It may have been archived since the list was drawn — use “Show all” to see the rest.`
                      : "No active workspace records. Anything Callboard created before this feature existed is in the Unmanaged tab."
                  }
                />
              ) : (
                visibleDirectories.map(([cwd, records]) => (
                  <DirectoryGroup key={cwd} cwd={cwd} records={records} busy={busy} evaluating={evaluating} onArchive={openArchive} onRename={runRename} />
                ))
              )}
            </>
          )}

          {tab === "unmanaged" && (
            <>
              <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                Git worktrees with no workspace record. Callboard will never remove these — it cannot prove it created them. Adopting one writes an ownership
                token and a record; it does not delete, move or modify anything.
              </p>

              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
                <select
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                  style={{
                    flex: 1,
                    minWidth: 220,
                    background: "var(--bg-secondary)",
                    color: "var(--text)",
                    border: "1px solid var(--border)",
                    borderRadius: 4,
                    padding: "5px 8px",
                    fontSize: 12,
                  }}
                >
                  {repoCandidates.length === 0 && <option value="">No repository in the current list</option>}
                  {repoCandidates.map((repo) => (
                    <option key={repo} value={repo}>
                      {repo}
                    </option>
                  ))}
                </select>
                <button onClick={() => loadUnmanaged(repoPath)} disabled={!repoPath || scanning} style={primaryButton(!repoPath || scanning)}>
                  {scanning ? "Scanning…" : "Scan"}
                </button>
              </div>

              {scanning ? (
                <Loading />
              ) : unmanaged === null ? (
                <Empty text="Pick a repository and scan. Nothing is written by a scan." />
              ) : unmanaged.worktrees.length === 0 ? (
                <Empty
                  text={`Every one of ${unmanaged.totalWorktrees} registered worktree${unmanaged.totalWorktrees === 1 ? "" : "s"} in this repository already has a record.`}
                />
              ) : (
                <>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
                    {unmanaged.worktrees.length} unmanaged of {unmanaged.totalWorktrees} registered
                    {unmanagedBytes > 0 && <> · {formatDiskUsage({ bytes: unmanagedBytes })} on disk</>}
                    {unmanaged.diskUsageNote && <div style={{ marginTop: 4 }}>{unmanaged.diskUsageNote}</div>}
                  </div>
                  {unmanaged.worktrees.map((worktree) => (
                    <UnmanagedRow key={worktree.path} worktree={worktree} checked={selected.has(worktree.path)} onToggle={() => toggle(worktree.path)} />
                  ))}
                </>
              )}
            </>
          )}

          {tab === "trash" && (
            <>
              <p style={{ margin: "0 0 14px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
                Quarantined worktrees. Nothing here has been deleted — the retention sweep removes an entry {retentionDays} days after it arrived, and that is
                the only place Callboard deletes anything on its own — and archiving a workspace runs it, so a click over on the Workspaces tab can empty an
                expired entry from here. Restoring copies the contents back out and keeps the trash copy.
                {trashNote && <span style={{ display: "block", marginTop: 4 }}>{trashNote}</span>}
              </p>
              {trash === null ? (
                <Loading />
              ) : trash.length === 0 ? (
                <Empty text="The trash is empty." />
              ) : (
                trash.map((entry) => <TrashRow key={entry.entry} entry={entry} now={now} busy={busy} onRestore={setRestoreTarget} />)
              )}
            </>
          )}
        </div>

        {/* Footer — only the unmanaged tab has a batched action, and it is gated */}
        {tab === "unmanaged" && (
          <div
            style={{
              padding: "12px 20px",
              borderTop: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {selected.size === 0 ? "Tick the worktrees you want Callboard to manage." : `${selected.size} selected`}
            </span>
            <button onClick={() => setConfirmingAdoption(true)} disabled={selected.size === 0 || busy} style={primaryButton(selected.size === 0 || busy)}>
              Adopt selected…
            </button>
          </div>
        )}
      </div>

      {/* Confirmations. Every mutation on this surface passes through one. */}
      {archiveTarget && (
        <ArchiveWorkspaceConfirm
          workspace={archiveTarget}
          // The count the backend already computed. Passing it is not a nicety:
          // the archive interrupts and archives every one of these chats before
          // it even evaluates the worktree.
          chatCount={archiveTarget.chatCount ?? 0}
          busy={busy}
          onCancel={() => setArchiveTarget(null)}
          onConfirm={() => runArchive(archiveTarget)}
        />
      )}
      {recordOnlyTarget && (
        <ConfirmModal
          isOpen
          onClose={() => setRecordOnlyTarget(null)}
          onConfirm={() => runArchive(recordOnlyTarget)}
          title={`Archive the record for “${recordOnlyTarget.name}”?`}
          /*
            "…and nothing else" was false. Archiving interrupts every chat
            linked to the workspace and stamps it archived *before* the
            removability gate runs, so it happens on this path too — the
            directory is what stays untouched, not the sessions.

            Every blocker is named here, with its short label as well as the
            backend's sentence. This screen is now the *only* place a user reads
            them — the rows no longer carry a verdict to render — so it may not
            summarise: a user who fixes one blocker and finds another waiting
            has learned nothing about what to do next.
          */
          message={
            `This marks the workspace record archived. The directory at ${recordOnlyTarget.cwd} is not moved, not deleted and not modified — Callboard will ` +
            `not touch it, because: ${sentences(recordOnlyTarget.removability.blockers.map((b) => `${blockerLabel(b.code)} — ${b.detail}`))}` +
            (recordOnlyTarget.removability.blockers.some((b) => isFixedByAdoption(b.code))
              ? " Adopting this worktree from the Unmanaged tab would clear that."
              : "") +
            (recordOnlyTarget.chatCount
              ? ` It is not inert, though: ${recordOnlyTarget.chatCount} chat${recordOnlyTarget.chatCount === 1 ? "" : "s"} linked to this workspace ` +
                `${recordOnlyTarget.chatCount === 1 ? "is" : "are"} interrupted and archived first. Their logs are kept.`
              : "")
          }
          confirmText="Archive the record"
          confirmStyle="danger"
        />
      )}
      {confirmingAdoption && (
        <AdoptWorktreesConfirm worktrees={selectedWorktrees} busy={busy} onCancel={() => setConfirmingAdoption(false)} onConfirm={runAdoption} />
      )}
      {restoreTarget && (
        <ConfirmModal
          isOpen
          onClose={() => setRestoreTarget(null)}
          onConfirm={() => runRestore(restoreTarget)}
          title="Restore this worktree?"
          message={
            `Callboard will recreate the checkout at ${restoreTarget.originalPath} at the commit it was quarantined at — ${restoreTarget.branch} if that ` +
            `branch still points there, and the commit itself if it does not — and copy back everything git does not track. The quarantined copy stays in ` +
            `the trash, so this cannot lose anything.`
          }
          confirmText="Restore"
        />
      )}
    </ModalOverlay>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────

function Loading() {
  return (
    <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
      <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
      Loading…
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 13, lineHeight: 1.5 }}>{text}</div>;
}

/**
 * One directory, with every active record on it.
 *
 * The group is the row. When two records share a `cwd` neither is removable —
 * the ref-count refuses until the last reference goes — and the `shared-cwd`
 * blocker says exactly that, so the situation explains itself rather than
 * needing special-casing here.
 */
function DirectoryGroup({
  cwd,
  records,
  busy,
  evaluating,
  onArchive,
  onRename,
}: {
  cwd: string;
  records: WorkspaceEntry[];
  busy: boolean;
  evaluating: string | null;
  onArchive: (workspace: WorkspaceEntry) => void;
  onRename: (workspace: WorkspaceEntry, name: string) => Promise<boolean>;
}) {
  const size = formatDiskUsage(records[0].diskUsage);
  const directory = records[0].directory;
  // Same rule as the sidebar row (see `displayNameFor` in
  // backend/src/services/folder-summaries.ts): a record's name identifies the
  // group only when exactly one record claims the directory. Two records with
  // two names get the directory's own segment here, and their names below.
  const displayName = (records.length === 1 && records[0].name.trim()) || cwd.split("/").filter(Boolean).pop() || cwd;

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 12, marginBottom: 10, background: "var(--bg-secondary)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{displayName}</span>
        {size && (
          <span style={chipStyle()}>
            <HardDrive size={10} />
            {size}
          </span>
        )}
        {records.length > 1 && <span style={chipStyle()}>{records.length} workspaces on this directory</span>}
        {directory.state !== "present" && (
          <span style={chipStyle("warn")}>
            <AlertTriangle size={10} />
            {directory.state === "missing" ? "directory is gone" : "no longer a worktree"}
          </span>
        )}
      </div>
      <div
        style={{
          ...monoStyle,
          fontSize: 11,
          color: "var(--text-muted)",
          marginTop: 3,
          textDecoration: directory.state === "missing" ? "line-through" : "none",
        }}
      >
        {cwd}
      </div>
      {directory.state !== "present" && <div style={{ fontSize: 11, color: "var(--warning)", marginTop: 6, lineHeight: 1.5 }}>{directory.detail}</div>}

      <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        {records.map((record) => (
          <RecordRow key={record.id} record={record} busy={busy} evaluating={evaluating === record.id} onArchive={onArchive} onRename={onRename} />
        ))}
      </div>
    </div>
  );
}

/**
 * The record's name, and the pencil that changes it.
 *
 * **A rename moves nothing.** The name is a label on the record — not the
 * directory, not the branch, not the worktree path, and nothing derives any of
 * those from it. That sentence is on the control itself rather than only in
 * this comment, because "rename" is a word that means *move* in a file manager
 * and this is the one place a user could reasonably expect it to.
 *
 * No confirmation, for the same reason: it is undone by typing the old name
 * back. Every other action on this surface has one because every other action
 * touches a directory.
 */
function RecordName({
  record,
  busy,
  onRename,
}: {
  record: WorkspaceEntry;
  busy: boolean;
  onRename: (workspace: WorkspaceEntry, name: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const start = () => {
    setDraft(record.name);
    setEditing(true);
  };

  const commit = async () => {
    // An unchanged name is not a request; close without a round trip.
    if (draft.trim() === record.name.trim()) return setEditing(false);
    // Stays open on a refusal, with the text still in it — the error banner
    // above says which rule the name broke.
    if (await onRename(record, draft)) setEditing(false);
  };

  if (!editing) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}>
        <span style={{ fontSize: 12, color: "var(--text)" }}>{record.name}</span>
        <button
          onClick={start}
          disabled={busy}
          title="Rename this workspace. This changes a label only — the directory, the branch and the worktree are not touched."
          style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: busy ? "not-allowed" : "pointer", padding: 2, display: "flex" }}
        >
          <Pencil size={11} />
        </button>
      </span>
    );
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}>
      <input
        ref={inputRef}
        value={draft}
        autoFocus
        maxLength={WORKSPACE_NAME_MAX}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        aria-label={`Rename ${record.name}`}
        style={{
          fontSize: 12,
          padding: "2px 6px",
          borderRadius: 4,
          border: "1px solid var(--border)",
          background: "var(--bg)",
          color: "var(--text)",
          maxWidth: 240,
        }}
      />
      <button
        onClick={commit}
        disabled={busy}
        title="Save the new label. Nothing on disk moves."
        style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: busy ? "not-allowed" : "pointer", padding: 2, display: "flex" }}
      >
        <Check size={12} />
      </button>
      <button
        onClick={() => setEditing(false)}
        title="Cancel"
        style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", padding: 2, display: "flex" }}
      >
        <X size={12} />
      </button>
    </span>
  );
}

/**
 * One record, and the one button that acts on it.
 *
 * The row deliberately does not know whether this workspace is removable — the
 * verdict that answers it is ~5 synchronous git subprocesses, and 65 rows of
 * them is what froze the daemon. So the button does not promise an outcome:
 * clicking it evaluates *this* record and opens whichever of the two
 * confirmations the answer calls for, and each of those still states in full
 * what it is about to do. Nothing archives without passing one.
 */
function RecordRow({
  record,
  busy,
  evaluating,
  onArchive,
  onRename,
}: {
  record: WorkspaceEntry;
  busy: boolean;
  /** This record's verdict is in flight. */
  evaluating: boolean;
  onArchive: (workspace: WorkspaceEntry) => void;
  onRename: (workspace: WorkspaceEntry, name: string) => Promise<boolean>;
}) {
  return (
    <div style={{ borderTop: "1px solid var(--border)", paddingTop: 8, display: "flex", gap: 12, alignItems: "flex-start" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <RecordName record={record} busy={busy} onRename={onRename} />
          {record.worktree?.branch && <span style={chipStyle()}>{record.worktree.branch}</span>}
          <span style={chipStyle()}>{record.isolation}</span>
          {record.worktree?.owned && <span style={chipStyle()}>owned by Callboard</span>}
          {/*
            The one thing about removability a row can say for free: a worktree
            Callboard did not create is never removable, and adoption is the way
            out. It comes off the record, not off a git check.
          */}
          {record.isolation === "worktree" && !record.worktree?.owned && (
            <span
              style={chipStyle("warn")}
              title="Callboard cannot prove it created this worktree, so it will never remove it. Adopt it from the Unmanaged tab to change that."
            >
              <Ban size={10} />
              not owned by Callboard
            </span>
          )}
        </div>
      </div>

      <div style={{ flexShrink: 0 }}>
        <button
          onClick={() => onArchive(record)}
          disabled={busy || evaluating}
          style={{ ...primaryButton(false), background: "var(--bg-secondary)", color: "var(--text)", border: "1px solid var(--border)" }}
          title="Check what archiving this would do, and confirm it. Nothing happens until you do."
        >
          {evaluating ? "Checking…" : "Archive…"}
        </button>
      </div>
    </div>
  );
}

function UnmanagedRow({ worktree, checked, onToggle }: { worktree: UnmanagedWorktree; checked: boolean; onToggle: () => void }) {
  const size = formatDiskUsage(worktree.diskUsage);
  const disabled = !worktree.adoptable;

  return (
    <label
      style={{
        display: "flex",
        gap: 10,
        alignItems: "flex-start",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 10,
        marginBottom: 8,
        background: "var(--bg-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onToggle} style={{ marginTop: 3, cursor: disabled ? "not-allowed" : "pointer" }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...monoStyle, fontSize: 12, color: "var(--text)" }}>{worktree.path}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 5 }}>
          <span style={chipStyle()}>{worktree.branch ?? "detached HEAD"}</span>
          {size && (
            <span style={chipStyle()}>
              <HardDrive size={10} />
              {size}
            </span>
          )}
          {!worktree.cleanliness.clean && <span style={chipStyle("warn")}>has work in progress</span>}
          {/*
            The naming heuristic, labelled as the guess it is. Callboard has
            used more than one convention and a user can produce either by
            hand, so this may only ever help a person choose — nothing in the
            adoption path reads it.
          */}
          <span style={chipStyle()} title={worktree.naming.detail}>
            {worktree.naming.matches ? "looks like Callboard's naming (a guess)" : "unfamiliar name (a guess)"}
          </span>
        </div>
        {!worktree.cleanliness.clean && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 5, lineHeight: 1.5 }}>
            {[
              worktree.cleanliness.uncommittedChanges && "uncommitted changes",
              worktree.cleanliness.untrackedFiles && "untracked files",
              worktree.cleanliness.unpushedCommits && "commits that exist nowhere else",
              worktree.cleanliness.error,
            ]
              .filter(Boolean)
              .join(", ")}
            . It can still be adopted — that only makes it manageable, and it stays unremovable until it is clean.
          </div>
        )}
        {disabled && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 5, lineHeight: 1.5 }}>
            {worktree.adoptionBlockers.map((b) => b.detail).join(" ")}
          </div>
        )}
      </div>
    </label>
  );
}

function TrashRow({ entry, now, busy, onRestore }: { entry: TrashEntryView; now: number; busy: boolean; onRestore: (entry: TrashEntryView) => void }) {
  const size = formatDiskUsage(entry.diskUsage);
  const remaining = entry.expiresAt ? daysUntil(entry.expiresAt, now) : null;

  return (
    <div
      style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 10, marginBottom: 8, background: "var(--bg-secondary)", display: "flex", gap: 12 }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...monoStyle, fontSize: 12, color: "var(--text)" }}>{entry.originalPath ?? entry.entry}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 5 }}>
          {entry.branch && <span style={chipStyle()}>{entry.branch}</span>}
          {size && (
            <span style={chipStyle()}>
              <HardDrive size={10} />
              {size}
            </span>
          )}
          {entry.quarantinedAt && <span style={chipStyle()}>quarantined {new Date(entry.quarantinedAt).toLocaleDateString()}</span>}
          {/*
            The countdown, or the honest absence of one. An entry the sweep
            cannot date is kept forever; showing "expires in 30 days" for it
            would be a lie in the direction that costs a user their data.
          */}
          {remaining === null ? (
            <span style={chipStyle()} title={entry.sweepBlocked}>
              never swept
            </span>
          ) : (
            <span style={chipStyle(remaining <= 3 ? "danger" : remaining <= 7 ? "warn" : "neutral")}>
              {remaining <= 0 ? "due for deletion" : `deleted in ${remaining} day${remaining === 1 ? "" : "s"}`}
            </span>
          )}
        </div>
        {!entry.restorable && entry.restoreBlocker && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 5, lineHeight: 1.5 }}>Cannot restore: {entry.restoreBlocker}</div>
        )}
      </div>
      <div style={{ flexShrink: 0, display: "flex", alignItems: "flex-start" }}>
        <button
          onClick={() => onRestore(entry)}
          disabled={!entry.restorable || busy}
          style={{ ...primaryButton(!entry.restorable || busy), display: "flex", alignItems: "center", gap: 5 }}
          title={entry.restorable ? "Recreate the checkout and copy the untracked files back" : entry.restoreBlocker}
        >
          <RotateCcw size={12} />
          Restore
        </button>
      </div>
    </div>
  );
}
