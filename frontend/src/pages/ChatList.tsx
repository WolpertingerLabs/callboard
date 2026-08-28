import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Plus, Settings, Bot, PanelLeftOpen, ChevronDown, ChevronRight, AlertTriangle, FileText } from "lucide-react";
import {
  listChats,
  deleteChat,
  toggleBookmark,
  regenerateChatTitle,
  getDrafts,
  deleteDraft,
  listCards,
  updateCard,
  type Chat,
  type QueueItem,
  type CardSummary,
} from "../api";
import { useSessionContext } from "../contexts/SessionContext";
import SidebarHeader from "../components/SidebarHeader";
import { type ChatCardMenu } from "../components/ChatListItem";
import ChatTreeList from "../components/ChatTreeList";
import DraftListItem from "../components/DraftListItem";
import ChatFilterBar from "../components/ChatFilterBar";
import NewChatPanel from "../components/NewChatPanel";
import ConfirmModal from "../components/ConfirmModal";
import { useChatSearch } from "../hooks/useChatSearch";
import { chatCardId, isChatDimmed } from "../utils/chatDimming";
import { activeSectionPredicate } from "../utils/chatSections";
import {
  DEFAULT_CHAT_FILTERS,
  DEFAULT_CHAT_VIEW_OPTIONS,
  activeViewOptionCount,
  hasActiveFilters,
  type ChatFilters,
  type ChatViewOptions,
} from "../types/chatFilters";
import {
  initializeSuggestedDirectories,
  getShowTriggeredChats,
  saveShowTriggeredChats,
  getChatsCardLifecycle,
  saveChatsCardLifecycle,
  getChatsDimCardless,
  saveChatsDimCardless,
  getChatsSortByCardActive,
  saveChatsSortByCardActive,
  type SidebarViewMode,
} from "../utils/localStorage";

interface ChatListProps {
  activeChatId?: string;
  onRefresh: (refreshFn: () => void) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  claudeLoggedIn?: boolean;
  onShowClaudeModal?: () => void;
  onViewModeChange?: (mode: SidebarViewMode) => void;
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
  // Tree rows currently shown (grows via "load more"): a parentage group folds
  // into one row, and the server paginates by rows so a page is always a full
  // page of visible entries. Refreshes refetch this many so an expanded list
  // isn't cut back to the first page.
  const loadedCountRef = useRef(20);
  // Bumped every time a full refresh replaces the list (which re-baselines
  // loadedCountRef). An in-flight "load more" page from before the bump has a
  // stale offset — drop it.
  const loadGenRef = useRef(0);
  // Same signal as loadGenRef, but as state so the tree view can react to it:
  // fetched subtrees are snapshots and go stale when the list refreshes.
  const [listVersion, setListVersion] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // Scope, all edited together in the filters modal. All but one are
  // remembered across reloads; `bookmarked` stays session-only, the way it has
  // always behaved.
  const [viewOptions, setViewOptions] = useState<ChatViewOptions>(() => ({
    ...DEFAULT_CHAT_VIEW_OPTIONS,
    showTriggered: getShowTriggeredChats(),
    cardLifecycle: getChatsCardLifecycle(),
    // The deprecated alias, kept consistent with the scope above so nothing
    // reading the pair (a downgraded bundle, a stale persisted store) sees
    // them disagree.
    cardsOnly: getChatsCardLifecycle() === "active",
    dimCardless: getChatsDimCardless(),
    sortByCardActive: getChatsSortByCardActive(),
  }));
  const [filters, setFilters] = useState<ChatFilters>(DEFAULT_CHAT_FILTERS);
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<{ isOpen: boolean; chatId: string; chatName: string }>({
    isOpen: false,
    chatId: "",
    chatName: "",
  });
  const [regenerateTitleModal, setRegenerateTitleModal] = useState<{ isOpen: boolean; chatId: string; chatName: string }>({
    isOpen: false,
    chatId: "",
    chatName: "",
  });
  /**
   * Chats with a title regeneration in flight, and the reason the set lives up
   * here rather than in the row that renders the disabled entry: a refresh —
   * the 15s poll, an SSE metadata bump, a filter change — can change a row's
   * shape as well as its contents. A chat that gains a relative folds into a
   * lineage group, and one whose card closes moves to the Inactive section;
   * either remounts the `ChatListItem`, dropping any state it held mid-request
   * and re-enabling the entry — the double-fire this lock exists to prevent.
   * Purely client-side: a page reload clears it, and that is fine.
   */
  const [regeneratingTitleIds, setRegeneratingTitleIds] = useState<Set<string>>(new Set());
  // Card-picker modal state for the per-chat "Add to card…" action.
  // Every card, kept loaded rather than fetched when the picker opens: the row
  // menu needs each filed chat's card lifecycle to label Close vs Reopen, and
  // the sidebar is the one place all card actions live now.
  const [cards, setCards] = useState<CardSummary[]>([]);
  // Whether the first listCards has come back. Only the dim reads it, and only
  // because an empty `cards` is indistinguishable from "none of these chats has
  // a card" — see utils/chatDimming. Stays false if the fetch fails, which is
  // the right way round: nothing dims rather than everything.
  const [cardsLoaded, setCardsLoaded] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const navigate = useNavigate();
  const location = useLocation();
  const isSettingsActive = location.pathname === "/settings";
  const isAgentsActive = location.pathname.startsWith("/agents");
  const [drafts, setDrafts] = useState<QueueItem[]>([]);
  const [stagingCollapsed, setStagingCollapsed] = useState(false);

