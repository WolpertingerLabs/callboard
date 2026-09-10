import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Globe,
  Monitor,
  X,
  Bookmark,
  Bot,
  Zap,
  GitBranch,
  Bell,
  Workflow,
  EllipsisVertical,
  Archive,
  ArchiveRestore,
  Pencil,
  Check,
} from "lucide-react";
import type { Chat } from "../api";
import { dismissSummon } from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import { useSelectionActivation } from "../hooks/useSelectionActivation";
import ProviderBadge from "./ProviderBadge";
import FolderPathPill from "./FolderPathPill";
import MenuRow from "./MenuRow";

/**
 * Every card (ticket) action for one chat. The sidebar row menu is the single
 * home for these — the chat view's composer menu is about sending messages,
 * not filing tickets.
 *
 * The only entry is the lifecycle toggle. `card` is the resolved record of
 * the chat's lineage root; when it hasn't loaded (or the root is not a card —
 * e.g. a triggered chat) the entry is omitted rather than guessed. There is
 * no create/join/leave: membership is lineage, so a top-level chat is a card
 * the moment it exists.
 */
export interface ChatCardMenu {
  card?: {
    title: string;
    lifecycle: "open" | "closed";
    /**
     * Every chat on the card, the root included — `CardSummary.chatCount`.
     *
     * Carried so the menu can say what the click actually reaches. The entry
     * is worded per chat ("Archive chat"), but a card is a lineage tree and
     * the toggle archives the whole of it, which used to be invisible until
     * six rows faded at once.
     */
    chatCount: number;
  };
  onToggleLifecycle?: () => void;
}

interface Props {
  chat: Chat;
  isActive?: boolean;
  onClick: () => void;
  onDelete: () => void;
  onToggleBookmark?: (bookmarked: boolean) => void;
  /**
   * Open the title editor for this chat. Omit to leave the entry out of the
   * menu entirely. Nothing is written from here — the dialog the handler opens
   * owns both the typed rename and the regenerate that shares it.
   */
  onEditTitle?: () => void;
  /** Card actions for the row menu. Omit to render no card entries at all. */
  cardMenu?: ChatCardMenu;
  sessionStatus?: { active: boolean; type: string };
  /**
   * The list's verdict on "this chat's card is archived" — closed or hidden,
   * and NOT merely missing (see `utils/chatDimming`). A *request* to fade, not
   * the last word — the exemptions below can veto it.
   */
  dimmed?: boolean;
  /**
   * Multi-select, wired by the list. Every field below is optional and named
   * exactly as `CardTile`/`CardRow`'s are, because they answer one contract —
   * `useSelectionActivation`. With none passed the row behaves precisely as it
   * did before multi-select existed.
   */
  selectionMode?: boolean;
  selected?: boolean;
  /** False for rows outside the selection's scope — rendered inert and dimmed. */
  selectable?: boolean;
  /** Receives the event so the list can read shift/meta/ctrl for range and toggle. */
  onToggleSelect?: (e: React.MouseEvent) => void;
  onLongPress?: () => void;
}

/**
 * Spread onto a control inside the row that owns its own click, so the row's
 * long press does not also fire on it.
 *
 * BOTH triggers, for the reason `CardRow` spells out at its own copy: the
 * held-pointer timer that `pointerdown` starts and the `contextmenu` Android
 * Chrome fires are independent, and `contextmenu` bubbles on its own even when
 * the pointer event beneath it was stopped. Guarding only `pointerdown` leaves
 * the gesture live on exactly the platform the second trigger exists for.
 */
const stopGesture = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onContextMenu: (e: React.MouseEvent) => e.stopPropagation(),
};

/** Rough popup height used to decide whether the menu opens downward or upward. */
const MENU_ESTIMATED_HEIGHT = 210;

/**
 * The lifecycle entry's tooltip: what is about to happen, and to how much.
 *
 * The count clause exists only where it is news. On the 97% of cards that are
 * one chat, "all 1 chats" would be noise about a card whose blast radius is
 * the row you are pointing at; past that, the number IS the warning, because
 * nothing else on the row says the card has a tree under it.
 */
function cardLifecycleTitle({ title, lifecycle, chatCount }: NonNullable<ChatCardMenu["card"]>): string {
  if (lifecycle !== "open") return `Unarchive "${title}" — it returns to the board`;
  return chatCount > 1
    ? `Archive "${title}" — all ${chatCount} chats on this card move to the board's Archived strip`
    : `Archive "${title}" — it moves to the board's Archived strip`;
}

