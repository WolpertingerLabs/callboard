import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { PanelLeftOpen, HardDrive, FolderGit2 } from "lucide-react";
import { listFolders, type FolderSummary } from "../api";
import { useSessionContext } from "../contexts/SessionContext";
import { useDebouncedCallback } from "../hooks/useDebouncedCallback";
import SidebarHeader from "../components/SidebarHeader";
import FolderListItem from "../components/FolderListItem";
import NewChatPanel from "../components/NewChatPanel";
import ConfirmModal from "../components/ConfirmModal";
import WorkspaceManagerModal from "../components/WorkspaceManagerModal";
import {
  getFolderMaxAgeDays,
  saveFolderMaxAgeDays,
  getFolderShowSizes,
  saveFolderShowSizes,
  getDefaultPermissions,
  type SidebarViewMode,
} from "../utils/localStorage";

interface FolderListProps {
  activeChatId?: string;
  onRefresh: (refreshFn: () => void) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  claudeLoggedIn?: boolean;
  onShowClaudeModal?: () => void;
  onViewModeChange: (mode: SidebarViewMode) => void;
}

const AGE_OPTIONS = [
  { label: "1 day", value: 1 },
  { label: "3 days", value: 3 },
  { label: "5 days", value: 5 },
  { label: "7 days", value: 7 },
  { label: "14 days", value: 14 },
  { label: "30 days", value: 30 },
];

/** Heartbeat while at least one session is live. Unchanged; only the fan-in around it is new. */
const ACTIVE_POLL_MS = 15_000;

/**
 * How long the ambient triggers wait before turning into a request.
 *
 * 300ms is what the metadata trigger already used, and it is what sets the
 * observable responsiveness of the sidebar after a status/title/summon change.
 * What is new is that the session-count trigger and the heartbeat share the
 * window, so triggers that land together produce one request instead of three.
 */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * Granularity of the `now` the rows are given.
 *
 * `now` exists so the rows can format relative times without calling
 * `Date.now()` in render. It was recomputed on every listing, so every poll
 * handed all ~40 rows a new value and re-rendered them — for a listing that
 * usually came back identical. The rows render minute-granular strings
 * ("3m ago") and a 12-hour staleness cutoff, so a value that only moves every
 * 30 seconds is indistinguishable on screen and holds still between polls.
 */
const NOW_QUANTUM_MS = 30_000;

/** A fetch we abandoned is not a failure — it must not log, and must not blank the list. */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * Carry forward the previous row object wherever the new listing says the same
 * thing about that directory.
 *
 * The listing is polled and, the overwhelming majority of the time, identical
 * to the last one — but it arrives as JSON, so every row is a fresh object and
 * every array a fresh array. Without this, `React.memo` on the row can never
 * hit, `repoCandidates` recomputes, and `now` moves. Comparing serialisations
 * is safe here because both sides come from the same server serialiser, so key
 * order is stable; ~40 small objects is nothing against a ~120ms uncached
 * disk sweep.
 *
 * Returns `prev` itself when nothing at all changed, which is the case that
 * matters: a no-op poll then re-renders nothing.
 */
function reuseUnchangedRows(prev: FolderSummary[], next: FolderSummary[]): FolderSummary[] {
  if (prev.length === 0) return next;
  const byPath = new Map(prev.map((folder) => [folder.folder, folder]));
  let changed = prev.length !== next.length;
  const merged = next.map((folder, index) => {
    const previous = byPath.get(folder.folder);
    if (previous && JSON.stringify(previous) === JSON.stringify(folder)) {
      if (prev[index] !== previous) changed = true;
      return previous;
    }
    changed = true;
    return folder;
  });
  return changed ? merged : prev;
}