  const loadCards = useCallback(async () => {
    try {
      const res = await listCards();
      setCards(res.cards);
      setCardsLoaded(true);
    } catch {
      // Non-critical: the row menu simply omits the lifecycle entry (it never
      // guesses a label) until a later refresh lands.
    }
  }, []);

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

  const load = useCallback(async () => {
    const { bookmarked, showTriggered, cardLifecycle } = viewOptions;
    // When advanced filters or content search are active, fetch all chats
    // to avoid missing matches due to pagination
    const shouldFetchAll = anyFilterActive || bookmarked;
    const limit = shouldFetchAll ? 9999 : Math.max(20, loadedCountRef.current);
    // When triggered chats are hidden, tell the API to exclude them so we
    // always get LIMIT real chats back (not LIMIT minus triggered ones)
    const excludeTriggered = !showTriggered;
    // includeLineage is always on: the list needs every member of a parentage
    // tree the page touches, even those outside the pagination window
    const response = await listChats(limit, 0, bookmarked || undefined, excludeTriggered || undefined, undefined, true, undefined, cardLifecycle);
    loadGenRef.current += 1;
    setListVersion((v) => v + 1);
    setChats(response.chats);
    setHasMore(shouldFetchAll ? false : response.hasMore);
    if (!shouldFetchAll) loadedCountRef.current = response.windowRows;

    // If the response was stale (cached), immediately fetch fresh data
    if (response.stale) {
      const freshResponse = await listChats(limit, 0, bookmarked || undefined, excludeTriggered || undefined, false, true, undefined, cardLifecycle);
      loadGenRef.current += 1;
      setListVersion((v) => v + 1);
      setChats(freshResponse.chats);
      setHasMore(shouldFetchAll ? false : freshResponse.hasMore);
      if (!shouldFetchAll) loadedCountRef.current = freshResponse.windowRows;
    }

    setIsInitialLoading(false);

    // Initialize suggested directories from first three chat directories if none exist
    if (!bookmarked) {
      const chatDirectories = response.chats.map((chat) => chat.displayFolder || chat.folder);
      initializeSuggestedDirectories(chatDirectories);
    }
  }, [viewOptions, anyFilterActive]);

