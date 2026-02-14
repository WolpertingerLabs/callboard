import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ClipboardList, X, Plus, LogOut, Settings } from "lucide-react";
import { listChats, deleteChat, getSessionStatus, type Chat, type SessionStatus, type DefaultPermissions } from "../api";
import ChatListItem from "../components/ChatListItem";
import PermissionSettings from "../components/PermissionSettings";
import ConfirmModal from "../components/ConfirmModal";
import SettingsModal from "../components/SettingsModal";
import FolderSelector from "../components/FolderSelector";
import {
  getDefaultPermissions,
  saveDefaultPermissions,
  getRecentDirectories,
  addRecentDirectory,
  removeRecentDirectory,
  initializeSuggestedDirectories,
} from "../utils/localStorage";

interface ChatListProps {
  onLogout: () => void;
  onRefresh: (refreshFn: () => void) => void;
}

export default function ChatList({ onLogout, onRefresh }: ChatListProps) {
  const [chats, setChats] = useState<Chat[]>([]);
  const [sessionStatuses, setSessionStatuses] = useState<Map<string, SessionStatus>>(new Map());
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [folder, setFolder] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [defaultPermissions, setDefaultPermissions] = useState<DefaultPermissions>(getDefaultPermissions());
  const [recentDirs, setRecentDirs] = useState(() => getRecentDirectories().map((r) => r.path));
  const [confirmModal, setConfirmModal] = useState<{ isOpen: boolean; path: string }>({ isOpen: false, path: "" });
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<{ isOpen: boolean; chatId: string; chatName: string }>({
    isOpen: false,
    chatId: "",
    chatName: "",
  });
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    const response = await listChats(20, 0);
    setChats(response.chats);
    setHasMore(response.hasMore);

    // Initialize suggested directories from first three chat directories if none exist
    const chatDirectories = response.chats.map((chat) => chat.displayFolder || chat.folder);
    initializeSuggestedDirectories(chatDirectories);

    // Update the UI to reflect any new suggested directories
    updateRecentDirs();

    // Fetch session statuses for all chats
    const statuses = new Map<string, SessionStatus>();
    await Promise.all(
      response.chats.map(async (chat) => {
        try {
          const status = await getSessionStatus(chat.id);
          if (status.active) {
            statuses.set(chat.id, status);
          }
        } catch {} // Ignore errors for individual status checks
      }),
    );
    setSessionStatuses(statuses);
  };

  const loadMore = async () => {
    if (isLoadingMore || !hasMore) return;

    setIsLoadingMore(true);
    try {
      const response = await listChats(20, chats.length);
      setChats((prev) => [...prev, ...response.chats]);
      setHasMore(response.hasMore);

      // Fetch session statuses for new chats
      const statuses = new Map(sessionStatuses);
      await Promise.all(
        response.chats.map(async (chat) => {
          try {
            const status = await getSessionStatus(chat.id);
            if (status.active) {
              statuses.set(chat.id, status);
            }
          } catch {} // Ignore errors for individual status checks
        }),
      );
      setSessionStatuses(statuses);
    } finally {
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    load();
    onRefresh(load);
  }, [onRefresh]);

  const updateRecentDirs = () => {
    setRecentDirs(getRecentDirectories().map((r) => r.path));
  };

  const handleRemoveRecentDir = (path: string) => {
    setConfirmModal({ isOpen: true, path });
  };

  const confirmRemoveRecentDir = () => {
    removeRecentDirectory(confirmModal.path);
    updateRecentDirs();
    setConfirmModal({ isOpen: false, path: "" });
  };

  const handleCreate = (dir?: string) => {
    const target = dir || folder.trim();
    if (!target) return;

    // Save permissions and add to recent directories
    saveDefaultPermissions(defaultPermissions);
    addRecentDirectory(target);
    updateRecentDirs();

    // Navigate to new chat page with folder and permissions
    setFolder("");
    setShowNew(false);
    navigate(`/chat/new?folder=${encodeURIComponent(target)}`, {
      state: { defaultPermissions },
    });
  };

  const handleDelete = (chat: Chat) => {
    let chatPreview: string | undefined;
    try {
      const meta = JSON.parse(chat.metadata || "{}");
      chatPreview = meta.preview;
    } catch {}

    const displayName = chatPreview
      ? chatPreview.length > 60
        ? chatPreview.slice(0, 60) + "..."
        : chatPreview
      : (chat.displayFolder || chat.folder)?.split("/").pop() || chat.displayFolder || chat.folder || "Chat";
    setDeleteConfirmModal({ isOpen: true, chatId: chat.id, chatName: displayName });
  };

  const confirmDeleteChat = async () => {
    await deleteChat(deleteConfirmModal.chatId);
    setDeleteConfirmModal({ isOpen: false, chatId: "", chatName: "" });
    load();
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Claude Code</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => navigate("/queue")}
            style={{
              background: "var(--bg-secondary)",
              color: "var(--text)",
              padding: "10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="Drafts"
          >
            <ClipboardList size={18} />
          </button>
          <button
            onClick={() => setShowNew(!showNew)}
            style={{
              background: "var(--accent)",
              color: "#fff",
              padding: "10px",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="New Chat"
          >
            <Plus size={18} />
          </button>
          <button
            onClick={() => setShowSettings(true)}
            style={{
              background: "var(--bg-secondary)",
              color: "var(--text)",
              padding: "10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="Settings"
          >
            <Settings size={18} />
          </button>
          <button
            onClick={() => setLogoutConfirmOpen(true)}
            style={{
              background: "transparent",
              color: "var(--text)",
              padding: "10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="Logout"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {showNew && (
        <div
          style={{
            padding: "12px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <PermissionSettings permissions={defaultPermissions} onChange={setDefaultPermissions} />

          {recentDirs.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Recent directories</div>
              {recentDirs.map((dir) => (
                <div
                  key={dir}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    marginBottom: 4,
                  }}
                >
                  <button
                    onClick={() => handleCreate(dir)}
                    title={dir}
                    style={{
                      flex: 1,
                      textAlign: "left",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "10px 12px",
                      fontSize: 14,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      direction: "rtl",
                    }}
                  >
                    {dir}
                  </button>
                  <button
                    onClick={() => handleRemoveRecentDir(dir)}
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "8px",
                      fontSize: 12,
                      color: "var(--text-muted)",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      minWidth: 28,
                      height: 28,
                    }}
                    title={`Remove ${dir} from recent directories`}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  margin: "10px 0 6px",
                }}
              >
                Or enter a new path
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <FolderSelector value={folder} onChange={setFolder} placeholder="Project folder path (e.g. /home/user/myproject)" autoFocus />
            </div>
            <button
              onClick={() => handleCreate()}
              disabled={!folder.trim()}
              style={{
                background: folder.trim() ? "var(--accent)" : "var(--border)",
                color: "#fff",
                padding: "10px 16px",
                borderRadius: 8,
                fontSize: 14,
                alignSelf: "flex-start",
              }}
            >
              Create
            </button>
          </div>
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto" }}>
        {chats.length === 0 && <p style={{ padding: 20, color: "var(--text-muted)", textAlign: "center" }}>No chats yet. Create one to get started.</p>}
        {chats.map((chat) => (
          <ChatListItem
            key={chat.id}
            chat={chat}
            onClick={() => navigate(`/chat/${chat.id}`)}
            onDelete={() => handleDelete(chat)}
            sessionStatus={sessionStatuses.get(chat.id)}
          />
        ))}

        {hasMore && (
          <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)" }}>
            <button
              onClick={loadMore}
              disabled={isLoadingMore}
              style={{
                width: "100%",
                background: "var(--surface)",
                color: "var(--text)",
                padding: "12px 16px",
                borderRadius: 8,
                fontSize: 14,
                border: "1px solid var(--border)",
                cursor: isLoadingMore ? "default" : "pointer",
                opacity: isLoadingMore ? 0.6 : 1,
              }}
            >
              {isLoadingMore ? "Loading..." : "Load next page"}
            </button>
          </div>
        )}
      </div>

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal({ isOpen: false, path: "" })}
        onConfirm={confirmRemoveRecentDir}
        title="Remove Recent Directory"
        message={`Are you sure you want to remove "${confirmModal.path}" from your recent directories? This action cannot be undone.`}
        confirmText="Remove"
        confirmStyle="danger"
      />

      <ConfirmModal
        isOpen={deleteConfirmModal.isOpen}
        onClose={() => setDeleteConfirmModal({ isOpen: false, chatId: "", chatName: "" })}
        onConfirm={confirmDeleteChat}
        title="Delete Chat"
        message={`Are you sure you want to delete the chat "${deleteConfirmModal.chatName}"? This action cannot be undone.`}
        confirmText="Delete"
        confirmStyle="danger"
      />

      <ConfirmModal
        isOpen={logoutConfirmOpen}
        onClose={() => setLogoutConfirmOpen(false)}
        onConfirm={() => {
          setLogoutConfirmOpen(false);
          onLogout();
        }}
        title="Logout"
        message="Are you sure you want to log out?"
        confirmText="Logout"
        confirmStyle="danger"
      />

      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />
    </div>
  );
}
