import type { CardSummary } from "../../api";
import { formatRelativeTime } from "../../utils/dateFormat";
import { cardFolderSummary, ROLLUP_COLORS, statusLine, useCardActivation, useCardCountdown } from "./cardFace";
import CardPathLabel from "./CardPathLabel";
import { useIsMobile } from "../../hooks/useIsMobile";
import { MessageSquare, Pin, Check } from "lucide-react";

interface CardRowProps {
  card: CardSummary;
  onClick: () => void;
  /** Every prop below is optional, and identical to CardTile's — the two faces answer one contract. */
  selectionMode?: boolean;
  selected?: boolean;
  /** False for rows outside the selection's lifecycle scope — rendered inert and dimmed. */
  selectable?: boolean;
  /** Receives the event so the board can read shift/meta/ctrl for range and toggle. */
  onToggleSelect?: (e: React.MouseEvent) => void;
  onLongPress?: () => void;
  /** The board's "show paths" preference. Off by default, which drops the folder column entirely. */
  showPath?: boolean;
}

/**
 * The three trailing columns are `auto` in the shared template, and each row is
 * its own grid — so without a fixed width they would size to their own content
 * and the state, count and time would zig-zag down the list. Sizing the cells
 * instead of the template keeps the template exactly as specified while making
 * those columns resolve identically on every row, which is the alignment the
 * list view exists for.
 */
const ROLLUP_WIDTH = 132;
const COUNT_WIDTH = 38;
const TIME_WIDTH = 44;

/** One text cell: nothing in a row may push the columns apart. */
const ellipsis: React.CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

/**
 * A card as a full-width row.
 *
 * Same facts and the same gestures as `CardTile` — both drive them through
 * `useCardActivation`, which is what keeps a click, a long press and a
 * modified click meaning the same thing on either face. Only the layout
 * differs: a grid on a shared template, so the columns line up down the list.
 * That alignment is the reason to have a list view at all rather than a
 * squashed tile.
 */