  const loadMore = async () => {
    if (isLoadingMore || !hasMore) return;

    setIsLoadingMore(true);
    try {
      const gen = loadGenRef.current;
      const excludeTriggered = !viewOptions.showTriggered;
      // Offset advances by the server-reported window size (tree rows) —
      // lineage-appended relatives sit outside the pagination window
      const response = await listChats(
        20,
        loadedCountRef.current,
        viewOptions.bookmarked || undefined,
        excludeTriggered || undefined,
        undefined,
        true,
        undefined,
        viewOptions.cardLifecycle,
      );
      // A refresh (filter toggle, SSE event, poll) replaced the list while
      // this page was in flight — its offset no longer lines up, so drop the
      // stale page.
      if (gen !== loadGenRef.current) return;
      // Later pages can re-include chats already appended as lineage relatives
      setChats((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...response.chats.filter((c) => !seen.has(c.id))];
      });
      setHasMore(response.hasMore);
      loadedCountRef.current += response.windowRows;
    } finally {
      setIsLoadingMore(false);
    }
  };

  useEffect(() => {
    load();
    loadDrafts();
    loadCards();
    onRefresh(() => {
      load();
      loadDrafts();
      loadCards();
    });
  }, [onRefresh, load, loadDrafts, loadCards]);

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

  // Refetch when chat metadata changes (status, summon, title) via SSE. Card
  // events ride the same signal, so the row menu's lifecycle labels follow a
  // close/reopen done on the board.
  useEffect(() => {
    if (metadataVersion === 0) return; // skip initial
    const timer = setTimeout(() => {
      load();
      loadCards();
    }, 300);
    return () => clearTimeout(timer);
  }, [metadataVersion, load, loadCards]);

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

  /** Open the confirmation. Nothing is requested until the user confirms. */
  const handleRegenerateTitle = (chat: Chat) => {
    let displayName = (chat.displayFolder || chat.folder)?.split("/").pop() || "Chat";
    try {
      const meta = JSON.parse(chat.metadata || "{}");
      // Whatever the row is currently labelled with, so the prompt names the
      // title that is about to be replaced.
      displayName = meta.title || meta.preview || displayName;
    } catch {}
    if (displayName.length > 60) displayName = displayName.slice(0, 60) + "...";
    setRegenerateTitleModal({ isOpen: true, chatId: chat.id, chatName: displayName });
  };

  const confirmRegenerateTitle = async () => {
    // Read before the awaits: ConfirmModal closes itself on confirm, which
    // blanks the modal state this id lives in.
    const chatId = regenerateTitleModal.chatId;
    if (!chatId) return;
    setRegeneratingTitleIds((prev) => new Set(prev).add(chatId));
    try {
      const { title } = await regenerateChatTitle(chatId);
      // Reflect it now rather than waiting for the next refetch — the write
      // has already landed server-side, and the row is what the user is
      // looking at.
      setChats((prev) =>
        prev.map((c) => {
          if (c.id !== chatId) return c;
          try {
            const meta = JSON.parse(c.metadata || "{}");
            meta.title = title;
            return { ...c, metadata: JSON.stringify(meta) };
          } catch {
            return c;
          }
        }),
      );
    } catch (err) {
      console.error("Failed to regenerate chat title:", err);
    } finally {
      // In a finally so a failed request releases the row instead of wedging
      // its menu entry disabled for the life of the page.
      setRegeneratingTitleIds((prev) => {
        const next = new Set(prev);
        next.delete(chatId);
        return next;
      });
    }
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
      if (viewOptions.bookmarked && !bookmarked) {
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

  const cardsById = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  // Authoritative chat→card lookup from the server rollup. Root stamps were
  // added after forkedFrom, so deriving from one chat's metadata alone cannot
  // resolve every multi-level legacy tree. Indexing memberChats handles both
  // those records and descendants promoted after a deleted ancestor.
  const cardsByChatId = useMemo(() => {
    const byChat = new Map<string, CardSummary>();
    for (const card of cards) {
      byChat.set(card.id, card);
      for (const member of card.memberChats) byChat.set(member.chatId, card);
    }
    return byChat;
  }, [cards]);

  /** The card a chat's lineage root is, when it is one and we've loaded it. */
  const cardOf = (chat: Chat): CardSummary | undefined => {
    const direct = cardsByChatId.get(chat.id);
    if (direct) return direct;
    const id = chatCardId(chat);
    return id ? cardsById.get(id) : undefined;
  };

  /**
   * "Dim inactive chats": fade rows whose card is closed or absent. Purely a
   * render decision over cards already on the page — no request changes, which
   * is why it is a view option and not a filter.
   */
  const isDimmed = (chat: Chat): boolean => isChatDimmed(chat, cardsByChatId, { dimCardless: viewOptions.dimCardless, cardsLoaded });

  /**
   * "Active cards first": the per-chat verdict the Active/Inactive split reads,
   * or `undefined` for "render as if the option were off" — which `cardsLoaded`
   * makes load-bearing, for the reason spelled out at the predicate itself.
   */
  const isCardActive = activeSectionPredicate(cardsByChatId, { sortByCardActive: viewOptions.sortByCardActive, cardsLoaded });

  const handleToggleCardLifecycle = async (chat: Chat) => {
    const card = cardOf(chat);
    if (!card) return;
    try {
      const res = await updateCard(card.id, { lifecycle: card.lifecycle === "open" ? "closed" : "open" });
      setCards((prev) => prev.map((c) => (c.id === res.card.id ? res.card : c)));
    } catch (err) {
      console.error("Failed to change card lifecycle:", err);
    }
  };

  /** Every card action for one row's kebab menu. The only one left is the
   * lifecycle toggle — membership is lineage now, so there is nothing to
   * create, join, or leave: a top-level chat is a card the moment it exists. */
  const cardMenuFor = (chat: Chat): ChatCardMenu => {
    const card = cardOf(chat);
    return {
      ...(card && { card: { title: card.title, lifecycle: card.lifecycle } }),
      onToggleLifecycle: () => handleToggleCardLifecycle(chat),
    };
  };

  /**
   * Commit both halves of the filters modal. No explicit reload: `load` closes
   * over `viewOptions`, so changing it recreates the callback and the effect
   * that depends on it refetches.
   */
  const handleApplyFilters = (nextFilters: ChatFilters, nextView: ChatViewOptions) => {
    setFilters(nextFilters);
    setViewOptions(nextView);
    saveShowTriggeredChats(nextView.showTriggered);
    saveChatsCardLifecycle(nextView.cardLifecycle);
    saveChatsDimCardless(nextView.dimCardless);
    saveChatsSortByCardActive(nextView.sortByCardActive);
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

  // Count triggered chats currently in the response (visible when "Show triggered chats" is ON)
  const triggeredCount = useMemo(() => {
    if (!viewOptions.showTriggered) return 0;
    return chats.filter((c) => {
      try {
        return JSON.parse(c.metadata || "{}").triggered;
      } catch {
        return false;
      }
    }).length;
  }, [chats, viewOptions.showTriggered]);

  // Determine the empty state message. `dimCardless` and `sortByCardActive`
  // are normalised away first: one fades rows and the other reorders them, and
  // neither ever removes one, so an empty list is never their doing and "No
  // chats match the current filters" would be a lie. They still count toward
  // the filter button's badge, where "you have changed the view" is exactly
  // what the badge means.
  const isFiltered =
    activeViewOptionCount({
      ...viewOptions,
      dimCardless: DEFAULT_CHAT_VIEW_OPTIONS.dimCardless,
      sortByCardActive: DEFAULT_CHAT_VIEW_OPTIONS.sortByCardActive,
    }) > 0 ||
    hasActiveFilters(filters) ||
    matchingChatIds !== null;

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
      <SidebarHeader
        viewMode="chats"
        onToggleNew={() => setShowNew(!showNew)}
        onViewModeChange={onViewModeChange}
        claudeLoggedIn={claudeLoggedIn}
        onShowClaudeModal={onShowClaudeModal}
        onToggleSidebar={onToggleSidebar}
      />

      <ChatFilterBar
        filters={filters}
        viewOptions={viewOptions}
        onApply={handleApplyFilters}
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
        <ChatTreeList
          chats={filteredChats}
          refreshToken={listVersion}
          activeChatId={activeChatId}
          onChatClick={handleChatClick}
          onDelete={handleDelete}
          onToggleBookmark={handleToggleBookmark}
          onRegenerateTitle={handleRegenerateTitle}
          regeneratingTitleIds={regeneratingTitleIds}
          cardMenuFor={cardMenuFor}
          sessionStatusFor={(chatId) => (activeSessions.has(chatId) ? { active: true, type: activeSessions.get(chatId)!.type } : undefined)}
          isDimmed={isDimmed}
          // The predicate, not a pre-sorted list: the tree collapses a
          // lineage group into one row and must file it whole.
          isCardActive={isCardActive}
        />

        {viewOptions.showTriggered && triggeredCount > 0 && (
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

      <ConfirmModal
        isOpen={regenerateTitleModal.isOpen}
        onClose={() => setRegenerateTitleModal({ isOpen: false, chatId: "", chatName: "" })}
        onConfirm={confirmRegenerateTitle}
        title="Regenerate Title"
        message={`Replace the title of "${regenerateTitleModal.chatName}" with one derived from the chat's current contents?`}
        confirmText="Regenerate"
      />
    </div>
  );
}
