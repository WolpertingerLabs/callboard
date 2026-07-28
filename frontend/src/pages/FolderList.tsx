import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { PanelLeftOpen, HardDrive, FolderGit2 } from "lucide-react";
import { listFolders, type FolderSummary } from "../api";
import { useSessionContext } from "../contexts/SessionContext";
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
  const now = useMemo(() => Date.now(), [folders]);

  const load = useCallback(async () => {
    try {
      const response = await listFolders(maxAgeDays, showSizes);
      setFolders(response.folders);
    } catch (err) {
      console.error("Failed to load folders:", err);
    } finally {
      setIsLoading(false);
    }
  }, [maxAgeDays, showSizes]);

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

  useEffect(() => {
    load();
  }, [load]);

  // Register refresh callback
  useEffect(() => {
    onRefresh(load);
  }, [onRefresh, load]);

  // Periodic refresh when sessions are active
  useEffect(() => {
    if (activeSessions.size === 0) return;
    const interval = setInterval(load, 15_000);
    return () => clearInterval(interval);
  }, [activeSessions.size, load]);

  // Refresh when sessions change
  useEffect(() => {
    const timer = setTimeout(load, 500);
    return () => clearTimeout(timer);
  }, [activeSessions.size, load]);

  // Refetch when chat metadata changes (status, summon, title) via SSE
  useEffect(() => {
    if (metadataVersion === 0) return;
    const timer = setTimeout(() => load(), 300);
    return () => clearTimeout(timer);
  }, [metadataVersion, load]);

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

  const handleNewChat = (folder: FolderSummary) => {
    if (folder.status === "waiting") {
      setConfirmModal({ isOpen: true, folder: folder.folder });
    } else {
      navigate(`/chat/new?folder=${encodeURIComponent(folder.folder)}`, {
        state: { defaultPermissions: getDefaultPermissions() },
      });
    }
  };

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
              onClick={() => navigate(`/chat/${folder.mostRecentChatId}`)}
              onNewChat={() => handleNewChat(folder)}
              now={now}
              onManageWorkspaces={() => {
                setManagerFocus(folder.folder);
                setShowManager(true);
              }}
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
          onChanged={load}
        />
      )}
    </div>
  );
}