export default function CardRow({
  card,
  onClick,
  selectionMode = false,
  selected = false,
  selectable = true,
  onToggleSelect,
  onLongPress,
  showPath = false,
}: CardRowProps) {
  const isMobile = useIsMobile();
  const closed = card.lifecycle === "closed";
  const rollupColor = ROLLUP_COLORS[card.rollup];
  const live = card.rollup !== "idle" && !closed;
  const now = useCardCountdown(card);
  const activeRun = closed ? undefined : card.memberRuns.find((r) => !r.endedAt);

  const { handleClick, gestureProps, inert, showCheckbox, checkboxLabel, hoverProps, checkboxFocusProps } = useCardActivation({
    card,
    selectionMode,
    selectable,
    onClick,
    onToggleSelect,
    onLongPress,
  });

  const { folders, extraCount, extrasLive } = cardFolderSummary(card, showPath);

  const emojiCell = (
    // The same fixed 18px box the tile uses, so the checkbox swaps in over it
    // without shifting the title a pixel.
    <span
      style={{
        fontSize: 15,
        width: 18,
        height: 18,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        visibility: showCheckbox ? "hidden" : "visible",
      }}
    >
      {card.emoji}
    </span>
  );

  const titleCell = (
    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <span style={{ ...ellipsis, fontSize: 13, fontWeight: 600, color: "var(--board-tile-title-text)" }} title={card.title}>
        {card.title}
      </span>
      {card.pinned && <Pin size={11} style={{ color: "var(--accent-text)", flexShrink: 0 }} />}
      {card.unread && (
        <span title="Unread activity" style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--board-unread-dot)", flexShrink: 0 }} />
      )}
    </span>
  );

  /**
   * Status and running job share one cell.
   *
   * The tile gives the job its own line; the row's template has seven columns
   * and an eighth for one optional string would narrow every other row on the
   * board to buy nothing. Sharing the status cell instead keeps the job name —
   * which is exactly the information the board exists to surface, on exactly
   * the cards that are doing something — and the ellipsis the cell already had
   * decides what gives when there isn't room. The `title` carries both in full.
   */
  const jobName = activeRun?.jobName;
  const statusTitle = [card.status, jobName].filter(Boolean).join(" · ");

  const statusCell = (
    <span style={{ ...ellipsis, fontSize: 12, color: "var(--board-tile-meta-text)" }} title={statusTitle}>
      {card.statusEmoji ? `${card.statusEmoji} ` : ""}
      {card.status}
      {jobName && (
        // Opacity rather than a second colour: the job is context for the
        // status beside it, and it has to recede without a new token.
        <span style={{ opacity: 0.7 }}>
          {card.status ? " · " : ""}
          {jobName}
        </span>
      )}
    </span>
  );

  const folderCell = (
    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
      {/* Reserved for phase 2b's expansion chevron. Held open now so every
          path in the column starts at the same x whether or not its card has
          somewhere to expand to, and so adding the control later re-flows
          nothing. */}
      <span style={{ width: 12, flexShrink: 0 }} />
      {folders.length > 0 && (
        <>
          <CardPathLabel path={folders[0].path} color="var(--board-tile-meta-text)" />
          {/* Nothing at all on a single-folder card: a "+0" on 794 of 818
              cards is noise on every one of them. */}
          {extraCount > 0 && (
            <span
              title={`${extraCount} other folder${extraCount === 1 ? "" : "s"}`}
              style={{ flexShrink: 0, fontSize: 11, fontWeight: 600, color: extrasLive ? rollupColor : "var(--board-tile-meta-text)" }}
            >
              +{extraCount}
            </span>
          )}
        </>
      )}
    </span>
  );

  const rollupCell = (
    <span
      style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: rollupColor, ...(isMobile ? { flexShrink: 0 } : { width: ROLLUP_WIDTH }) }}
      title={statusLine(card, now)}
    >
      <span
        style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: rollupColor, ...(live && { boxShadow: `0 0 5px ${rollupColor}` }) }}
      />
      <span style={ellipsis}>{statusLine(card, now)}</span>
    </span>
  );

  const countCell = (
    <span
      style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 3, fontSize: 11, color: "var(--board-tile-meta-text)", ...(isMobile ? {} : { width: COUNT_WIDTH }) }}
    >
      <MessageSquare size={11} />
      {card.chatCount}
    </span>
  );

  const timeCell = (
    <span
      style={{ fontSize: 11, color: "var(--board-tile-meta-text)", textAlign: "right", ...(isMobile ? {} : { width: TIME_WIDTH }) }}
    >
      {formatRelativeTime(card.lastActivityAt)}
    </span>
  );

  return (
    <div
      {...hoverProps}
      {...gestureProps}
      style={{
        position: "relative",
        background: "var(--board-tile-bg)",
        border: "1px solid var(--board-tile-border)",
        // The tile's 1px box-shadow ring reads as a table border once a face
        // spans the page, so a row says "selected" with an outline and a left
        // bar instead. The bar is 2px on every row, coloured or transparent,
        // so selecting one never nudges the text beside it.
        borderLeft: `2px solid ${selected ? "var(--accent)" : live ? rollupColor : "transparent"}`,
        outline: selected ? "1px solid var(--accent)" : "none",
        outlineOffset: -1,
        borderRadius: 6,
        display: "flex",
        minWidth: 0,
        // A selected row is never dimmed — see CardTile for why the dim is an
        // opacity on the whole face and what that costs a selection ring.
        opacity: selected ? 1 : inert ? 0.35 : closed ? 0.65 : 1,
        // Deliberately NOT `touch-action: none`: owning the gesture that way
        // breaks board scrolling and suppresses the pointercancel that tells
        // us a press became a scroll.
        userSelect: "none",
        WebkitTouchCallout: "none",
      }}
    >
      {onToggleSelect && (
        // Always mounted and revealed by opacity, exactly as on the tile, so
        // Tab can reach it — see CardTile for the full reasoning.
        <button
          role="checkbox"
          aria-checked={selected}
          aria-label={checkboxLabel}
          onClick={onToggleSelect}
          disabled={inert}
          {...checkboxFocusProps}
          style={{
            position: "absolute",
            left: 12,
            ...(isMobile ? { top: 10 } : { top: "50%", transform: "translateY(-50%)" }),
            zIndex: 1,
            width: 18,
            height: 18,
            padding: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 4,
            border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
            background: selected ? "var(--accent)" : "var(--board-tile-bg)",
            color: "var(--text-on-accent)",
            cursor: "pointer",
            opacity: showCheckbox ? 1 : 0,
            pointerEvents: showCheckbox ? "auto" : "none",
          }}
        >
          {/* A checkmark, not just a colour — colour alone is not a state. */}
          {selected && <Check size={12} strokeWidth={3} />}
        </button>
      )}

      {isMobile ? (
        <button
          onClick={handleClick}
          disabled={inert}
          aria-pressed={selectionMode ? selected : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            gap: 4,
            // A row is a touch target before it is a layout: 44px is the floor
            // a thumb can hit, and two lines of 11-13px text do not reach it.
            minHeight: 44,
            padding: "8px 12px",
            background: "transparent",
            border: "none",
            borderRadius: 6,
            textAlign: "left",
            font: "inherit",
            color: "inherit",
            cursor: inert ? "default" : "pointer",
          }}
        >
          {/* Two lines rather than seven columns: the phone has room for the
              card's name and its state, and everything else is the second
              line's business. */}
          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, width: "100%" }}>
            {emojiCell}
            <span style={{ flex: 1, minWidth: 0 }}>{titleCell}</span>
            {rollupCell}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, width: "100%", paddingLeft: 26 }}>
            {(card.status || card.statusEmoji || jobName) && <span style={{ flex: 1, minWidth: 0, display: "flex" }}>{statusCell}</span>}
            {showPath && folders.length > 0 && <span style={{ flex: 1, minWidth: 0, display: "flex" }}>{folderCell}</span>}
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              {countCell}
              {timeCell}
            </span>
          </span>
        </button>
      ) : (
        <button
          onClick={handleClick}
          disabled={inert}
          aria-pressed={selectionMode ? selected : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            display: "grid",
            // The shared template — the folders column is dropped outright
            // when paths are off, rather than rendered empty, so the title and
            // status get the width back instead of a blank stripe.
            gridTemplateColumns: showPath
              ? "18px minmax(0,2fr) minmax(0,3fr) minmax(0,1.5fr) auto auto auto"
              : "18px minmax(0,2fr) minmax(0,3fr) auto auto auto",
            alignItems: "center",
            gap: 10,
            padding: "7px 12px",
            background: "transparent",
            border: "none",
            borderRadius: 6,
            textAlign: "left",
            font: "inherit",
            color: "inherit",
            cursor: inert ? "default" : "pointer",
          }}
        >
          {emojiCell}
          {titleCell}
          {statusCell}
          {showPath && folderCell}
          {rollupCell}
          {countCell}
          {timeCell}
        </button>
      )}
    </div>
  );
}
