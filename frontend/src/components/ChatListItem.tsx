import { useEffect, useState } from "react";
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
  SquarePlus,
  FolderInput,
  FolderMinus,
  CircleCheck,
  RotateCcw,
} from "lucide-react";
import type { Chat } from "../api";
import { dismissSummon } from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import ProviderBadge from "./ProviderBadge";
import FolderPathPill from "./FolderPathPill";
import MenuRow from "./MenuRow";

/**
 * Every card (ticket) action for one chat. The sidebar row menu is the single
 * home for these — the chat view's composer menu is about sending messages,
 * not filing tickets.
 *
 * Which entries render is decided by the chat's own `metadata.cardId`, so a
 * card-less chat offers create/add and a filed chat offers close-reopen/remove.
 * `card` is the resolved record, needed only for the lifecycle label; when it
 * hasn't loaded (or the id dangles past a deleted card) that one entry is
 * omitted rather than guessed.
 */
export interface ChatCardMenu {
  card?: { title: string; lifecycle: "open" | "closed" };
  onCreate?: () => void;
  onAdd?: () => void;
  onRemove?: () => void;
  onToggleLifecycle?: () => void;
}

interface Props {
  chat: Chat;
  isActive?: boolean;
  onClick: () => void;
  onDelete: () => void;
  onToggleBookmark?: (bookmarked: boolean) => void;
  /** Card actions for the row menu. Omit to render no card entries at all. */
  cardMenu?: ChatCardMenu;
  sessionStatus?: { active: boolean; type: string };
  /**
   * The list's verdict on "this chat's card is closed or absent" (see
   * `utils/chatDimming`). A *request* to fade, not the last word — the
   * exemptions below can veto it.
   */
  dimmed?: boolean;
}

/** Rough popup height used to decide whether the menu opens downward or upward. */
const MENU_ESTIMATED_HEIGHT = 210;

export default function ChatListItem({ chat, isActive, onClick, onDelete, onToggleBookmark, cardMenu, sessionStatus, dimmed }: Props) {
  const [hovered, setHovered] = useState(false);
  // The kebab popup escapes the sidebar's overflow:auto scroll container via
  // position:fixed, anchored to the button's viewport rect at open time.
  const [menuPos, setMenuPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const menuOpen = menuPos !== null;
  const isMobile = useIsMobile();
  // On touch/mobile there is no hover, so keep the row actions visible. Also
  // keep the kebab mounted while its menu is open (hover is lost to the popup).
  const showActions = isMobile || hovered || menuOpen;

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
  let hasCard = false;
  try {
    const meta = JSON.parse(chat.metadata || "{}");
    title = meta.title;
    preview = meta.preview;
    isBookmarked = meta.bookmarked === true;
    hasCard = typeof meta.cardId === "string" && !!meta.cardId;
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
  } catch {}

  const hasUnread = lastReadAt ? new Date(chat.updated_at) > new Date(lastReadAt) : false;

  const displayName = title || (preview ? (preview.length > 60 ? preview.slice(0, 60) + "..." : preview) : folderName);

  /**
   * The dim, with the rows that need you taken back out of it.
   *
   * A faded row that is holding a permission prompt, has a summon on it, or has
   * unread output is the precise inverse of what this option is for — the point
   * is to make live work stand out, and those three are the loudest live work
   * there is. The exemption lives here rather than in the list because these
   * are already parsed out of the chat's metadata a few lines up.
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
  const faded = !!dimmed && !isActive && !summon && !hasUnread;

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={faded ? "chatlist-item-dimmed" : undefined}
      style={{
        padding: "10px 14px",
        borderBottom: "1px solid var(--chatlist-item-border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        cursor: "pointer",
        background: isActive ? "var(--chatlist-item-active-bg)" : "var(--chatlist-item-bg)",
        borderLeft: isActive ? "3px solid var(--chatlist-item-active-border)" : "3px solid transparent",
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
              title={`Job step${jobStepId ? `: ${jobStepId}` : ""} (run ${jobRunId})`}
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
              <Workflow size={10} style={{ color: "var(--chatlist-badge-agent-text)" }} />
              {jobStepId || "job"}
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
      {showActions && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 0,
            marginLeft: 6,
            flexShrink: 0,
          }}
        >
          <button
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
          {menuOpen && (
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
                {!hasCard && cardMenu?.onCreate && (
                  <MenuRow
                    icon={<SquarePlus size={16} />}
                    label="Create card"
                    title="Promote this chat to a new card"
                    onClick={() => {
                      setMenuPos(null);
                      cardMenu.onCreate!();
                    }}
                  />
                )}
                {!hasCard && cardMenu?.onAdd && (
                  <MenuRow
                    icon={<FolderInput size={16} />}
                    label="Add to card…"
                    title="Add this chat to an existing card"
                    onClick={() => {
                      setMenuPos(null);
                      cardMenu.onAdd!();
                    }}
                  />
                )}
                {hasCard && cardMenu?.card && cardMenu.onToggleLifecycle && (
                  <MenuRow
                    icon={cardMenu.card.lifecycle === "open" ? <CircleCheck size={16} /> : <RotateCcw size={16} />}
                    label={cardMenu.card.lifecycle === "open" ? "Close card" : "Reopen card"}
                    title={
                      cardMenu.card.lifecycle === "open"
                        ? `Close "${cardMenu.card.title}" — it moves to the board's Closed strip`
                        : `Reopen "${cardMenu.card.title}" — it returns to the board`
                    }
                    onClick={() => {
                      setMenuPos(null);
                      cardMenu.onToggleLifecycle!();
                    }}
                  />
                )}
                {hasCard && cardMenu?.onRemove && (
                  <MenuRow
                    icon={<FolderMinus size={16} />}
                    label="Remove from card"
                    title="Take this chat off its card (the card itself is kept)"
                    onClick={() => {
                      setMenuPos(null);
                      cardMenu.onRemove!();
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
            </>
          )}
        </div>
      )}
    </div>
  );
}
