import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Plus, Settings, Bot, PanelLeftClose, PanelLeftOpen, ChevronDown, ChevronRight, AlertTriangle, FileText, FolderOpen, List } from "lucide-react";
import { listChats, deleteChat, toggleBookmark, fetchInstanceName, getDrafts, deleteDraft, type Chat, type QueueItem } from "../api";
import { useSessionContext } from "../contexts/SessionContext";
import ChatListItem from "../components/ChatListItem";
import DraftListItem from "../components/DraftListItem";
import ChatFilterBar from "../components/ChatFilterBar";
import NewChatPanel from "../components/NewChatPanel";
import ConfirmModal from "../components/ConfirmModal";
import { useChatSearch } from "../hooks/useChatSearch";
import { DEFAULT_CHAT_FILTERS, hasActiveFilters, type ChatFilters } from "../types/chatFilters";
import { initializeSuggestedDirectories, getShowTriggeredChats, saveShowTriggeredChats } from "../utils/localStorage";

interface ChatListProps {
  activeChatId?: string;
  onRefresh: (refreshFn: () => void) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  claudeLoggedIn?: boolean;
  onShowClaudeModal?: () => void;
  onViewModeChange?: () => void;
}

export default function ChatList({
  activeChatId,
  onRefresh,
  sidebarCollapsed,
  onToggleSidebar,
  claudeLoggedIn,
  onShowClaudeModal,
  onViewModeChange,
}: ChatListProps) {
  const { activeSessions, metadataVersion } = useSessionContext();
  const [chats, setChats] = useState<Chat[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [bookmarkFilter, setBookmarkFilter] = useState(false);
  const [showTriggered, setShowTriggered] = useState(() => getShowTriggeredChats());
  const [filters, setFilters] = useState<ChatFilters>(DEFAULT_CHAT_FILTERS);
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<{ isOpen: boolean; chatId: string; chatName: string }>({
    isOpen: false,
    chatId: "",
    chatName: "",
  });
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [instanceName, setInstanceName] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const isSettingsActive = location.pathname === "/settings";
  const isAgentsActive = location.pathname.startsWith("/agents");
  const [drafts, setDrafts] = useState<QueueItem[]>([]);
  const [stagingCollapsed, setStagingCollapsed] = useState(false);

  const loadDrafts = useCallback(async () => {
    try {
      const items = await getDrafts();
      setDrafts(items);
    } catch {
      // silently ignore — drafts are non-critical
    }
  }, []);

  const handleDeleteDraft = useCallback(
    async (id: string) => {
      try {
        await deleteDraft(id);
        await loadDrafts();
      } catch {}
    },
    [loadDrafts],
  );

  const handleDraftClick = useCallback(
    (draft: QueueItem) => {
      if (draft.chat_id) {
        navigate(`/chat/${draft.chat_id}`, {
          state: { draft: { id: draft.id, user_message: draft.user_message } },
        });
      } else if (draft.folder) {
        navigate(`/chat/new?folder=${encodeURIComponent(draft.folder)}`, {
          state: {
            defaultPermissions: draft.defaultPermissions,
            draft: { id: draft.id, user_message: draft.user_message },
          },
        });
      }
    },
    [navigate],
  );

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
      // When triggered chats are hidden, tell the API to exclude them so we
      // always get LIMIT real chats back (not LIMIT minus triggered ones)
      const excludeTriggered = !showTriggered;
      const response = await listChats(limit, 0, useFilter || undefined, excludeTriggered || undefined);
      setChats(response.chats);
      setHasMore(shouldFetchAll ? false : response.hasMore);

      // If the response was stale (cached), immediately fetch fresh data
      if (response.stale) {
        const freshResponse = await listChats(limit, 0, useFilter || undefined, excludeTriggered || undefined, false);
        setChats(freshResponse.chats);
        setHasMore(shouldFetchAll ? false : freshResponse.hasMore);
      }

      setIsInitialLoading(false);

      // Initialize suggested directories from first three chat directories if none exist
      if (!useFilter) {
        const chatDirectories = response.chats.map((chat) => chat.displayFolder || chat.folder);
        initializeSuggestedDirectories(chatDirectories);
      }
    },
    [bookmarkFilter, anyFilterActive, showTriggered],
  );

  const loadMore = async () => {
    if (isLoadingMore || !hasMore) return;

    setIsLoadingMore(true);
    try {
      const excludeTriggered = !showTriggered;
      const response = await listChats(20, chats.length, bookmarkFilter || undefined, excludeTriggered || undefined);
      setChats((prev) => [...prev, ...response.chats]);
      setHasMore(response.hasMore);
    } finally {
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    load();
    loadDrafts();
    onRefresh(() => {
      load();
      loadDrafts();
    });
  }, [onRefresh, load, loadDrafts]);

  useEffect(() => {
    fetchInstanceName()
      .then((name) => {
        setInstanceName(name);
        document.title = `Callboard / ${name}`;
      })
      .catch(() => {});
  }, []);

  // Refetch chat list when sessions start or stop (debounced to avoid rapid-fire
  // during new-chat migration: temp ID stop → real ID start).
  const prevSessionCountRef = useRef(activeSessions.size);
  useEffect(() => {
    // Skip the initial render — the load() above already fetched
    if (prevSessionCountRef.current === activeSessions.size && activeSessions.size === 0) return;
    prevSessionCountRef.current = activeSessions.size;

    const timer = setTimeout(() => load(), 500);
    return () => clearTimeout(timer);
  }, [activeSessions, load]);

  // Refetch when chat metadata changes (status, summon, title) via SSE
  useEffect(() => {
    if (metadataVersion === 0) return; // skip initial
    const timer = setTimeout(() => load(), 300);
    return () => clearTimeout(timer);
  }, [metadataVersion, load]);

  // While any session is active, periodically refetch the chat list to pick up
  // title changes, timestamp updates, and reordering.
  useEffect(() => {
    if (activeSessions.size === 0) return;

    const interval = setInterval(() => load(), 15_000);
    return () => clearInterval(interval);
  }, [activeSessions.size, load]);

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

  const handleChatClick = (chat: Chat) => {
    // Optimistically mark as read so the unread dot disappears immediately
    setChats((prev) =>
      prev.map((c) => {
        if (c.id !== chat.id) return c;
        try {
          const meta = JSON.parse(c.metadata || "{}");
          meta.lastReadAt = new Date().toISOString();
          return { ...c, metadata: JSON.stringify(meta) };
        } catch {
          return c;
        }
      }),
    );
    navigate(`/chat/${chat.id}`);
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
  // Note: triggered chat filtering is now handled server-side via excludeTriggered param
  const filteredChats = useMemo(() => {
    let result = chats;

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
  }, [chats, filters, matchingChatIds]);

  // Count triggered chats currently in the response (visible when showTriggered is ON)
  const triggeredCount = useMemo(() => {
    if (!showTriggered) return 0;
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
            color: "var(--chatlist-icon-active)",
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
            color: "var(--text-on-accent)",
            padding: "6px",
            borderRadius: 6,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          title="New Chat"
        >
          <Plus size={16} />
        </button>
        <button
          onClick={() => navigate("/agents")}
          style={{
            background: isAgentsActive ? "var(--accent)" : "var(--bg-secondary)",
            color: isAgentsActive ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
            padding: "6px",
            borderRadius: 6,
            border: isAgentsActive ? "none" : "1px solid var(--chatlist-item-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          title="Agents"
        >
          <Bot size={16} />
        </button>
        <button
          onClick={() => navigate("/settings")}
          style={{
            background: isSettingsActive ? "var(--accent)" : "var(--bg-secondary)",
            color: isSettingsActive ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
            padding: "6px",
            borderRadius: 6,
            border: isSettingsActive ? "none" : "1px solid var(--chatlist-item-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          title="Settings"
        >
          <Settings size={16} />
        </button>
        {claudeLoggedIn === false && onShowClaudeModal && (
          <button
            onClick={onShowClaudeModal}
            style={{
              background: "var(--warning-bg)",
              color: "var(--warning)",
              padding: "6px",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              marginTop: "auto",
            }}
            title="Claude Code login required"
          >
            <AlertTriangle size={16} />
          </button>
        )}
        {onToggleSidebar && (
          <button
            onClick={onToggleSidebar}
            style={{
              background: "transparent",
              color: "var(--chatlist-icon)",
              padding: "6px",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              ...(claudeLoggedIn !== false ? { marginTop: "auto" } : {}),
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
      <header
        style={{
          padding: "16px 20px",
          borderBottom: "1px solid var(--chatlist-header-border)",
          background: "var(--chatlist-header-bg)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 1, color: "var(--chatlist-title-text)" }}>Callboard</h1>
          {instanceName && <div style={{ fontSize: 10, color: "var(--chatlist-subtitle-text)", fontWeight: 400, letterSpacing: 0.3 }}>{instanceName}</div>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            onClick={() => setShowNew(!showNew)}
            style={{
              background: "var(--accent)",
              color: "var(--text-on-accent)",
              padding: "6px",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
            title="New Chat"
          >
            <Plus size={16} />
          </button>
          {onViewModeChange && (
            <div style={{ display: "flex" }}>
              <button
                onClick={onViewModeChange}
                style={{
                  background: "var(--bg-secondary)",
                  color: "var(--chatlist-icon-nav)",
                  padding: "6px",
                  borderTopLeftRadius: 6,
                  borderBottomLeftRadius: 6,
                  borderTopRightRadius: 0,
                  borderBottomRightRadius: 0,
                  border: "1px solid var(--chatlist-item-border)",
                  borderRight: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                title="Switch to folders view"
              >
                <FolderOpen size={16} />
              </button>
              <button
                style={{
                  background: "var(--accent)",
                  color: "var(--chatlist-icon-nav-active)",
                  padding: "6px",
                  borderTopLeftRadius: 0,
                  borderBottomLeftRadius: 0,
                  borderTopRightRadius: 6,
                  borderBottomRightRadius: 6,
                  border: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                title="Chats view (active)"
              >
                <List size={16} />
              </button>
            </div>
          )}
          <div style={{ display: "flex" }}>
            <button
              onClick={() => navigate("/agents")}
              style={{
                background: isAgentsActive ? "var(--accent)" : "var(--bg-secondary)",
                color: isAgentsActive ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
                padding: "6px",
                borderTopLeftRadius: 6,
                borderBottomLeftRadius: 6,
                borderTopRightRadius: 0,
                borderBottomRightRadius: 0,
                border: isAgentsActive ? "none" : "1px solid var(--chatlist-item-border)",
                borderRight: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="Agents"
            >
              <Bot size={16} />
            </button>
            <button
              onClick={() => navigate("/settings")}
              style={{
                background: isSettingsActive ? "var(--accent)" : "var(--bg-secondary)",
                color: isSettingsActive ? "var(--chatlist-icon-nav-active)" : "var(--chatlist-icon-nav)",
                padding: "6px",
                borderTopLeftRadius: 0,
                borderBottomLeftRadius: 0,
                borderTopRightRadius: 6,
                borderBottomRightRadius: 6,
                border: isSettingsActive ? "none" : "1px solid var(--chatlist-item-border)",
                borderLeft: "none",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="Settings"
            >
              <Settings size={16} />
            </button>
          </div>
          {claudeLoggedIn === false && onShowClaudeModal && (
            <button
              onClick={onShowClaudeModal}
              style={{
                background: "var(--warning-bg)",
                color: "var(--warning)",
                padding: "6px",
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="Claude Code login required"
            >
              <AlertTriangle size={16} />
            </button>
          )}
          {onToggleSidebar && (
            <button
              onClick={onToggleSidebar}
              style={{
                background: "transparent",
                color: "var(--chatlist-icon)",
                padding: "6px",
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              title="Collapse sidebar"
            >
              <PanelLeftClose size={16} />
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

      {showNew && <NewChatPanel onClose={() => setShowNew(false)} />}

      <div style={{ flex: 1, overflow: "auto" }}>
        {drafts.length > 0 && (
          <div style={{ borderBottom: "1px solid var(--chatlist-header-border)" }}>
            <button
              onClick={() => setStagingCollapsed(!stagingCollapsed)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "8px 20px",
                background: "none",
                border: "none",
                color: "var(--text-muted)",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {stagingCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <FileText size={13} />
              Staging ({drafts.length})
            </button>
            {!stagingCollapsed &&
              drafts.map((draft) => <DraftListItem key={draft.id} draft={draft} onClick={() => handleDraftClick(draft)} onDelete={handleDeleteDraft} />)}
          </div>
        )}

        {filteredChats.length === 0 && isInitialLoading && (
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: 40 }}>
            <div
              style={{
                width: 24,
                height: 24,
                border: "3px solid var(--border)",
                borderTopColor: "var(--accent)",
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        )}
        {filteredChats.length === 0 && !isInitialLoading && (
          <p style={{ padding: 20, color: "var(--chatlist-empty-text)", textAlign: "center" }}>
            {isFiltered ? "No chats match the current filters" : "No chats yet. Create one to get started."}
          </p>
        )}
        {filteredChats.map((chat) => (
          <ChatListItem
            key={chat.id}
            chat={chat}
            isActive={chat.id === activeChatId}
            onClick={() => handleChatClick(chat)}
            onDelete={() => handleDelete(chat)}
            onToggleBookmark={(bookmarked) => handleToggleBookmark(chat, bookmarked)}
            sessionStatus={activeSessions.has(chat.id) ? { active: true, type: activeSessions.get(chat.id)!.type } : undefined}
          />
        ))}

        {showTriggered && triggeredCount > 0 && (
          <div
            style={{
              padding: "8px 20px",
              textAlign: "center",
              fontSize: 12,
              color: "var(--chatlist-empty-text)",
            }}
          >
            Showing {triggeredCount} triggered {triggeredCount === 1 ? "chat" : "chats"}
          </div>
        )}

        {hasMore && !anyFilterActive && (
          <div style={{ padding: "16px 20px", borderTop: "1px solid var(--chatlist-item-border)" }}>
            <button
              onClick={loadMore}
              disabled={isLoadingMore}
              style={{
                width: "100%",
                background: "var(--chatlist-load-more-bg)",
                color: "var(--chatlist-load-more-text)",
                padding: "12px 16px",
                borderRadius: 8,
                fontSize: 14,
                border: "1px solid var(--chatlist-load-more-border)",
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
