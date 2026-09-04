import type { CardSummary } from "../../api";
import { formatRelativeTime } from "../../utils/dateFormat";
import { cardFolderSummary, ROLLUP_COLORS, statusLine, useCardActivation, useCardCountdown } from "./cardFace";
import CardPathLabel from "./CardPathLabel";
import { commonPathPrefix } from "../../utils/pathTruncate";
import { useIsMobile } from "../../hooks/useIsMobile";
import { MessageSquare, Pin, Check, ChevronRight, ChevronDown } from "lucide-react";

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
  /** Whether this row's folder breakdown is open. The board owns it — see Board.tsx's isExpanded. */
  expanded?: boolean;
  /** Absent means no chevron at all, exactly as an absent onToggleSelect means no checkbox. */
  onToggleExpand?: () => void;
  /** Opens the drawer filtered to one folder. Absent leaves the folder entries unclickable text. */
  onOpenFolder?: (folder: string) => void;
}

/**
 * A 20-folder expansion pushes every other card off the screen, and the
 * measured tail is 11, 12, 12, 16, 20. The cap is what keeps an expansion a
 * summary rather than a navigation — the drawer is the navigation, and the
 * footer goes there.
 */
const EXPANSION_CAP = 8;

/**
 * Live folders only. `cardFolders` already distinguishes the two states, and
 * the distinction is the useful half: "someone is blocked on you in that
 * worktree" is a different fact from "something is running there".
 */
const FOLDER_LIVE_COLORS: Record<"waiting" | "ongoing", string> = {
  waiting: "var(--board-rollup-needs-you)",
  ongoing: "var(--board-rollup-active)",
};

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
  expanded = false,
  onToggleExpand,
  onOpenFolder,
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

  // 97% of cards live in exactly one folder. An affordance that does nothing
  // on 794 of 818 rows is noise on every one of them, so the chevron exists
  // only where there is a second folder to open onto.
  const expandable = folders.length > 1 && Boolean(onToggleExpand);
  const showExpansion = expandable && expanded;

  const folderCell = (
    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
      {/* The 12px slot phase 2a reserved. Held open on every row, chevron or
          not, so each path in the column starts at the same x.

          A span rather than a button, deliberately: this cell lives inside the
          row's main <button>, and a focusable control nested in a button is
          invalid HTML that screen readers and keyboards both mishandle. The
          keyboard path to the same state is the board header's expand toggle,
          which sets the resting state for every row; once a row IS open, its
          folder entries below are real buttons that Tab reaches. */}
      <span style={{ width: 12, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {expandable && (
          <span
            onClick={(e) => {
              // The row's own click opens the drawer; this one must not.
              e.stopPropagation();
              onToggleExpand?.();
            }}
            // The long-press gesture lives on the outer element, so without
            // this a held finger on the chevron would enter selection mode and
            // the release would ALSO toggle the row. The chevron owns its
            // gesture, exactly as the checkbox does by being a sibling.
            onPointerDown={(e) => e.stopPropagation()}
            title={expanded ? "Hide folders" : `Show all ${folders.length} folders`}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: "var(--board-tile-meta-text)",
              // A thumb needs more than 12px, and what it hits by mistake is
              // the row underneath, which opens a drawer.
              ...(isMobile && { padding: 8, margin: -8 }),
            }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </span>
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

  // One entry PER FOLDER, not per chat: the 20-folder card in the real data
  // has 38 chats, and 38 inline rows on the board is a second drawer.
  const shownFolders = folders.slice(0, EXPANSION_CAP);
  const hiddenCount = folders.length - shownFolders.length;
  // Hoisted out of what is actually on screen, so the header describes the
  // rows under it. This is what stops a twelve-row list printing /home/cybil
  // twelve times; each label keeps the full path in its title regardless.
  const sharedPrefix = commonPathPrefix(shownFolders.map((f) => f.path)) ?? undefined;

  const expansion = showExpansion && (
    <div
      // As with the chevron: the outer element carries the long-press, and a
      // held finger on a folder entry would otherwise select the card and then
      // open the drawer on that folder as it lifted.
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        // Clear of the emoji column, so the breakdown reads as belonging to
        // the row above rather than as more rows.
        padding: isMobile ? "2px 12px 8px 26px" : "2px 12px 8px 40px",
      }}
    >
      {sharedPrefix && (
        <span style={{ fontSize: 11, color: "var(--board-tile-meta-text)", opacity: 0.7, paddingBottom: 2 }}>{sharedPrefix}</span>
      )}
      {shownFolders.map((folder) => (
        <button
          key={folder.path}
          onClick={() => onOpenFolder?.(folder.path)}
          disabled={!onOpenFolder}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            minWidth: 0,
            minHeight: isMobile ? 32 : undefined,
            padding: "2px 6px",
            background: "transparent",
            border: "none",
            borderRadius: 4,
            textAlign: "left",
            font: "inherit",
            color: "var(--board-tile-meta-text)",
            cursor: onOpenFolder ? "pointer" : "default",
          }}
        >
          {/* The dot's box is there on every entry, coloured only when the
              folder is live, so the paths under it stay on one left edge. */}
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              flexShrink: 0,
              background: folder.live ? FOLDER_LIVE_COLORS[folder.live] : "transparent",
            }}
            {...(folder.live && { title: folder.live })}
          />
          <CardPathLabel path={folder.path} prefix={sharedPrefix} color="var(--board-tile-meta-text)" />
          {folder.isRoot && (
            // A label, not a sort surprise: the root is pinned to the top of
            // cardFolders' order even when it is the quietest folder here.
            <span style={{ flexShrink: 0, fontSize: 10, opacity: 0.7 }}>root</span>
          )}
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 3, flexShrink: 0, fontSize: 11 }}>
            <MessageSquare size={10} />
            {folder.chatCount}
          </span>
          <span style={{ flexShrink: 0, fontSize: 11, width: TIME_WIDTH, textAlign: "right" }}>{formatRelativeTime(folder.lastActivityAt)}</span>
        </button>
      ))}
      {hiddenCount > 0 && (
        // The drawer is where a fan-out this wide gets navigated, so the
        // overflow goes there rather than growing the row.
        <button
          onClick={onClick}
          style={{
            display: "flex",
            alignItems: "center",
            minHeight: isMobile ? 32 : undefined,
            padding: "2px 6px",
            background: "transparent",
            border: "none",
            borderRadius: 4,
            font: "inherit",
            fontSize: 11,
            color: "var(--board-tile-meta-text)",
            opacity: 0.8,
            cursor: "pointer",
          }}
        >
          … {hiddenCount} more
        </button>
      )}
    </div>
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
        // A column so the folder breakdown can sit BELOW the row's button as
        // its sibling. It cannot sit inside: a folder entry is a button, and a
        // button inside a button is invalid markup that the HTML parser splits
        // apart and that keyboards and screen readers cannot drive.
        display: "flex",
        flexDirection: "column",
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

      {expansion}
    </div>
  );
}
