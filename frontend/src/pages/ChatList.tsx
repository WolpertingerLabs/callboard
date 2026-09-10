import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Plus, Settings, Bot, PanelLeftOpen, ChevronDown, ChevronRight, AlertTriangle, FileText } from "lucide-react";
import {
  listChats,
  deleteChat,
  bulkDeleteChats,
  bulkSetCardLifecycle,
  toggleBookmark,
  togglePin,
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
import ChatTreeList, { buildRows } from "../components/ChatTreeList";
import SelectionBar, { type SelectionAction } from "../components/SelectionBar";
import { useIsMobile } from "../hooks/useIsMobile";
import DraftListItem from "../components/DraftListItem";
import ChatFilterBar from "../components/ChatFilterBar";
import NewChatPanel from "../components/NewChatPanel";
import ConfirmModal from "../components/ConfirmModal";
import EditTitleModal from "../components/EditTitleModal";
import { useChatSearch } from "../hooks/useChatSearch";
import { chatCardId, isChatDimmed } from "../utils/chatDimming";
import {
  DEFAULT_CHAT_FILTERS,
  DEFAULT_CHAT_VIEW_OPTIONS,
  cardLifecycleFor,
  hasActiveFilters,
  type ChatFilters,
  type ChatViewOptions,
} from "../types/chatFilters";
import {
  initializeSuggestedDirectories,
  getShowTriggeredChats,
  saveShowTriggeredChats,
  getChatsShowArchived,
  saveChatsShowArchived,
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

/**
 * Authoritative chat→card lookup from the server rollup. Root stamps were
 * added after forkedFrom, so deriving from one chat's metadata alone cannot
 * resolve every multi-level legacy tree. Indexing memberChats handles both
 * those records and descendants promoted after a deleted ancestor.
 *
 * Takes the card list rather than reading one, because the sidebar keeps two:
 * board cards for the row menu and every card for the dim. See `boardCards`.
 */
function indexByChat(list: CardSummary[]): Map<string, CardSummary> {
  const byChat = new Map<string, CardSummary>();
  for (const card of list) {
    byChat.set(card.id, card);
    for (const member of card.memberChats) byChat.set(member.chatId, card);
  }
  return byChat;
}

/**
 * Which archive scope a row belongs to.
 *
 * `"open"` and `"closed"` are its card's lifecycle; `"none"` is a chat on no
 * board card at all — a triggered chat, a job step, a session nothing recorded,
 * or a chat whose card is hidden (see `boardCards`). That third value is what
 * gives the no-card case a defined answer instead of a silent exclusion: a
 * selection is scoped to ONE of these three, so a card-less chat can be
 * selected and deleted but can never join a batch the bar offers to archive,
 * and can never be quietly dropped from a count that promised to archive it.
 */
type ChatScope = "open" | "closed" | "none";

/**
 * Bottom padding the list falls back to while the bar is up and has not
 * reported its height — see `SelectionBar`'s `onMeasure`, which is the real
 * source and the reason this is a fallback rather than the answer.
 *
 * 76 used to be the answer, and it was wrong everywhere the bar wraps: measured
 * in Chromium with the app's own font stack, the bar is 84px at the 350px
 * minimum sidebar width (desktop is `flexWrap: nowrap`, so the labels wrap
 * INSIDE the buttons), 98px at 390px mobile and 111px at 320px. 120 clears the
 * worst of those with room for one longer label; `scripts/test-selection-bar-clearance.mjs`
 * is what keeps that claim true, since jsdom measures nothing.
 */
const SELECTION_BAR_FALLBACK_CLEARANCE = 120;

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
  const isMobile = useIsMobile();
  const [chats, setChats] = useState<Chat[]>([]);
  const [hasMore, setHasMore] = useState(false);
  // Tree rows currently shown (grows via "load more"): a parentage group folds
  // into one row, and the server paginates by rows so a page is always a full
  // page of visible entries. Refreshes refetch this many so an expanded list
  // isn't cut back to the first page.
  const loadedCountRef = useRef(20);
  // Which invocation currently owns `chats`. Bumped when a full refresh STARTS
  // and again when one COMMITS, and read by both request paths:
  //
  //   - `loadMore` drops a page whose offset was computed before a refresh
  //     re-baselined loadedCountRef;
  //   - `load` drops its own response once a NEWER `load` has claimed the
  //     list, which is what stops two refreshes in flight from resolving in
  //     the wrong order and leaving the list disagreeing with the filter state
  //     that asked for it.
  //
  // One counter serves both because both only ever test inequality: "something
  // newer than me has happened, so I am not the writer any more".
  const loadGenRef = useRef(0);
  /**
   * Pin changes made while a request was on the wire, re-applied to that
   * request's response instead of throwing the response away.
   *
   * The distinction that matters, and the reason this is not `loadGenRef`:
   * `loadGenRef` means "the response you are holding answers a question nobody
   * is asking any more", and a pin does not make a response that. It sets one
   * boolean on specific ids. `loadedCountRef` is untouched, so a "Load next
   * page" still lines up; a scope refetch is still the scope the user asked
   * for. Rejecting those responses loses a page (recoverable — `hasMore` is
   * untouched, click again) or, worse, loses a FILTER CHANGE: the list keeps
   * rendering the old scope while the filter bar reads the new state, and
   * nothing retries, because the 15s poll only runs while a session is active.
   * A user-initiated action silently not taking is far worse than the flicker
   * this exists to stop.
   *
   * So: re-apply, don't reject. The in-flight response is valid, it is just
   * missing one field on a handful of known rows.
   *
   * Entries are stamped with {@link pinEpochRef} and retired by the first
   * response whose request went out AFTER the stamp — such a response was
   * built by the server after the PATCH cleared its list caches, so it already
   * carries the change. That bounds the map and, more importantly, stops it
   * fighting a pin some other tab removed later: a stale override is never
   * re-applied, because it is dropped rather than kept.
   */
  const pinOverridesRef = useRef(new Map<string, { pinned: boolean; epoch: number }>());
  /** Bumped once per committed pin; see {@link pinOverridesRef}. */
  const pinEpochRef = useRef(0);
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
    showArchived: getChatsShowArchived(),
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
  /**
   * The chat whose title is being edited, or null for "the dialog is closed".
   * Null rather than an `isOpen` flag because the dialog seeds its field from
   * the title captured here and is unmounted in between, so each open starts
   * from what the row currently says rather than from the last edit.
   */
  const [editTitleFor, setEditTitleFor] = useState<{ chatId: string; currentTitle: string; fallbackName: string } | null>(null);
  // Card-picker modal state for the per-chat "Add to card…" action.
  // Every card, kept loaded rather than fetched when the picker opens: the row
  // menu needs each filed chat's card lifecycle to label Archive vs Unarchive, and
  // the sidebar is the one place all card actions live now.
  const [cards, setCards] = useState<CardSummary[]>([]);
  // Whether the first listCards has come back. Only the dim reads it, and only
  // because an empty `cards` is indistinguishable from "none of these chats has
  // a card" — see utils/chatDimming. Stays false if the fetch fails, which is
  // the right way round: nothing dims rather than everything.
  const [cardsLoaded, setCardsLoaded] = useState(false);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  // Multi-select, mirroring the board's (see Board.tsx). Deliberately NOT
  // persisted and not keyed on anything: a stale selection restored across a
  // reload is a way to act on the wrong chats, and transient UI state belongs
  // to neither side of the cwd/workspaceId line — it is not stored at all.
  const [rawSelectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // Non-null IS "in selection mode", and it scopes the selection to one
  // archive scope. That scoping is what lets the action bar offer exactly one
  // archive verb — "Archive 2 cards" — instead of "Archive 3 / Unarchive 2",
  // which is a small puzzle every time.
  const [selectionScope, setSelectionScope] = useState<ChatScope | null>(null);
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  /** The bar's measured height, or null until it has reported one. */
  const [barHeight, setBarHeight] = useState<number | null>(null);
  /**
   * The list column, for two jobs that both need "inside this list" to be a
   * real boundary: the selection bar is positioned against it, and the
   * selection's keyboard shortcuts are bound to it rather than to the document
   * — see the keydown effect.
   */
  const listRootRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const isSettingsActive = location.pathname === "/settings";
  const isAgentsActive = location.pathname.startsWith("/agents");
  const [drafts, setDrafts] = useState<QueueItem[]>([]);
  const [stagingCollapsed, setStagingCollapsed] = useState(false);

  const loadCards = useCallback(async () => {
    try {
      // includeHidden: the dim counts a hidden card as archived, exactly as
      // `cardLifecycle=unarchived` does, and it cannot do that for a card the
      // board's default rollup left out. See api.listCards.
      const res = await listCards(true);
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

  /**
   * A content search is on the wire, which widens the request scope — see
   * {@link cardLifecycleFor}.
   *
   * Keyed on the submitted query rather than on `matchingChatIds`, so the
   * widening starts when the query is sent instead of when its hits land.
   * Otherwise the first render of a result set intersects it against a list
   * still scoped to `unarchived`, and the user watches most of their results
   * appear a moment later. Trimmed to match `useChatSearch`, which decides a
   * search is running by the same rule.
   */
  const searching = submittedQuery.trim() !== "";

  /**
   * Fold pending pin changes into a response, and retire the ones it already
   * reflects.
   *
   * `epochAtRequest` is {@link pinEpochRef} as it stood when the request went
   * out. An override stamped at or below it was already committed server-side
   * before the request was built, so the response carries it: retire the
   * override rather than re-apply it, which is what keeps a value the user has
   * since changed elsewhere from being written back over a fresher one. An
   * override stamped ABOVE it landed while this request was in flight — the
   * race — so the response predates it and it is re-applied.
   *
   * Called outside the `setChats` updater, deliberately: it mutates the ref,
   * and React may invoke an updater more than once.
   */
  const applyPinOverrides = (incoming: Chat[], epochAtRequest: number): Chat[] => {
    const overrides = pinOverridesRef.current;
    if (overrides.size === 0) return incoming;
    const fresh = new Map<string, boolean>();
    for (const [id, override] of overrides) {
      if (override.epoch > epochAtRequest) fresh.set(id, override.pinned);
      else overrides.delete(id);
    }
    if (fresh.size === 0) return incoming;
    return incoming.map((chat) => {
      if (!fresh.has(chat.id)) return chat;
      try {
        const meta = JSON.parse(chat.metadata || "{}");
        meta.pinned = fresh.get(chat.id);
        return { ...chat, metadata: JSON.stringify(meta) };
      } catch {
        return chat;
      }
    });
  };

  const load = useCallback(async () => {
    const { bookmarked, showTriggered, showArchived } = viewOptions;
    // The whole of "Show archived", on the request side: off asks the server to
    // withhold the trees of archived cards, so while the user is browsing, the
    // rows the dim would fade never arrive. A search overrides it — see
    // cardLifecycleFor.
    const cardLifecycle = cardLifecycleFor({ showArchived, searching });
    // When advanced filters or content search are active, fetch all chats
    // to avoid missing matches due to pagination
    const shouldFetchAll = anyFilterActive || bookmarked;
    const limit = shouldFetchAll ? 9999 : Math.max(20, loadedCountRef.current);
    // When triggered chats are hidden, tell the API to exclude them so we
    // always get LIMIT real chats back (not LIMIT minus triggered ones)
    const excludeTriggered = !showTriggered;

    /**
     * Claim the list for this invocation before going to the wire, and stand
     * down after each await if a newer `load` has claimed it since.
     *
     * Without this the last response to LAND wins rather than the last one
     * REQUESTED, and the two are not the same: a double-click on the filter
     * bar's "Archived" toggle puts a `cardLifecycle=all` request and an
     * `active` one in flight together, and `all` resolves strictly more card
     * trees server-side, so it is the likelier one to land late. The list
     * would end up holding archived rows while the toggle that fetched them
     * reads off, until an unrelated refetch happened to correct it.
     */
    let gen = (loadGenRef.current += 1);
    const superseded = () => gen !== loadGenRef.current;

    // Taken per REQUEST, not per invocation: the stale refetch below is a
    // second request, and a pin that lands between the two is in flight for
    // it too. See applyPinOverrides.
    let pinEpoch = pinEpochRef.current;

    // includeLineage is always on: the list needs every member of a parentage
    // tree the page touches, even those outside the pagination window.
    // includePinned is on for the same reason and always for the same reason:
    // a pinned chat nobody has touched in a week is outside that window too,
    // and a Pinned section that empties itself as its chats age is not a
    // feature. Both are appended beyond the page and neither moves `hasMore`.
    const response = await listChats(limit, 0, bookmarked || undefined, excludeTriggered || undefined, undefined, true, undefined, cardLifecycle, true);
    if (superseded()) return;
    // Bump on commit as well as on claim — that is the edge an in-flight
    // `loadMore` watches for. Re-taken into `gen` so `superseded()` keeps
    // meaning "someone ELSE moved it" across the stale refetch below.
    gen = loadGenRef.current += 1;
    setListVersion((v) => v + 1);
    setChats(applyPinOverrides(response.chats, pinEpoch));
    setHasMore(shouldFetchAll ? false : response.hasMore);
    if (!shouldFetchAll) loadedCountRef.current = response.windowRows;

    // If the response was stale (cached), immediately fetch fresh data
    if (response.stale) {
      pinEpoch = pinEpochRef.current;
      const freshResponse = await listChats(limit, 0, bookmarked || undefined, excludeTriggered || undefined, false, true, undefined, cardLifecycle, true);
      if (superseded()) return;
      gen = loadGenRef.current += 1;
      setListVersion((v) => v + 1);
      setChats(applyPinOverrides(freshResponse.chats, pinEpoch));
      setHasMore(shouldFetchAll ? false : freshResponse.hasMore);
      if (!shouldFetchAll) loadedCountRef.current = freshResponse.windowRows;
    }

    setIsInitialLoading(false);

    // Initialize suggested directories from first three chat directories if none exist
    if (!bookmarked) {
      const chatDirectories = response.chats.map((chat) => chat.displayFolder || chat.folder);
      initializeSuggestedDirectories(chatDirectories);
    }
    // `searching` is a dependency, not just a read: submitting or clearing a
    // query changes the scope, and the effect below refetches only because
    // this callback is recreated.
  }, [viewOptions, anyFilterActive, searching]);

  const loadMore = async () => {
    if (isLoadingMore || !hasMore) return;

    setIsLoadingMore(true);
    try {
      const gen = loadGenRef.current;
      const pinEpoch = pinEpochRef.current;
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
        // Reachable mid-search: the button hides on `anyFilterActive`, which
        // is still false for the whole window between submitting a query and
        // its hits landing. So this really does need the search state, and it
        // takes it from the same function `load` does — the two request paths
        // cannot come to disagree about scope.
        cardLifecycleFor({ showArchived: viewOptions.showArchived, searching }),
        // Sent on every page, not just the first, so the request is the same
        // shape each time and the server's response cache is keyed on one
        // query string per scope. The pinned chats it re-appends are already
        // in the list and the dedupe below drops them — cheaper than reasoning
        // about which page is allowed to carry them.
        true,
      );
      // A refresh (filter toggle, SSE event, poll) replaced the list while
      // this page was in flight — its offset no longer lines up, so drop the
      // stale page.
      if (gen !== loadGenRef.current) return;
      // A pin landing mid-page does NOT invalidate this page — see
      // pinOverridesRef. Applied before the append so a row pinned while the
      // page was out arrives already carrying it.
      const incoming = applyPinOverrides(response.chats, pinEpoch);
      // Later pages can re-include chats already appended as lineage relatives
      setChats((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...incoming.filter((c) => !seen.has(c.id))];
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
  // archive/unarchive done on the board.
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

  /** Open the editor. Nothing is written until the dialog asks for it. */
  const handleEditTitle = (chat: Chat) => {
    let currentTitle = "";
    let preview: string | undefined;
    try {
      const meta = JSON.parse(chat.metadata || "{}");
      currentTitle = typeof meta.title === "string" ? meta.title : "";
      preview = meta.preview;
    } catch {}
    // What the row would say with no stored title, by the same rule
    // ChatListItem labels it — the dialog shows it as the field's placeholder,
    // so an emptied field previews what clearing the title actually gets you.
    let fallbackName = (chat.displayFolder || chat.folder)?.split("/").pop() || "Chat";
    if (preview) fallbackName = preview.length > 60 ? preview.slice(0, 60) + "..." : preview;
    setEditTitleFor({ chatId: chat.id, currentTitle, fallbackName });
  };

  /**
   * Reflect a title the dialog has already persisted, rather than waiting for
   * the next refetch — the row is what the user is looking at. `null` is the
   * cleared case: the key is removed rather than set to null, leaving the row's
   * metadata shaped like that of a chat that never had a title at all.
   */
  const applyTitle = (chatId: string, title: string | null) => {
    setChats((prev) =>
      prev.map((c) => {
        if (c.id !== chatId) return c;
        try {
          const meta = JSON.parse(c.metadata || "{}");
          if (title === null) delete meta.title;
          else meta.title = title;
          return { ...c, metadata: JSON.stringify(meta) };
        } catch {
          return c;
        }
      }),
    );
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

  /**
   * Pin or unpin, then patch the affected rows in place.
   *
   * Takes a list because a sidebar row is not always one chat: unpinning a
   * lineage group has to clear the pin wherever in the group it was set, or
   * the row goes on displaying a pin the menu just offered to remove. See
   * `ChatTreeList`'s `Row.pinnedMembers`.
   *
   * Written to `chats` only AFTER the server has taken it — NOT an optimistic
   * update, deliberately. A failed PATCH leaves the sidebar exactly as it was
   * rather than showing a pin that does not exist and will vanish at the next
   * poll; the request is one small write and the wait is imperceptible. What
   * the write buys is the beat after it: the partition reads `metadata.pinned`
   * off the loaded chats, so patching them re-files the row on the next render
   * instead of at the next refetch.
   *
   * A `load` already on the wire is NOT rejected for this. It is holding a
   * pre-pin list, but it is still answering the question that was asked, so
   * the pin is recorded in {@link pinOverridesRef} and re-applied to whatever
   * that request brings back. Bumping `loadGenRef` here instead — which this
   * did briefly — throws the response away, and that silently loses a page or,
   * worse, a filter change the user just made.
   *
   * `allSettled`, not `all`: unpinning a group fires one PATCH per pinned
   * member, and `all` rejects on the first failure without writing ANY of
   * them, including the ones the server took. The sidebar would then show a
   * group as fully pinned while the server had half-unpinned it. Each id that
   * succeeded is written; each that failed is logged and left alone, which is
   * what the next refetch will agree with.
   *
   * Unlike the bookmark's, this can never need to REMOVE a row: pinning is not
   * a filter, so no view exists that a chat drops out of by being unpinned. It
   * moves down into Recent, and if that was the last pin the headers go with
   * it.
   */
  const handleTogglePin = async (targets: Chat[], pinned: boolean) => {
    if (targets.length === 0) return;
    const results = await Promise.allSettled(targets.map((target) => togglePin(target.id, pinned)));
    const written = new Set<string>();
    results.forEach((result, i) => {
      if (result.status === "fulfilled") written.add(targets[i].id);
      else console.error(`Failed to toggle pin on ${targets[i].id}:`, result.reason);
    });
    if (written.size === 0) return;

    const epoch = (pinEpochRef.current += 1);
    for (const id of written) pinOverridesRef.current.set(id, { pinned, epoch });

    setChats((prev) =>
      prev.map((c) => {
        if (!written.has(c.id)) return c;
        try {
          const meta = JSON.parse(c.metadata || "{}");
          meta.pinned = pinned;
          return { ...c, metadata: JSON.stringify(meta) };
        } catch {
          return c;
        }
      }),
    );
  };

  /**
   * `cards` holds hidden cards too — `loadCards` asks for them, because the dim
   * has to fade a hidden card's tree to stay the exact complement of
   * `cardLifecycle=unarchived`. Only the dim wants that set.
   *
   * Everything else here means BOARD cards, and always did: before hidden cards
   * were fetched at all, `cardOf` simply never saw one. Restore that by
   * splitting the index rather than by giving each consumer a `hidden` check to
   * remember. The consumer this protects is the row menu, whose only entry is a
   * lifecycle toggle: it is written for cards that are on the board ("moves to
   * the board's Archived strip", "returns to the board"), a hidden card is on
   * the board under no lifecycle, and flipping one would not even clear the dim
   * the user is looking at — `hidden` stays set, and nothing in the sidebar can
   * unset it. An action that cannot reach the state it appears to control is
   * not worth offering, so `cardOf` returns undefined and no entry renders.
   */
  const boardCards = useMemo(() => cards.filter((card) => !card.hidden), [cards]);
  const cardsById = useMemo(() => new Map(boardCards.map((c) => [c.id, c])), [boardCards]);
  const cardsByChatId = useMemo(() => indexByChat(boardCards), [boardCards]);
  /** The same index over EVERY card, hidden included. Read by the dim alone. */
  const dimCardsByChatId = useMemo(() => indexByChat(cards), [cards]);

  /**
   * The board card a chat's lineage root is, when it is one and we've loaded
   * it. A hidden card answers undefined — see {@link boardCards}.
   */
  const cardOf = useCallback(
    (chat: Chat): CardSummary | undefined => {
      const direct = cardsByChatId.get(chat.id);
      if (direct) return direct;
      const id = chatCardId(chat);
      return id ? cardsById.get(id) : undefined;
    },
    [cardsByChatId, cardsById],
  );

  /**
   * Fade rows whose card is archived — closed or hidden. A row on no card is
   * not archived and is not faded. Unconditional — purely a
   * render decision over cards already on the page, so there is no request to
   * change and nothing for the user to switch off. "Show archived" is the
   * other half of the same idea and not an exception to it: it decides whether
   * these rows are fetched, so while the user is browsing with it off this has
   * almost nothing left to fade. Browsing — a search widens the scope past the
   * toggle, and then this fades in bulk, on purpose. `isChatDimmed` lists that
   * and the two rarer causes, one of which is local to this file: `cards` and
   * `chats` are separately timed requests here (the 15s poll refetches one,
   * the kebab menu patches the other).
   *
   * The one reader of `dimCardsByChatId` — hidden cards included, which is what
   * makes this the complement of the server's scope rather than a near-miss.
   */
  const isDimmed = (chat: Chat): boolean => isChatDimmed(chat, dimCardsByChatId, { cardsLoaded });

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
      ...(card && { card: { title: card.title, lifecycle: card.lifecycle, chatCount: card.chatCount } }),
      onToggleLifecycle: () => handleToggleCardLifecycle(chat),
    };
  };

  /**
   * Commit both halves of the sidebar's filter state. Called by the filters
   * modal on Apply, and by all three of the filter bar's scope toggles straight
   * from the click — one commit path, so persistence and the refetch cannot
   * differ between them.
   *
   * Two of the three scopes are persisted here and `bookmarked` is not, which
   * is deliberate rather than an omission: it is the one scope that can empty
   * the sidebar on its own, so remembering it would greet the user with a blank
   * list they have no memory of asking for. Pinned in
   * ChatList.showArchived.test.tsx.
   *
   * No explicit reload: `load` closes over `viewOptions`, so changing it
   * recreates the callback and the effect that depends on it refetches.
   */
  const handleApplyFilters = (nextFilters: ChatFilters, nextView: ChatViewOptions) => {
    setFilters(nextFilters);
    setViewOptions(nextView);
    saveShowTriggeredChats(nextView.showTriggered);
    saveChatsShowArchived(nextView.showArchived);
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

  // ---------------------------------------------------------------------------
  // Multi-select.
  //
  // The board's is the reference implementation (Board.tsx) and this is
  // deliberately the same shape: the range order comes from the very array
  // that renders, the selected set is DERIVED and reconciled on every render
  // rather than repaired in an effect, and a selection is scoped so the bar
  // can offer one unambiguous verb. The gesture contract itself is shared code
  // — `useSelectionActivation`, via ChatListItem — not a second copy of it.
  // ---------------------------------------------------------------------------

  /**
   * The rows on screen, in the order they render: the same function
   * `ChatTreeList` maps over, given the same array. See `buildRows` there for
   * why it is a shared function rather than a second derivation.
   *
   * One entry per VISIBLE row, so a lineage group is one entry and not one per
   * member — a folded member has no row of its own to check, and a shift+click
   * range that stepped through the members would sweep up chats the user never
   * saw. The rows inside an expanded group's fetched tree are not in `chats` at
   * all and are likewise not selectable.
   */
  const rows = useMemo(() => buildRows(filteredChats), [filteredChats]);
  const rowChats = useMemo(() => new Map(rows.map((row) => [row.chat.id, row.chat])), [rows]);
  const orderedIds = useMemo(() => rows.map((row) => row.chat.id), [rows]);

  /**
   * A row's archive scope — see {@link ChatScope}.
   *
   * Gated on `cardsLoaded`, exactly as `isDimmed` is and for the same reason:
   * before the first `listCards` returns, "no card in the index" and "no card"
   * are indistinguishable, and `/api/cards` is the expensive uncached request
   * while `/api/chats` is a paginated window — the gap between them is two
   * round trips, not a paint. Answering `"none"` there is not a guess dressed
   * up as an answer, because nothing can be selected until it closes: the list
   * withholds selection entirely while `!cardsLoaded` (see the `selectionFor`
   * prop), so no selection can be scoped from an index that has not arrived.
   */
  const scopeOf = useCallback((chat: Chat): ChatScope => (cardsLoaded ? cardOf(chat)?.lifecycle ?? "none" : "none"), [cardOf, cardsLoaded]);

  /**
   * The selection, reconciled against the rows that actually exist — derived
   * on every render rather than repaired in an effect after each fetch.
   *
   * The sidebar refetches on a 15s poll, on every SSE metadata bump and on
   * every filter change, and a selected chat can go three different ways
   * underneath that: deleted by another client, filtered out, or folded into a
   * lineage group that a different member now fronts. It can also LEAVE THE
   * SCOPE without going anywhere, when someone archives its card on the board.
   * Deriving the set means there is no second copy to fall out of step — the
   * dead id is gone the moment the response lands, and it can never reach a
   * bulk call.
   */
  const selectedIds = new Set(
    [...rawSelectedIds].filter((id) => {
      const chat = rowChats.get(id);
      return chat !== undefined && scopeOf(chat) === selectionScope;
    }),
  );
  // Losing every selected chat to that reconciliation also leaves selection
  // mode — an action bar over an empty selection has nothing to act on. The
  // raw set behind it is cleared by the reaper below; the derivation alone
  // only HIDES the bar, and a hidden selection is one that can come back.
  const selectionMode = selectionScope !== null && selectedIds.size > 0;
  const selectionScopeCount = rows.filter((row) => scopeOf(row.chat) === selectionScope).length;

  /** Forget the selection itself, leaving any message about it standing. */
  const resetSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectionScope(null);
    setAnchorId(null);
  }, []);

  const exitSelection = useCallback(() => {
    resetSelection();
    // The message goes with the selection it was about — "2 of 5 could not be
    // updated" over a list with nothing selected describes a gesture the user
    // has already abandoned.
    setBulkError(null);
  }, [resetSelection]);

  /**
   * The reaper: a selection whose every row has been reconciled away is
   * forgotten, not merely hidden.
   *
   * Derivation is the wrong tool on its own, because the RAW set survives it.
   * Select two rows, search until neither matches — the bar goes, which reads
   * as "selection gone" — then clear the search: without this, `rawSelectedIds`
   * is still holding both ids, they match the rows again, and the bar comes
   * back saying "2 chats selected" over rows the user stopped thinking about
   * minutes ago. The next button press acts on them.
   *
   * `bulkError` is deliberately left alone: a "2 of 5 could not be deleted"
   * message is still true when the rows it named have since gone.
   */
  useEffect(() => {
    if (selectionScope !== null && selectedIds.size === 0) resetSelection();
  }, [selectionScope, selectedIds.size, resetSelection]);

  /**
   * Long press or context menu. Idempotent — both triggers can fire for one
   * gesture.
   *
   * Neither this nor `toggleSelect` re-checks the scope. That rule is enforced
   * in exactly one place, `selectionProps` below, which both marks an
   * out-of-scope row unselectable and withholds its gesture handler. A second
   * copy of the check here would be unreachable, and unreachable guards are the
   * kind that quietly stop matching the one that actually runs.
   */
  const enterSelection = (chat: Chat) => {
    setSelectionScope(scopeOf(chat));
    // Built from the reconciled set, never from the raw one, so ids left over
    // from a selection that has already lapsed cannot rejoin this gesture.
    // The pressed row starts selected, so the count is never 0 on entry.
    setSelectedIds(new Set(selectedIds).add(chat.id));
    setAnchorId(chat.id);
  };

  const toggleSelect = (chat: Chat, e: React.MouseEvent) => {
    const anchorIndex = anchorId ? orderedIds.indexOf(anchorId) : -1;
    const targetIndex = orderedIds.indexOf(chat.id);
    if (e.shiftKey && anchorIndex !== -1 && targetIndex !== -1) {
      const [lo, hi] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
      // The slice IS filtered by scope here, unlike the board's — and the
      // difference is in the data, not the intent. The board lists every open
      // card before every closed one, so nothing out of scope can lie between
      // two cards that are both in it. This list is ordered by recency and
      // mixes the scopes freely, so a range from one open row to another can
      // step straight over an archived one or a card-less one. Both ENDS are
      // still guaranteed in scope by the inert row: an out-of-scope row never
      // receives the click.
      const inRange = orderedIds.slice(lo, hi + 1).filter((id) => {
        const row = rowChats.get(id);
        return row !== undefined && scopeOf(row) === scopeOf(chat);
      });
      setSelectedIds(new Set([...selectedIds, ...inRange]));
      setSelectionScope(scopeOf(chat));
      // The anchor stays put across successive shift+clicks, as in Finder.
      return;
    }

    const next = new Set(selectedIds);
    if (next.has(chat.id)) next.delete(chat.id);
    else next.add(chat.id);
    setSelectedIds(next);
    setSelectionScope(scopeOf(chat));
    // Deselecting the last chat leaves selection mode by derivation, since
    // selectionMode requires a non-empty selection. The anchor has to go with
    // it explicitly though: left behind, the next shift+click would extend a
    // range from a chat the user has already deselected.
    setAnchorId(next.size === 0 ? null : chat.id);
  };

  const selectionProps = (chat: Chat) => {
    const inScope = !selectionMode || selectionScope === scopeOf(chat);
    return {
      selectionMode,
      selected: selectedIds.has(chat.id),
      selectable: inScope,
      onToggleSelect: (e: React.MouseEvent) => toggleSelect(chat, e),
      onLongPress: inScope ? () => enterSelection(chat) : undefined,
    };
  };

  const selectAllInScope = useCallback(() => {
    if (selectionScope === null) return;
    setSelectedIds(new Set(rows.filter((row) => scopeOf(row.chat) === selectionScope).map((row) => row.chat.id)));
  }, [rows, scopeOf, selectionScope]);

  /**
   * The selection's keyboard shortcuts, bound to the LIST — not to the
   * document, which is what the board does and what the board is entitled to
   * do, being the whole viewport.
   *
   * The sidebar is one docked column with a transcript open beside it. A
   * document-level handler there turns any Cmd+A in the window into "select
   * every chat in the sidebar", `preventDefault` included, so a user reaching
   * for the messages they were reading gets their sidebar selected instead.
   * Bound to the root, the shortcuts only fire while the focus is inside the
   * list — which is why entering selection mode focuses it (below). The
   * INPUT/TEXTAREA exemption still matters, because the search box is inside
   * this root and Cmd+A there means the text.
   */
  useEffect(() => {
    const root = listRootRef.current;
    if (!selectionMode || !root) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "Escape") {
        exitSelection();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAllInScope();
      }
    };
    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, [selectionMode, exitSelection, selectAllInScope]);

  /**
   * Give the list the focus when a selection starts, so its shortcuts have
   * somewhere to arrive.
   *
   * `tabIndex={-1}` on the root: programmatic focus, no new tab stop. Nothing
   * in a row is focusable, so clicking one leaves the focus on `body` and a
   * root-scoped handler would never fire — this is what makes scoping them
   * possible at all. Only on the transition into selection mode, so it cannot
   * pull the focus back out of whatever the user moved on to.
   */
  const hadSelectionRef = useRef(false);
  useEffect(() => {
    if (selectionMode && !hadSelectionRef.current) listRootRef.current?.focus({ preventScroll: true });
    hadSelectionRef.current = selectionMode;
  }, [selectionMode]);

  /** Selected chat ids, in rendered order, so a bulk request is deterministic. */
  const selectedInOrder = orderedIds.filter((id) => selectedIds.has(id));

  /**
   * The cards behind the selection, deduped, in rendered order.
   *
   * Archive is a CARD action — the row menu's entry has always toggled the
   * lifecycle of the chat's lineage root, i.e. the whole tree — and bulk
   * archive keeps that meaning rather than inventing a per-chat archive that
   * does not exist. Two selected chats on one card therefore resolve to one id,
   * and the bar says so: see `bulkActions`.
   *
   * Nothing is silently dropped here. Every chat in an "open" or "closed"
   * scoped selection has a card by construction — that is what put it in the
   * scope — and a chat with no card sits in the `"none"` scope, where no
   * archive verb is offered at all.
   */
  const selectedCardIds = (() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const id of selectedInOrder) {
      const chat = rowChats.get(id);
      const card = chat && cardOf(chat);
      if (!card || seen.has(card.id)) continue;
      seen.add(card.id);
      ids.push(card.id);
    }
    return ids;
  })();

  /**
   * No confirmation and no undo, by the same decision the board made: archiving
   * is reversible, its inverse is one gesture away, and the "Archived" toggle
   * that brings the rows back is in view. A modal on a reversible bulk action
   * only trains people to dismiss modals.
   */
  const runBulkLifecycle = async () => {
    if (selectionScope !== "open" && selectionScope !== "closed") return;
    const cardIds = selectedCardIds;
    if (cardIds.length === 0) return;
    const target = selectionScope === "open" ? "closed" : "open";
    setBulkBusy(true);
    try {
      const res = await bulkSetCardLifecycle(cardIds, target);
      // Merged into the card index rather than waited for: the dim reads the
      // cards, so every affected row fades (or un-fades) on this render
      // instead of on the next poll.
      const updatedById = new Map(res.updated.map((c) => [c.id, c]));
      setCards((prev) => prev.map((c) => updatedById.get(c.id) ?? c));
      const failed = res.failed ?? [];
      if (failed.length > 0) {
        // Failures come back per CARD; the selection is per CHAT, so map back
        // through the cards to leave exactly the chats whose card did not
        // flip selected — retrying those is the user's next move.
        const failedCardIds = new Set(failed.map((f) => f.id));
        setSelectedIds(
          new Set(
            selectedInOrder.filter((id) => {
              const chat = rowChats.get(id);
              const card = chat && cardOf(chat);
              return !!card && failedCardIds.has(card.id);
            }),
          ),
        );
        setAnchorId(null);
        setBulkError(`${failedCardIds.size} of ${cardIds.length} cards could not be updated`);
      } else {
        setBulkError(null);
        exitSelection();
      }
      // Whether the rows should now LEAVE the list is the server's call, not
      // this component's: with "Archived" off the scope withholds an archived
      // card's tree, with it on the rows stay and read as faded. So refetch
      // rather than filter locally — the merge above has already paid for the
      // instant feedback.
      load();
    } catch (err: any) {
      setBulkError(err.message || "Failed to update cards");
    } finally {
      setBulkBusy(false);
    }
  };

  const runBulkDelete = async () => {
    const ids = selectedInOrder;
    if (ids.length === 0) return;
    setBulkDeleteConfirm(false);
    setBulkBusy(true);
    try {
      const res = await bulkDeleteChats(ids);
      // Dropped from the list here rather than by the refetch below, so the
      // rows go the moment the response lands.
      const deleted = new Set(res.deleted);
      if (deleted.size > 0) setChats((prev) => prev.filter((c) => !deleted.has(c.id)));
      const failed = res.failed ?? [];
      if (failed.length > 0) {
        setSelectedIds(new Set(failed.map((f) => f.id)));
        setAnchorId(null);
        setBulkError(`${failed.length} of ${ids.length} chats could not be deleted`);
      } else {
        setBulkError(null);
        exitSelection();
      }
      // The cards, but deliberately NOT the list: deleting a lineage root
      // removes a card and deleting any member changes its rollup, so the
      // card index has to be refetched or the dim and the scope would still
      // be reading a card whose chats are gone. The chat list needs no such
      // round trip — the filter above already removed exactly the rows the
      // server confirmed, and refetching would only re-baseline the
      // pagination window, at the price of the rows flickering back if the
      // response beat the cache invalidation.
      loadCards();
    } catch (err: any) {
      setBulkError(err.message || "Failed to delete chats");
    } finally {
      setBulkBusy(false);
    }
  };

  /**
   * The bar's actions, and the one wording decision worth reading twice.
   *
   * Every number on the bar names its unit — "5 chats selected" over
   * "Archive 2 cards" and "Delete 5 chats" — because two different things are
   * being counted and the honest thing is to say which. Archive acts on cards,
   * and a card is a lineage tree: five selected chats can live on two cards,
   * and archiving those two moves every chat on them, which may be forty.
   * "Archive 5" would name neither the thing being acted on nor the blast
   * radius, and the user would watch forty rows fade after being promised
   * five. The row menu already sets that precedent, spelling out "all N chats
   * on this card" in its tooltip.
   *
   * The count's own noun is what stops the pair reading as a bug: "5 selected"
   * beside "Archive 2 cards" is a puzzle, and "5 chats selected" is a fact.
   *
   * Delete counts chats because it acts on chats — one per selected ROW, and
   * that is the limitation the confirmation has to spell out; see
   * `bulkDeleteMessage`.
   */
  const bulkActions: SelectionAction[] = [
    ...(selectionScope === "open" || selectionScope === "closed"
      ? [
          {
            key: "lifecycle",
            label: `${selectionScope === "open" ? "Archive" : "Unarchive"} ${selectedCardIds.length} ${selectedCardIds.length === 1 ? "card" : "cards"}`,
            onRun: runBulkLifecycle,
          },
        ]
      : []),
    {
      key: "delete",
      label: `Delete ${selectedIds.size} ${selectedIds.size === 1 ? "chat" : "chats"}`,
      onRun: () => setBulkDeleteConfirm(true),
      danger: true,
    },
  ];

  /**
   * What the delete confirmation says, and why it says more than the count.
   *
   * A selected row can be a lineage GROUP — `buildRows` folds a tree into one
   * row fronted by its most recently updated member, and only that front chat
   * is selectable. Delete has no cascade (that is what `DELETE /api/chats/:id`
   * has always done, and the bulk route deliberately did not invent a
   * different rule), so the other members survive and the group comes straight
   * back, fronted by the next member down. "Select all" then "Delete 40 chats"
   * reads as "clear the list"; what actually happens is that it half-empties
   * and refills with different titles.
   *
   * Not a regression — the single-row delete always behaved this way — but
   * doing forty at once is what makes it visible, so the dialog says it. Only
   * when a selected row actually fronts a group, because on a selection of
   * lone chats there is nothing to warn about and the sentence would be noise.
   */
  const selectionFrontsAGroup = rows.some((row) => row.isGroup && selectedIds.has(row.chat.id));
  const bulkDeleteMessage = [
    `Are you sure you want to delete ${selectedIds.size === 1 ? "this chat" : `these ${selectedIds.size} chats`}?`,
    selectionFrontsAGroup ? "This deletes the selected chats, not the chats forked from them — those stay, and their group will reappear." : "",
    "This action cannot be undone.",
  ]
    .filter(Boolean)
    .join(" ");

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

  // Determine the empty state message. Of the three view options only
  // `bookmarked` is named here, and the criterion it is named by is "can this
  // option have EMPTIED the list?":
  //
  //   - `bookmarked` can, on its own, and routinely does — a user with
  //     thousands of chats and no bookmarks gets nothing back;
  //   - `showTriggered` and `showArchived` cannot EMPTY a non-empty list.
  //     Both only widen what the server is asked for, and the widened request
  //     still comes back with up to `limit` rows, so a list that had rows keeps
  //     rows. (Not the stronger "they only ever add rows": under fixed-limit
  //     pagination — `limit = Math.max(20, loadedCountRef.current)` — widening
  //     the scope can push rows that were visible out of the window. That
  //     reshuffles the page; it cannot empty it.) An empty list is therefore
  //     never their doing, and "No chats match the current filters" would be a
  //     lie.
  //
  // All three now have their own toggle button in the filter bar, so all three
  // are exempt from the filter button's badge — which is why that exemption is
  // NOT what this reads. The badge asks "is there an edit inside the modal?";
  // this asks whether anything could have taken rows away. The two questions
  // were once close enough to be confused, and the answers have now separated
  // completely: the badge counts none of the view options and this one counts
  // one of them.
  const isFiltered = viewOptions.bookmarked || hasActiveFilters(filters) || matchingChatIds !== null;

  /**
   * The other direction gets said out loud: OFF is the default, and it is now
   * the likeliest reason for an empty sidebar — a folder whose cards are all
   * archived shows nothing at all, where before it showed a list of faded
   * rows. The message names the "Archived" button in the filter bar directly,
   * which is the whole benefit of it being there: the fix is one click away,
   * in view, rather than two clicks deep in a modal.
   *
   * What it must NOT say any more is "no chats on an open card". The scope
   * withholds the archived trees and nothing else, so a chat on no card at all
   * — triggered, a job step, a session nothing recorded — IS in this list, and
   * blaming its absence on not having a card would point the user at a toggle
   * that could not have produced it. "No unarchived chats" is the narrower
   * claim and the true one; it also stays true when there are simply no chats,
   * which "every chat here is archived" would not.
   *
   * `searching` cancels that, because it cancels the scope: a search runs
   * against everything, so blaming an empty result on hidden archived chats
   * would send the user to a button that would not have changed the answer.
   */
  const archivedHidden = !viewOptions.showArchived && !searching;
  const emptyMessage = isFiltered
    ? archivedHidden
      ? "No chats match the current filters. Archived chats are hidden."
      : "No chats match the current filters"
    : archivedHidden
      ? "No unarchived chats. Turn on “Archived” above to include chats on archived cards."
      : "No chats yet. Create one to get started.";

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
    // `position: relative` is what confines the selection bar to this column.
    // The board's bar is `position: fixed` because the board owns the whole
    // viewport; the sidebar owns one column of it, and a viewport-spanning bar
    // here would lie across the chat pane beside it. On mobile this column IS
    // the screen, so the same absolute bar reads as a bottom action bar there
    // with no second branch — see SelectionBar's `position` prop.
    <div
      ref={listRootRef}
      // Focusable programmatically only — it takes no tab stop, and it is what
      // gives the selection's shortcuts a scope. See the keydown effect.
      tabIndex={-1}
      style={{ position: "relative", height: "100%", display: "flex", flexDirection: "column", outline: "none" }}
    >
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

      {/* Bulk-action failures only. Everything else in this file that can fail
          is non-critical and stays silent (see `loadCards`, `loadDrafts`); a
          bulk action is the user's explicit request over rows they chose, so
          "2 of 5 could not be updated" has to be said out loud. */}
      {bulkError && (
        <div
          style={{
            margin: "8px 20px 0",
            padding: "8px 12px",
            borderRadius: 6,
            background: "var(--danger-bg)",
            color: "var(--danger)",
            fontSize: 12,
          }}
        >
          {bulkError}
        </div>
      )}

      <div
        style={{
          flex: 1,
          overflow: "auto",
          // Room for the bar while it is up, paid at the scroll container
          // exactly as the board pays it at its own — but from the bar's
          // MEASURED height, not a constant. The bar's labels are this page's
          // words and its row wraps at narrow widths, so its height is a
          // function of the sidebar's width and of what is selected; a
          // constant was 76 and the bar is 84px at the 350px minimum. The
          // fallback only applies before the first measurement (or in an
          // environment with no layout at all).
          paddingBottom: selectionMode ? (barHeight ?? SELECTION_BAR_FALLBACK_CLEARANCE) : undefined,
        }}
      >
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
        {/* `!isSearching`: a submitted query has already widened the scope but
            its hits have not landed, so `isFiltered` is still false and the
            message below would tell a user with thousands of chats that they
            have none. Nothing at all is the honest thing to render for the one
            beat it takes — the search box is showing its own spinner. */}
        {filteredChats.length === 0 && !isInitialLoading && !isSearching && (
          <p style={{ padding: 20, color: "var(--chatlist-empty-text)", textAlign: "center" }}>{emptyMessage}</p>
        )}
        <ChatTreeList
          chats={filteredChats}
          refreshToken={listVersion}
          activeChatId={activeChatId}
          onChatClick={handleChatClick}
          onDelete={handleDelete}
          onToggleBookmark={handleToggleBookmark}
          onTogglePin={handleTogglePin}
          onEditTitle={handleEditTitle}
          cardMenuFor={cardMenuFor}
          sessionStatusFor={(chatId) => (activeSessions.has(chatId) ? { active: true, type: activeSessions.get(chatId)!.type } : undefined)}
          isDimmed={isDimmed}
          // Withheld until the cards are in: a row's selection scope is its
          // card's lifecycle, and there is no honest scope to put a row in
          // before the card index exists. See `scopeOf`. (If `listCards` keeps
          // failing, `cardsLoaded` stays false and the list offers no bulk
          // selection at all — the row kebab's own actions are unaffected,
          // which is the same way the dim degrades.)
          selectionFor={cardsLoaded ? selectionProps : undefined}
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

      {selectionMode && (
        <SelectionBar
          position="absolute"
          count={selectedIds.size}
          // The count names its unit, so it does not read as the same number
          // as the archive label's — see `bulkActions`.
          noun={selectedIds.size === 1 ? "chat selected" : "chats selected"}
          onMeasure={setBarHeight}
          // Mobile has no Ctrl/Cmd+A, so the button is the only way to reach
          // "all of them" there.
          onSelectAll={isMobile ? selectAllInScope : undefined}
          allSelected={selectedIds.size === selectionScopeCount}
          actions={bulkActions}
          onCancel={exitSelection}
          busy={bulkBusy}
        />
      )}

      {/* Delete is irreversible, so it asks — the one bulk action here that
          does. The wording follows the single-chat confirmation below it, and
          names what a bulk delete does NOT reach; see `bulkDeleteMessage`. */}
      <ConfirmModal
        isOpen={bulkDeleteConfirm}
        onClose={() => setBulkDeleteConfirm(false)}
        onConfirm={runBulkDelete}
        title={selectedIds.size === 1 ? "Delete Chat" : "Delete Chats"}
        message={bulkDeleteMessage}
        confirmText="Delete"
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

      {/*
       * Mounted HERE, at the page, and not inside the row whose title it edits
       * — the dialog holds in-flight request state (a regeneration is a model
       * call several seconds long), and a row is remounted by any refresh that
       * changes its shape: the 15s poll folding it into a lineage group, an SSE
       * metadata bump, a filter change moving it between sections. State held
       * down there is dropped mid-request. This is the surviving half of the
       * reasoning that used to justify hoisting `regeneratingTitleIds` to the
       * page; the set itself is gone because nothing in a row fires a request
       * any more, but the constraint that made it necessary has not moved.
       */}
      {editTitleFor && (
        <EditTitleModal
          chatId={editTitleFor.chatId}
          currentTitle={editTitleFor.currentTitle}
          fallbackName={editTitleFor.fallbackName}
          onClose={() => setEditTitleFor(null)}
          onSaved={(title) => applyTitle(editTitleFor.chatId, title)}
        />
      )}
    </div>
  );
}
