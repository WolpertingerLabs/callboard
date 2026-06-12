import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { PanelLeftOpen } from "lucide-react";
import { listFolders, type FolderSummary } from "../api";
import { useSessionContext } from "../contexts/SessionContext";
import SidebarHeader from "../components/SidebarHeader";
import FolderListItem from "../components/FolderListItem";
import NewChatPanel from "../components/NewChatPanel";
import ConfirmModal from "../components/ConfirmModal";
import { getFolderMaxAgeDays, saveFolderMaxAgeDays, getDefaultPermissions, type SidebarViewMode } from "../utils/localStorage";

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
  const [isLoading, setIsLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{ isOpen: boolean; folder: string }>({ isOpen: false, folder: "" });
  const now = useMemo(() => Date.now(), [folders]);

  const load = useCallback(async () => {
    try {
      const response = await listFolders(maxAgeDays);
      setFolders(response.folders);
    } catch (err) {
      console.error("Failed to load folders:", err);
    } finally {
      setIsLoading(false);
    }
  }, [maxAgeDays]);

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
    </div>
  );
}
