import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ClipboardList, X, Plus, Settings, Bot, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { listChats, deleteChat, toggleBookmark, listAgents, getAgentIdentityPrompt, type Chat, type DefaultPermissions, type AgentConfig } from "../api";
import { useSessionContext } from "../contexts/SessionContext";
import ChatListItem from "../components/ChatListItem";
import ChatFilterBar from "../components/ChatFilterBar";
import PermissionSettings from "../components/PermissionSettings";
import ConfirmModal from "../components/ConfirmModal";
import FolderSelector from "../components/FolderSelector";
import { useChatSearch } from "../hooks/useChatSearch";
import { DEFAULT_CHAT_FILTERS, hasActiveFilters, type ChatFilters } from "../types/chatFilters";
import {
  getDefaultPermissions,
  saveDefaultPermissions,
  getRecentDirectories,
  addRecentDirectory,
  removeRecentDirectory,
  initializeSuggestedDirectories,
  getShowTriggeredChats,
  saveShowTriggeredChats,
} from "../utils/localStorage";

interface ChatListProps {
  activeChatId?: string;
  onRefresh: (refreshFn: () => void) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

export default function ChatList({ activeChatId, onRefresh, sidebarCollapsed, onToggleSidebar }: ChatListProps) {
  const { activeSessions } = useSessionContext();
  const [chats, setChats] = useState<Chat[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [bookmarkFilter, setBookmarkFilter] = useState(false);
  const [showTriggered, setShowTriggered] = useState(() => getShowTriggeredChats());
  const [filters, setFilters] = useState<ChatFilters>(DEFAULT_CHAT_FILTERS);
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
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
  const [chatMode, setChatMode] = useState<"claude-code" | "agent">("claude-code");
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<AgentConfig | null>(null);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const isQueueActive = location.pathname === "/queue";
  const isSettingsActive = location.pathname === "/settings";
  const isAgentsActive = location.pathname.startsWith("/agents");

  // Content search hook – only fires when user explicitly submits
  const { matchingChatIds, isSearching } = useChatSearch(submittedQuery);

  const handleSearchSubmit = () => {
    setSubmittedQuery(searchQuery);
  };

  // Determine if any filter is active (advanced filters, content search, or bookmarks)
  const anyFilterActive = hasActiveFilters(filters) || matchingChatIds !== null;

  const load = useCallback(
    async (filterOverride?: boolean) => {
      const useFilter = filterOverride !== undefined ? filterOverride : bookmarkFilter;
      // When advanced filters or content search are active, fetch all chats
      // to avoid missing matches due to pagination
      const shouldFetchAll = anyFilterActive || useFilter;
      const limit = shouldFetchAll ? 9999 : 20;
      const response = await listChats(limit, 0, useFilter || undefined);
      setChats(response.chats);
      setHasMore(shouldFetchAll ? false : response.hasMore);

      // Initialize suggested directories from first three chat directories if none exist
      if (!useFilter) {
        const chatDirectories = response.chats.map((chat) => chat.displayFolder || chat.folder);
        initializeSuggestedDirectories(chatDirectories);
      }

      // Update the UI to reflect any new suggested directories
      updateRecentDirs();
    },
    [bookmarkFilter, anyFilterActive],
  );

  const loadMore = async () => {
    if (isLoadingMore || !hasMore) return;

    setIsLoadingMore(true);
    try {
      const response = await listChats(20, chats.length, bookmarkFilter || undefined);
      setChats((prev) => [...prev, ...response.chats]);
      setHasMore(response.hasMore);
    } finally {
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    load();
    onRefresh(() => load());
  }, [onRefresh, load]);

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

  const handleAgentCreate = async () => {
    if (!selectedAgent?.workspacePath) return;

    const agentPermissions: DefaultPermissions = {
      fileRead: "allow",
      fileWrite: "allow",
      codeExecution: "allow",
      webAccess: "allow",
    };

    // Fetch compiled identity prompt for the agent
    let systemPrompt: string | undefined;
    try {
      systemPrompt = await getAgentIdentityPrompt(selectedAgent.alias);
    } catch {
      // Continue without identity prompt if fetch fails
    }

    setShowNew(false);
    setSelectedAgent(null);
    navigate(`/chat/new?folder=${encodeURIComponent(selectedAgent.workspacePath)}`, {
      state: { defaultPermissions: agentPermissions, systemPrompt, agentAlias: selectedAgent.alias },
    });
  };

  // Lazy fetch agents when agent mode is first selected
  useEffect(() => {
    if (chatMode !== "agent" || agents.length > 0) return;
    setAgentsLoading(true);
    listAgents()
      .then(setAgents)
      .catch(() => {})
      .finally(() => setAgentsLoading(false));
  }, [chatMode, agents.length]);

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

  const handleToggleBookmark = async (chat: Chat, bookmarked: boolean) => {
    try {
      await toggleBookmark(chat.id, bookmarked);
      if (bookmarkFilter && !bookmarked) {
        // When filter is active and unbookmarking, remove from list
        setChats((prev) => prev.filter((c) => c.id !== chat.id));
      } else {
        // Optimistically update local state
        setChats((prev) =>
          prev.map((c) => {
            if (c.id !== chat.id) return c;
            try {
              const meta = JSON.parse(c.metadata || "{}");
              meta.bookmarked = bookmarked;
              return { ...c, metadata: JSON.stringify(meta) };
            } catch {
              return c;
            }
          }),
        );
      }
    } catch (err) {
      console.error("Failed to toggle bookmark:", err);
    }
  };

  const handleToggleBookmarkFilter = () => {
    const newFilter = !bookmarkFilter;
    setBookmarkFilter(newFilter);
    load(newFilter);
  };

  const handleToggleTriggered = () => {
    const newValue = !showTriggered;
    setShowTriggered(newValue);
    saveShowTriggeredChats(newValue);
  };

  // Client-side filtering for advanced filters and content search
  const filteredChats = useMemo(() => {
    let result = chats;

    // Hide triggered chats unless toggle is ON
    if (!showTriggered) {
      result = result.filter((c) => {
        try {
          return !JSON.parse(c.metadata || "{}").triggered;
        } catch {
          return true;
        }
      });
    }

    // Directory include regex
    if (filters.directoryInclude.active && filters.directoryInclude.value) {
      try {
        const regex = new RegExp(filters.directoryInclude.value, "i");
        result = result.filter((c) => regex.test(c.displayFolder || c.folder));
      } catch {
        /* invalid regex, skip */
      }
    }

    // Directory exclude regex
    if (filters.directoryExclude.active && filters.directoryExclude.value) {
      try {
        const regex = new RegExp(filters.directoryExclude.value, "i");
        result = result.filter((c) => !regex.test(c.displayFolder || c.folder));
      } catch {
        /* invalid regex, skip */
      }
    }

    // Date min
    if (filters.dateMin.active && filters.dateMin.value) {
      const minTime = new Date(filters.dateMin.value).getTime();
      result = result.filter((c) => new Date(c.updated_at).getTime() >= minTime);
    }

    // Date max
    if (filters.dateMax.active && filters.dateMax.value) {
      const maxTime = new Date(filters.dateMax.value).getTime();
      result = result.filter((c) => new Date(c.updated_at).getTime() <= maxTime);
    }

    // Content search
    if (matchingChatIds !== null) {
      result = result.filter((c) => matchingChatIds.has(c.id));
    }

    return result;
  }, [chats, filters, matchingChatIds, showTriggered]);

  // Count triggered chats that are currently hidden by the filter
  const hiddenTriggeredCount = useMemo(() => {
    if (showTriggered) return 0;
    return chats.filter((c) => {
      try {
        return JSON.parse(c.metadata || "{}").triggered;
      } catch {
        return false;
      }
    }).length;
  }, [chats, showTriggered]);

  // Determine the empty state message
  const isFiltered = bookmarkFilter || hasActiveFilters(filters) || matchingChatIds !== null;

  // Collapsed sidebar view — icon rail with logo + vertical buttons
  if (sidebarCollapsed) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          paddingTop: 16,
          gap: 8,
        }}
      >
        <div
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: "var(--accent)",
            marginBottom: 8,
            userSelect: "none",
          }}
        >
          C
        </div>
        <button
          onClick={() => {
            if (sidebarCollapsed && onToggleSidebar) {
              onToggleSidebar();
            }
            setShowNew(true);
          }}
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
          onClick={() => navigate("/queue")}
          style={{
            background: isQueueActive ? "var(--accent)" : "var(--bg-secondary)",
            color: isQueueActive ? "#fff" : "var(--text)",
            padding: "10px",
            borderRadius: 8,
            border: isQueueActive ? "none" : "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          title="Drafts"
        >
          <ClipboardList size={18} />
        </button>
        <button
          onClick={() => navigate("/agents")}
          style={{
            background: isAgentsActive ? "var(--accent)" : "var(--bg-secondary)",
            color: isAgentsActive ? "#fff" : "var(--text)",
            padding: "10px",
            borderRadius: 8,
            border: isAgentsActive ? "none" : "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          title="Agents"
        >
          <Bot size={18} />
        </button>
        <button
          onClick={() => navigate("/settings")}
          style={{
            background: isSettingsActive ? "var(--accent)" : "var(--bg-secondary)",
            color: isSettingsActive ? "#fff" : "var(--text)",
            padding: "10px",
            borderRadius: 8,
            border: isSettingsActive ? "none" : "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          title="Settings"
        >
          <Settings size={18} />
        </button>
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            style={{
              background: "transparent",
              color: "var(--text-muted)",
              padding: "10px",
              borderRadius: 8,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginTop: "auto",
              marginBottom: 16,
            }}
            title="Expand sidebar"
          >
            <PanelLeftOpen size={18} />
          </button>
        )}
      </div>
    );
  }

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
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>Callboard</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
          <div style={{ display: "flex" }}>
            <button
              onClick={() => navigate("/queue")}
              style={{
                background: isQueueActive ? "var(--accent)" : "var(--bg-secondary)",
                color: isQueueActive ? "#fff" : "var(--text)",
                padding: "10px",
                borderTopLeftRadius: 8,
                borderBottomLeftRadius: 8,
                borderTopRightRadius: 0,
                borderBottomRightRadius: 0,
                border: isQueueActive ? "none" : "1px solid var(--border)",
                borderRight: isQueueActive ? "none" : "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="Drafts"
            >
              <ClipboardList size={18} />
            </button>
            <button
              onClick={() => navigate("/agents")}
              style={{
                background: isAgentsActive ? "var(--accent)" : "var(--bg-secondary)",
                color: isAgentsActive ? "#fff" : "var(--text)",
                padding: "10px",
                borderRadius: 0,
                border: isAgentsActive ? "none" : "1px solid var(--border)",
                borderLeft: "none",
                borderRight: isAgentsActive ? "none" : "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="Agents"
            >
              <Bot size={18} />
            </button>
            <button
              onClick={() => navigate("/settings")}
              style={{
                background: isSettingsActive ? "var(--accent)" : "var(--bg-secondary)",
                color: isSettingsActive ? "#fff" : "var(--text)",
                padding: "10px",
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
                borderTopRightRadius: 8,
                borderBottomRightRadius: 8,
                border: isSettingsActive ? "none" : "1px solid var(--border)",
                borderLeft: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="Settings"
            >
              <Settings size={18} />
            </button>
          </div>
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              style={{
                background: "transparent",
                color: "var(--text-muted)",
                padding: "6px",
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="Collapse sidebar"
            >
              <PanelLeftClose size={18} />
            </button>
          )}
        </div>
      </header>

      <ChatFilterBar
        bookmarkFilter={bookmarkFilter}
        onToggleBookmark={handleToggleBookmarkFilter}
        showTriggered={showTriggered}
        onToggleTriggered={handleToggleTriggered}
        filters={filters}
        onFiltersChange={setFilters}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        onSearchSubmit={handleSearchSubmit}
        isSearching={isSearching}
      />

      {showNew && (
        <div
          style={{
            padding: "12px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {/* Mode Toggle */}
          <div style={{ display: "flex", marginBottom: 12 }}>
            <button
              onClick={() => {
                setChatMode("claude-code");
                setSelectedAgent(null);
              }}
              style={{
                flex: 1,
                padding: "10px 16px",
                fontSize: 14,
                fontWeight: 500,
                borderRadius: "8px 0 0 8px",
                border: chatMode === "claude-code" ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: chatMode === "claude-code" ? "var(--accent)" : "var(--bg-secondary)",
                color: chatMode === "claude-code" ? "#fff" : "var(--text)",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              Callboard
            </button>
            <button
              onClick={() => setChatMode("agent")}
              style={{
                flex: 1,
                padding: "10px 16px",
                fontSize: 14,
                fontWeight: 500,
                borderRadius: "0 8px 8px 0",
                border: chatMode === "agent" ? "1px solid var(--accent)" : "1px solid var(--border)",
                borderLeft: "none",
                background: chatMode === "agent" ? "var(--accent)" : "var(--bg-secondary)",
                color: chatMode === "agent" ? "#fff" : "var(--text)",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              Agent
            </button>
          </div>

          {chatMode === "claude-code" ? (
            <>
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
            </>
          ) : (
            <>
              {agentsLoading ? (
                <div style={{ padding: "20px 0", textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>Loading agents...</div>
              ) : agents.length === 0 ? (
                <div style={{ padding: "20px 0", textAlign: "center" }}>
                  <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 12 }}>No agents yet.</p>
                  <button
                    onClick={() => navigate("/agents/new")}
                    style={{
                      background: "var(--accent)",
                      color: "#fff",
                      padding: "8px 16px",
                      borderRadius: 8,
                      fontSize: 14,
                      fontWeight: 500,
                    }}
                  >
                    Create Agent
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 2 }}>Select an agent</div>
                  {agents.map((agent) => (
                    <button
                      key={agent.alias}
                      onClick={() => setSelectedAgent(selectedAgent?.alias === agent.alias ? null : agent)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        textAlign: "left",
                        background: selectedAgent?.alias === agent.alias ? "color-mix(in srgb, var(--accent) 15%, var(--surface))" : "var(--surface)",
                        border: selectedAgent?.alias === agent.alias ? "1.5px solid var(--accent)" : "1px solid var(--border)",
                        borderRadius: 8,
                        padding: "10px 12px",
                        cursor: "pointer",
                        transition: "border-color 0.15s",
                      }}
                    >
                      <div
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: "50%",
                          background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                        }}
                      >
                        <Bot size={16} style={{ color: "var(--accent)" }} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 500 }}>{agent.name}</div>
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--text-muted)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {agent.description}
                        </div>
                      </div>
                    </button>
                  ))}

                  <button
                    onClick={handleAgentCreate}
                    disabled={!selectedAgent}
                    style={{
                      marginTop: 6,
                      background: selectedAgent ? "var(--accent)" : "var(--border)",
                      color: "#fff",
                      padding: "10px 16px",
                      borderRadius: 8,
                      fontSize: 14,
                      fontWeight: 500,
                      transition: "background 0.15s",
                    }}
                  >
                    Start Chat
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div style={{ flex: 1, overflow: "auto" }}>
        {filteredChats.length === 0 && (
          <p style={{ padding: 20, color: "var(--text-muted)", textAlign: "center" }}>
            {isFiltered ? "No chats match the current filters" : "No chats yet. Create one to get started."}
          </p>
        )}
        {filteredChats.map((chat) => (
          <ChatListItem
            key={chat.id}
            chat={chat}
            isActive={chat.id === activeChatId}
            onClick={() => navigate(`/chat/${chat.id}`)}
            onDelete={() => handleDelete(chat)}
            onToggleBookmark={(bookmarked) => handleToggleBookmark(chat, bookmarked)}
            sessionStatus={activeSessions.has(chat.id) ? { active: true, type: activeSessions.get(chat.id)!.type } : undefined}
          />
        ))}

        {hiddenTriggeredCount > 0 && (
          <div
            style={{
              padding: "8px 20px",
              textAlign: "center",
              fontSize: 12,
              color: "var(--text-muted)",
            }}
          >
            {hiddenTriggeredCount} triggered {hiddenTriggeredCount === 1 ? "chat" : "chats"} hidden
          </div>
        )}

        {hasMore && !anyFilterActive && (
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
    </div>
  );
}