export default function FolderList({
  activeChatId,
  onRefresh,
  sidebarCollapsed,
  onToggleSidebar,
  claudeLoggedIn,
  onShowClaudeModal,
  onViewModeChange,
}: FolderListProps) {
  const { activeSessions, metadataVersion } = useSessionContext();
  const navigate = useNavigate();
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [maxAgeDays, setMaxAgeDays] = useState(() => getFolderMaxAgeDays());
  const [showSizes, setShowSizes] = useState(() => getFolderShowSizes());
  const [isLoading, setIsLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [showManager, setShowManager] = useState(false);
  /**
   * Directory the manager opens on, when it was opened from a row's chip.
   * Undefined for the toolbar button, which means "all of them".
   */
  const [managerFocus, setManagerFocus] = useState<string | undefined>(undefined);
  const [confirmModal, setConfirmModal] = useState<{ isOpen: boolean; folder: string }>({ isOpen: false, folder: "" });
  /**
   * The clock the rows format against, advanced when a listing lands.
   *
   * Was `useMemo(() => Date.now(), [folders])` — an impure read during render,
   * and one that produced a new value on every poll whether or not anything
   * had changed. Setting it where the response is handled makes it pure, and
   * quantising it makes it hold still: it lands in the same batch as
   * `setFolders`, so a poll that changes neither is still a single no-op
   * render.
   */
  const [now, setNow] = useState(0);

  /**
   * The single request in flight, if there is one.
   *
   * Held in a ref rather than state because nothing renders it and every
   * trigger needs to see the current value synchronously — a trigger that read
   * a render-old value would be exactly the duplicate this is here to stop.
   */
  const inFlightRef = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);

  /**
   * Fetch the listing, at most once at a time.
   *
   * `GET /api/chats/folders` is an uncached disk sweep — ~120ms of blocked
   * event loop per call, against ~1ms for the cached chat list. Four
   * independent triggers used to call this with no coordination at all, so a
   * single metadata bump during an active session could put three overlapping
   * sweeps on the wire and throw two of the answers away.
   *
   * Two rules, and which one applies is about *why* the caller is asking:
   *
   * - Ambient (`force` unset): the caller wants current data. A request
   *   already in flight is going to produce exactly that, so ride it. This is
   *   the dedupe.
   * - Forced: the caller knows something the in-flight request does not — the
   *   filter parameters just changed, or a write just landed. Its answer is
   *   already wrong, so abort it and start again. This is what keeps
   *   `WorkspaceManagerModal`'s `onChanged` a real invalidation instead of
   *   something the dedupe quietly swallows.
   */
  const load = useCallback(
    (options?: { force?: boolean }): Promise<void> => {
      const current = inFlightRef.current;
      if (current) {
        if (!options?.force) return current.promise;
        current.controller.abort();
      }

      const controller = new AbortController();
      const entry: { controller: AbortController; promise: Promise<void> } = { controller, promise: Promise.resolve() };
      // Assigned before the fetch is started so that a synchronous rejection
      // still finds the entry it needs to clear.
      inFlightRef.current = entry;
      const settle = () => {
        if (inFlightRef.current === entry) inFlightRef.current = null;
      };

      entry.promise = listFolders(maxAgeDays, showSizes, controller.signal).then(
        (response) => {
          settle();
          // A superseding load owns the list and the spinner now.
          if (controller.signal.aborted) return;
          setFolders((prev) => reuseUnchangedRows(prev, response.folders));
          setNow((prev) => {
            const quantised = Math.floor(Date.now() / NOW_QUANTUM_MS) * NOW_QUANTUM_MS;
            return quantised === prev ? prev : quantised;
          });
          setIsLoading(false);
        },
        (err: unknown) => {
          settle();
          // Abandoned on purpose: no console noise, and the list keeps showing
          // what it was showing until the request that replaced this one lands.
          if (isAbortError(err) || controller.signal.aborted) return;
          console.error("Failed to load folders:", err);
          setIsLoading(false);
        },
      );
      return entry.promise;
    },
    [maxAgeDays, showSizes],
  );

  /**
   * Post-write invalidation, and the manual refresh the parent holds. Always
   * forced: the caller has just changed something the server has not been
   * asked about yet.
   */
  const forceRefresh = useCallback(() => {
    void load({ force: true });
  }, [load]);

  /** Every ambient trigger goes through here, so triggers that arrive together cost one request. */
  const requestRefresh = useDebouncedCallback(
    useCallback(() => {
      void load();
    }, [load]),
    REFRESH_DEBOUNCE_MS,
  );

  /**
   * Repositories the manager's unmanaged scan can be pointed at.
   *
   * Derived from what is already on screen — a worktree row names its main
   * checkout, and a plain git row is one. Discovery is per-repository because
   * `git worktree list` is, and a cleanup tool has no business walking the disk
   * looking for repositories it was never told about.
   */
  const repoCandidates = useMemo(() => {
    const repos = new Set<string>();
    for (const folder of folders) {
      if (folder.repoPath) repos.add(folder.repoPath);
      else if (folder.isGitRepo && !folder.isWorktree && folder.directoryState !== "missing") repos.add(folder.folder);
    }
    return [...repos].sort();
  }, [folders]);

  /**
   * Mount, and any change to the filter parameters.
   *
   * Not debounced: both cases are a user staring at a spinner, and both must
   * supersede rather than ride — a request for the previous `maxAgeDays` would
   * answer the previous question. `load`'s identity changes with exactly those
   * two parameters, so this effect fires on exactly those two occasions.
   */
  useEffect(() => {
    void load({ force: true });
  }, [load]);

  // Register refresh callback
  useEffect(() => {
    onRefresh(forceRefresh);
  }, [onRefresh, forceRefresh]);

  /**
   * The ambient triggers: how many sessions are live, and the metadata counter
   * the 1s session poll bumps on any status/title/summon change.
   *
   * They used to be two effects with two timers, neither aware of the other or
   * of the heartbeat below. They now share one debounce window, and the first
   * run is skipped because the effect above has already fetched.
   */
  const ambientTriggersSeen = useRef(false);
  useEffect(() => {
    if (!ambientTriggersSeen.current) {
      ambientTriggersSeen.current = true;
      return;
    }
    requestRefresh();
  }, [requestRefresh, activeSessions.size, metadataVersion]);

  // Heartbeat while sessions are active. Still 15s, and still nothing at all
  // when nothing is running; it just lands in the same debounce window as
  // anything else that happens to be due.
  useEffect(() => {
    if (activeSessions.size === 0) return;
    const interval = setInterval(requestRefresh, ACTIVE_POLL_MS);
    return () => clearInterval(interval);
  }, [activeSessions.size, requestRefresh]);

  // Nothing in flight should outlive the view.
  useEffect(() => () => inFlightRef.current?.controller.abort(), []);

  const handleMaxAgeChange = (days: number) => {
    setMaxAgeDays(days);
    saveFolderMaxAgeDays(days);
    setIsLoading(true);
  };

  const handleShowSizesChange = (value: boolean) => {
    setShowSizes(value);
    saveFolderShowSizes(value);
    setIsLoading(true);
  };

  /*
    The row's three callbacks, hoisted and stabilised.

    They were inline arrows closed over `folder`, which meant a new function
    identity per row per render — enough on its own to defeat the `React.memo`
    the row now carries. The row hands its own folder back instead, so one
    function serves every row and survives every poll.
  */
  const handleOpenFolder = useCallback(
    (folder: FolderSummary) => {
      navigate(`/chat/${folder.mostRecentChatId}`);
    },
    [navigate],
  );

  const handleNewChat = useCallback(
    (folder: FolderSummary) => {
      if (folder.status === "waiting") {
        setConfirmModal({ isOpen: true, folder: folder.folder });
      } else {
        navigate(`/chat/new?folder=${encodeURIComponent(folder.folder)}`, {
          state: { defaultPermissions: getDefaultPermissions() },
        });
      }
    },
    [navigate],
  );

  const handleManageWorkspaces = useCallback((folder: FolderSummary) => {
    setManagerFocus(folder.folder);
    setShowManager(true);
  }, []);

  // Collapsed sidebar state
  if (sidebarCollapsed) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: 12,
          gap: 8,
          height: "100%",
        }}
      >
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            style={{
              background: "none",
              color: "var(--chatlist-icon)",
              padding: 8,
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              marginBottom: 16,
            }}
            title="Expand sidebar"
          >
            <PanelLeftOpen size={16} />
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <SidebarHeader
        viewMode="folders"
        onToggleNew={() => setShowNew(!showNew)}
        onViewModeChange={onViewModeChange}
        claudeLoggedIn={claudeLoggedIn}
        onShowClaudeModal={onShowClaudeModal}
        onToggleSidebar={onToggleSidebar}
      />

      {/* Filter bar */}
      <div
        style={{
          padding: "8px 20px",
          borderBottom: "1px solid var(--chatlist-header-border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          color: "var(--text-muted)",
        }}
      >
        <span>Show last</span>
        <select
          value={maxAgeDays}
          onChange={(e) => handleMaxAgeChange(Number(e.target.value))}
          style={{
            background: "var(--bg-secondary)",
            color: "var(--text)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "2px 6px",
            fontSize: 13,
          }}
        >
          {AGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {/*
          Sizes are opt-in and sticky. `du` is the slow part of this listing and
          the listing is polled, so a user who wants the number turns it on once
          and everybody else never pays for it. Server-side measurements are
          memoised for five minutes, which is what makes the polling survivable
          once it is on.
        */}
        <button
          onClick={() => handleShowSizesChange(!showSizes)}
          title={showSizes ? "Stop measuring directory sizes" : "Measure each directory with du (slower, cached for 5 minutes)"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 7px",
            borderRadius: 4,
            fontSize: 12,
            background: showSizes ? "var(--accent)" : "var(--bg-secondary)",
            color: showSizes ? "var(--text-on-accent)" : "var(--text-muted)",
            border: showSizes ? "none" : "1px solid var(--border)",
            cursor: "pointer",
          }}
        >
          <HardDrive size={12} />
          Sizes
        </button>

        <button
          onClick={() => {
            setManagerFocus(undefined);
            setShowManager(true);
          }}
          title="Adopt, archive and restore worktrees"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "3px 7px",
            borderRadius: 4,
            fontSize: 12,
            marginLeft: "auto",
            background: "var(--bg-secondary)",
            color: "var(--text-muted)",
            border: "1px solid var(--border)",
            cursor: "pointer",
          }}
        >
          <FolderGit2 size={12} />
          Manage
        </button>
      </div>

      {showNew && <NewChatPanel onClose={() => setShowNew(false)} />}

      {/* Folder list */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {isLoading ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)" }}>Loading...</div>
        ) : folders.length === 0 ? (
          <div style={{ padding: 20, textAlign: "center", color: "var(--text-muted)" }}>No folders with recent activity</div>
        ) : (
          folders.map((folder) => (
            <FolderListItem
              key={folder.folder}
              folder={folder}
              isActive={activeChatId === folder.mostRecentChatId}
              onClick={handleOpenFolder}
              onNewChat={handleNewChat}
              now={now}
              onManageWorkspaces={handleManageWorkspaces}
            />
          ))
        )}
      </div>

      {/* Confirm modal for new chat while waiting */}
      <ConfirmModal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal({ isOpen: false, folder: "" })}
        onConfirm={() =>
          navigate(`/chat/new?folder=${encodeURIComponent(confirmModal.folder)}`, {
            state: { defaultPermissions: getDefaultPermissions() },
          })
        }
        title="Chat waiting for input"
        message="A chat in this folder is waiting for your input. Start a new chat anyway?"
        confirmText="Start new chat"
      />

      {showManager && (
        // Keyed on the focus so re-opening from a different row remounts with
        // the new directory rather than keeping the first one's filter.
        <WorkspaceManagerModal
          key={managerFocus ?? "all"}
          repoCandidates={repoCandidates}
          focusCwd={managerFocus}
          onClose={() => setShowManager(false)}
          // Forced, not debounced: adopt/archive/rename have already written,
          // so any request in flight is answering from before the write.
          onChanged={forceRefresh}
        />
      )}
    </div>
  );
}