export default function ChatListItem({
  chat,
  isActive,
  onClick,
  onDelete,
  onToggleBookmark,
  onEditTitle,
  cardMenu,
  sessionStatus,
  dimmed,
  selectionMode = false,
  selected = false,
  selectable = true,
  onToggleSelect,
  onLongPress,
}: Props) {
  const [hovered, setHovered] = useState(false);
  // The kebab popup escapes the sidebar's overflow:auto scroll container via
  // position:fixed, anchored to the button's viewport rect at open time.
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const menuOpen = menuPos !== null;
  const isMobile = useIsMobile();
  // On touch/mobile there is no hover, so keep the row actions visible. Also
  // keep the kebab mounted while its menu is open (hover is lost to the popup).
  const showActions = isMobile || hovered || menuOpen;
  // The kebab stands down while a selection is live: a click anywhere on the
  // row toggles it now, and a menu that acts on this one chat inside a gesture
  // aimed at five of them is a way to lose the selection by accident.
  const showMenuButton = showActions && !selectionMode;

  // An open menu goes with it. `menuOpen` is this row's own state and outlives
  // the button that set it, so without this a right-click that entered
  // selection mode from a row whose menu was already up would leave the popup
  // floating over the selection — and it would come back when the selection
  // ended, anchored to a rect from minutes earlier.
  useEffect(() => {
    if (selectionMode) setMenuPos(null);
  }, [selectionMode]);

  // The menu is anchored to the kebab's viewport rect at open time, so close
  // it on any scroll (else it detaches from its row) and on Escape — matching
  // the composer menu's behavior in PromptInput.
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuPos(null);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);
  const displayPath = chat.displayFolder || chat.folder;
  const folderName = displayPath?.split("/").pop() || displayPath || "Chat";
  const time = new Date(chat.updated_at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  let title: string | undefined;
  let preview: string | undefined;
  let isBookmarked = false;
  let agentAlias: string | undefined;
  let isTriggered = false;
  let lastReadAt: string | undefined;
  let chatStatus: string | undefined;
  let chatStatusEmoji: string | undefined;
  let summon: { message: string; urgency: string; createdAt: string } | undefined;
  let provider: string | undefined;
  let acpProviderId: string | undefined;
  let jobRunId: string | undefined;
  let jobStepId: string | undefined;
  let jobNeedsYou = false;
  try {
    const meta = JSON.parse(chat.metadata || "{}");
    title = meta.title;
    preview = meta.preview;
    isBookmarked = meta.bookmarked === true;
    agentAlias = meta.agentAlias;
    isTriggered = meta.triggered === true;
    lastReadAt = meta.lastReadAt;
    chatStatus = meta.chatStatus || undefined;
    chatStatusEmoji = meta.chatStatusEmoji || undefined;
    summon = meta.summon || undefined;
    provider = meta.provider || undefined;
    acpProviderId = meta.acpProviderId || undefined;
    jobRunId = meta.jobRunId || undefined;
    jobStepId = meta.jobStepId || undefined;
    // Set by the list route on the run's representative row only — a run owns
    // every chat it ever opened, so the status alone would flag all of them.
    jobNeedsYou = meta.jobRunNeedsYou === true;
  } catch {}

  const jobAwaitingApproval = !!jobRunId && jobNeedsYou;

  const hasUnread = lastReadAt ? new Date(chat.updated_at) > new Date(lastReadAt) : false;

  const displayName = title || (preview ? (preview.length > 60 ? preview.slice(0, 60) + "..." : preview) : folderName);

  /**
   * The dim, with the rows that need you taken back out of it.
   *
   * A faded row that is the open one, has a summon on it, has unread output,
   * or is the row a job run is waiting on for approval is the precise inverse
   * of what the dim is for — the point is to make live work stand out, and
   * those are the loudest live work there is. The exemption lives here rather
   * than in the list because each is already parsed out of the chat's metadata
   * a few lines up.
   *
   * Those four are the whole list: `Props` carries no permission-prompt state
   * (`sessionStatus` distinguishes only web from cli), so a row holding one is
   * not something this component can currently see.
   *
   * What the fade costs, measured rather than assumed: `opacity` composites the
   * whole row against `--bg-sidebar`, so it drags every pairing in the row down
   * together. `--chatlist-item-dimmed-opacity` is set per theme to keep the row
   * *title* above 4.5:1 (5.31:1 dark, 5.20:1 light). The row's secondary text
   * and badges do not clear AA when faded and cannot be made to: timestamps
   * start at 5.75:1 / 5.63:1, so AA caps any dim at 0.85 / 0.90 opacity, which
   * is not a visible dim. That is a property of fading with opacity, not of
   * these two values.
   */
  const faded = !!dimmed && !isActive && !summon && !hasUnread && !jobAwaitingApproval;

  // The same hook the board's two faces run on, so a click, a long press and a
  // modified click mean here what they mean there. `displayName` is the label
  // because it is what the row says — a checkbox announcing the folder path of
  // a chat titled "Fix the rebase" names a control the user cannot see.
  const { handleClick, gestureProps, inert, showCheckbox, checkboxLabel, hoverProps, checkboxFocusProps } = useSelectionActivation({
    label: displayName,
    selectionMode,
    selectable,
    onClick,
    onToggleSelect,
    onLongPress,
  });

  return (
    <div
      onClick={handleClick}
      // Both hover consumers, chained: the row has kept its own `hovered` for
      // the kebab since long before selection existed, and the hook keeps its
      // own for the checkbox. Chaining rather than merging them leaves the
      // shared hook self-contained — it is not the sidebar's business what
      // else this row does on hover.
      onMouseEnter={() => {
        setHovered(true);
        hoverProps.onMouseEnter();
      }}
      onMouseLeave={() => {
        setHovered(false);
        hoverProps.onMouseLeave();
      }}
      {...gestureProps}
      // `role`/`aria-pressed` only once the list offers selection, matching
      // CardRow's `aria-pressed={selectionMode ? selected : undefined}`. A
      // plain row stays an unnamed clickable div, exactly as it has been: a
      // role announcing a keyboard contract this div does not implement would
      // be worse than no role at all.
      role={onToggleSelect ? "button" : undefined}
      aria-pressed={onToggleSelect && selectionMode ? selected : undefined}
      aria-disabled={inert || undefined}
      className={faded ? "chatlist-item-dimmed" : undefined}
      style={{
        position: "relative",
        padding: "12px 14px",
        borderBottom: "1px solid var(--chatlist-item-border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: inert ? "default" : "pointer",
        background: isActive ? "var(--chatlist-item-active-bg)" : "var(--chatlist-item-bg)",
        // The selected row says so with the accent on the left bar and a ring,
        // the same pair CardRow uses. The bar is 3px on every row, coloured or
        // transparent, so selecting one never nudges the text beside it — and
        // the active chat keeps its own bar, since "selected" and "open" are
        // different facts that can both be true.
        borderLeft: `3px solid ${selected ? "var(--accent)" : isActive ? "var(--chatlist-item-active-border)" : "transparent"}`,
        outline: selected ? "1px solid var(--accent)" : "none",
        outlineOffset: -1,
        // A selected row is never dimmed; an out-of-scope one always is.
        opacity: selected ? 1 : inert ? 0.35 : undefined,
        // Deliberately NOT `touch-action: none`: owning the gesture that way
        // breaks sidebar scrolling and suppresses the pointercancel that tells
        // us a press became a scroll.
        userSelect: selectionMode ? "none" : undefined,
        WebkitTouchCallout: selectionMode ? "none" : undefined,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
            flexWrap: "nowrap",
            fontSize: 11,
            color: "var(--chatlist-item-time-text)",
          }}
        >
          <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{time}</span>
          {chat.git_branch && (
            <span
              title={chat.folder !== chat.displayFolder ? `Worktree: ${chat.git_branch}` : `Branch: ${chat.git_branch}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                padding: "0 5px",
                borderRadius: 3,
                background: "var(--chatlist-badge-agent-bg)",
                color: "var(--chatlist-item-time-text)",
                maxWidth: 140,
                minWidth: 0,
                flexShrink: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              <GitBranch size={10} style={{ flexShrink: 0 }} />
              {chat.git_branch}
            </span>
          )}
          {displayPath && <FolderPathPill path={displayPath} />}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
          {isBookmarked && <Bookmark size={14} style={{ color: "var(--chatlist-bookmark-icon)", flexShrink: 0 }} fill="var(--chatlist-bookmark-icon)" />}
          {agentAlias && (
            <span
              title={`Agent: ${agentAlias}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--chatlist-badge-agent-bg)",
                color: "var(--chatlist-badge-agent-text)",
                flexShrink: 0,
              }}
            >
              <Bot size={10} style={{ color: "var(--chatlist-badge-agent-text)" }} />
              {agentAlias}
            </span>
          )}
          {jobRunId && (
            <span
              title={
                jobAwaitingApproval
                  ? `Waiting for your approval — job step${jobStepId ? `: ${jobStepId}` : ""} (run ${jobRunId})`
                  : `Job step${jobStepId ? `: ${jobStepId}` : ""} (run ${jobRunId})`
              }
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 4,
                background: jobAwaitingApproval ? "var(--warning-bg)" : "var(--chatlist-badge-agent-bg)",
                color: jobAwaitingApproval ? "var(--warning)" : "var(--chatlist-badge-agent-text)",
                flexShrink: 0,
              }}
            >
              <Workflow size={10} style={{ color: jobAwaitingApproval ? "var(--warning)" : "var(--chatlist-badge-agent-text)" }} />
              {jobAwaitingApproval ? "needs you" : jobStepId || "job"}
            </span>
          )}
          {isTriggered && !jobRunId && (
            <span
              title="Triggered (automated)"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--chatlist-badge-triggered-bg)",
                color: "var(--chatlist-badge-triggered-text)",
                flexShrink: 0,
              }}
            >
              <Zap size={10} style={{ color: "var(--chatlist-badge-triggered-text)" }} />
            </span>
          )}
          <ProviderBadge provider={provider} acpProviderId={acpProviderId} compact />
          {summon && (
            <span
              title={`Summon: ${summon.message}`}
              onClick={(e) => {
                e.stopPropagation();
                dismissSummon(chat.id).catch(() => {});
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 3,
                fontSize: 10,
                fontWeight: 600,
                padding: "1px 6px",
                borderRadius: 4,
                background: summon.urgency === "urgent" ? "var(--chatlist-summon-urgent-bg)" : "var(--chatlist-summon-bg)",
                color: summon.urgency === "urgent" ? "var(--chatlist-summon-urgent-text)" : "var(--chatlist-summon-text)",
                flexShrink: 0,
                cursor: "pointer",
                animation: summon.urgency === "urgent" ? "pulse 2s ease-in-out infinite" : undefined,
              }}
            >
              <Bell size={10} />
              {summon.message.length > 30 ? summon.message.slice(0, 30) + "..." : summon.message}
            </span>
          )}
          {hasUnread && (
            <span
              title="Unread messages"
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "var(--chatlist-unread-dot)",
                flexShrink: 0,
              }}
            />
          )}
          <div
            style={{
              fontSize: 14,
              fontWeight: hasUnread ? 600 : 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--chatlist-item-title-text)",
            }}
          >
            {displayName}
          </div>
          {sessionStatus?.active && (
            <div
              style={{
                fontSize: 10,
                padding: "1px 4px",
                borderRadius: 3,
                background: sessionStatus.type === "web" ? "var(--chatlist-badge-session-web-bg)" : "var(--chatlist-badge-session-cli-bg)",
                color: "var(--chatlist-badge-session-text)",
                fontWeight: 500,
              }}
            >
              {sessionStatus.type === "web" ? <Globe size={10} /> : <Monitor size={10} />}
            </div>
          )}
        </div>
        {chatStatus && (
          <div
            title={chatStatus}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 3,
              fontSize: 10,
              fontWeight: 500,
              padding: "1px 6px",
              borderRadius: 4,
              background: "var(--chatlist-badge-status-bg)",
              color: "var(--chatlist-badge-status-text)",
              marginTop: 3,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              width: "fit-content",
              maxWidth: "100%",
            }}
          >
            {chatStatusEmoji && <span>{chatStatusEmoji}</span>}
            {chatStatus}
          </div>
        )}
      </div>
      {(showActions || showCheckbox) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 0,
            marginLeft: 6,
            flexShrink: 0,
          }}
        >
          {/*
           * The checkbox rides in the row's existing action cluster rather
           * than taking a slot of its own on the left, and that is a
           * deliberate departure from CardRow — worth stating, because the
           * board's checkbox is left-aligned and always mounted.
           *
           * Left is not available: a card face opens with a fixed 18px emoji
           * cell that the checkbox swaps over, and this row opens with a dense
           * line of timestamp, branch and folder pills. There is nothing to
           * swap, so a left-hand checkbox either overlaps that line or shifts
           * the whole row's text sideways on hover. The cluster on the right
           * already appears on hover (it always has — the kebab lives in it),
           * so putting the checkbox there adds no movement the row did not
           * already have.
           *
           * The cost of not being always-mounted is a tab stop, and it is one
           * this row never had: the row itself carries no tabindex, and the
           * kebab beside it has been hover-gated since it was written. So
           * there is no keyboard path this takes away. `checkboxFocusProps` is
           * still wired, which is what keeps the control from vanishing out
           * from under a focus ring the moment the pointer leaves.
           */}
          {onToggleSelect && (
            <button
              role="checkbox"
              aria-checked={selected}
              aria-label={checkboxLabel}
              // Not a sibling of the row's clickable surface — it is a
              // descendant of it, so the toggle has to stop the row's own
              // handler from running as well and toggling straight back.
              onClick={(e) => {
                e.stopPropagation();
                onToggleSelect(e);
              }}
              disabled={inert}
              {...stopGesture}
              {...checkboxFocusProps}
              style={{
                width: 18,
                height: 18,
                marginRight: 6,
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                borderRadius: 4,
                border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                background: selected ? "var(--accent)" : "var(--chatlist-item-bg)",
                color: "var(--text-on-accent)",
                cursor: inert ? "default" : "pointer",
                opacity: showCheckbox ? 1 : 0,
                pointerEvents: showCheckbox ? "auto" : "none",
              }}
            >
              {/* A checkmark, not just a colour — colour alone is not a state. */}
              {selected && <Check size={12} strokeWidth={3} />}
            </button>
          )}
          {showMenuButton && (
            <button
              {...stopGesture}
              onClick={(e) => {
                e.stopPropagation();
                if (menuOpen) {
                  setMenuPos(null);
                  return;
                }
                const rect = e.currentTarget.getBoundingClientRect();
                const right = Math.max(8, window.innerWidth - rect.right);
                // Flip upward when there isn't room below in the viewport.
                if (rect.bottom + MENU_ESTIMATED_HEIGHT > window.innerHeight) {
                  setMenuPos({ bottom: window.innerHeight - rect.top + 4, right });
                } else {
                  setMenuPos({ top: rect.bottom + 4, right });
                }
              }}
              title="Chat actions"
              style={{
                background: "none",
                color: menuOpen ? "var(--chatlist-icon-active)" : "var(--chatlist-icon)",
                padding: "2px 4px",
                display: "flex",
                alignItems: "center",
              }}
            >
              <EllipsisVertical size={14} />
            </button>
          )}
          {/*
           * Portaled to the body, not rendered in place. A dimmed row carries
           * `opacity` (see `faded` above), which both fades every descendant —
           * `position: fixed` does not opt a child out of its parent's alpha —
           * and makes the row a stacking context the popup's z-index cannot
           * escape. React events still bubble through the React tree, so the
           * stopPropagation calls below keep blocking the row's onClick.
           */}
          {menuOpen &&
            createPortal(
              <>
                {/* Click-away overlay — also blocks the row's onClick. */}
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuPos(null);
                  }}
                  style={{ position: "fixed", inset: 0, zIndex: 50 }}
                />
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: "fixed",
                    top: menuPos.top,
                    bottom: menuPos.bottom,
                    right: menuPos.right,
                    minWidth: 180,
                    zIndex: 51,
                    padding: 6,
                    borderRadius: 10,
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    boxShadow: "var(--shadow-md)",
                  }}
                >
                  {onToggleBookmark && (
                    <MenuRow
                      icon={
                        <Bookmark
                          size={16}
                          style={{ color: isBookmarked ? "var(--chatlist-bookmark-icon)" : undefined }}
                          fill={isBookmarked ? "var(--chatlist-bookmark-icon)" : "none"}
                        />
                      }
                      label={isBookmarked ? "Remove bookmark" : "Bookmark"}
                      title={isBookmarked ? "Remove bookmark" : "Bookmark this chat"}
                      onClick={() => {
                        setMenuPos(null);
                        onToggleBookmark(!isBookmarked);
                      }}
                    />
                  )}
                  {cardMenu?.card && cardMenu.onToggleLifecycle && (
                    <MenuRow
                      icon={cardMenu.card.lifecycle === "open" ? <Archive size={16} /> : <ArchiveRestore size={16} />}
                      label={cardMenu.card.lifecycle === "open" ? "Archive chat" : "Unarchive chat"}
                      title={cardLifecycleTitle(cardMenu.card)}
                      onClick={() => {
                        setMenuPos(null);
                        cardMenu.onToggleLifecycle!();
                      }}
                    />
                  )}
                  {onEditTitle && (
                    <MenuRow
                      icon={<Pencil size={16} />}
                      label="Edit title"
                      title="Rename this chat, or have a title re-derived from what the conversation has become"
                      onClick={() => {
                        setMenuPos(null);
                        onEditTitle();
                      }}
                    />
                  )}
                  <MenuRow
                    icon={<X size={16} />}
                    label="Delete"
                    title="Delete this chat"
                    danger
                    onClick={() => {
                      setMenuPos(null);
                      onDelete();
                    }}
                  />
                </div>
              </>,
              document.body,
            )}
        </div>
      )}
    </div>
  );
}
