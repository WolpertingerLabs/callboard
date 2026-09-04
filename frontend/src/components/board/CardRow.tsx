import { useEffect, useRef } from "react";
import type { CardSummary } from "../../api";
import { formatRelativeTime } from "../../utils/dateFormat";
import { cardFolderSummary, FOLDER_LIVE_COLORS, ROLLUP_COLORS, statusLine, useCardActivation, useCardCountdown } from "./cardFace";
import CardFolderLine from "./CardFolderLine";
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
  /**
   * Opens the drawer filtered to one folder.
   *
   * Required, unlike its neighbours: those are absent-means-no-affordance, but
   * an expansion whose entries do nothing is not a lesser expansion, it is a
   * dead one. Optional produced a `disabled` folder-entry state no caller
   * could reach and no design had asked for.
   */
  onOpenFolder: (folder: string) => void;
}

/**
 * A 20-folder expansion pushes every other card off the screen, and the
 * measured tail is 11, 12, 12, 16, 20. The cap is what keeps an expansion a
 * summary rather than a navigation — the drawer is the navigation, and the
 * footer goes there.
 */
const EXPANSION_CAP = 8;

/**
 * The chevron's touch target on mobile.
 *
 * The plan promised 44px and 44px is what a row gets; the chevron sits inside
 * that row's second line, where a 44px box either overlaps the status cell
 * beside it or pushes the path out of the line. 36px is the compromise: a
 * real target, comfortably above the 28px it had, and it fits.
 *
 * Horizontally. Vertically it did not: a 36px box on a line of 11px text is
 * the tallest thing in the row, and measured at 360px it took the ~3% of
 * cards that fan out from 58px to 77px — a third taller than the rows either
 * side of them, in the view whose whole argument is that columns line up.
 * `CHEVRON_BLEED` gives that height back to the line while the target keeps
 * it, by letting the box overhang above and below instead of pushing.
 *
 * Block-only, and that restriction is the original point restated: a target
 * that bled sideways would sit over the status text next to it, where a miss
 * opens the drawer. Above and below is the row's own padding and its own
 * first line, where a miss hits the row it was aimed at.
 */
const CHEVRON_TOUCH = 36;
/** (36 − 16)/2: back to the ~16px a line of this row's text occupies. */
const CHEVRON_BLEED = -10;

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

/**
 * Nothing in this row recedes by `opacity`, and the reason is measured.
 *
 * `--board-tile-meta-text` is 5.62:1 dark / 6.09:1 light on `--board-tile-bg`.
 * Composited at 0.7 — which is where the running job, the hoisted prefix, the
 * `root` label and the `… N more` footer all sat — it lands at 3.43:1 / 3.16:1,
 * under the 4.5:1 AA floor, and the two smallest of those are 10 and 11px.
 * There is no headroom to buy back either: even 0.9 only reaches 4.81 / 4.84,
 * for a dim nobody can see. So these read at the token's full strength and
 * take their hierarchy from position, size and separators instead. The same
 * trap `index.css` documents on --board-group-label-muted-text.
 *
 * (The dim on the whole row for a closed or out-of-scope card is a different
 * thing and stays: it is a deliberate statement about the row, made once,
 * exactly as the tile makes it.)
 */

/** One text cell: nothing in a row may push the columns apart. */
const ellipsis: React.CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

/**
 * Off screen but in the accessibility tree — not `display: none`, which takes
 * it out of both.
 *
 * `clip` for the browsers that want the deprecated one and `clipPath` for the
 * rest; a 1px box rather than a zero one, because a zero-sized element is
 * skipped by some screen readers outright.
 */
const VISUALLY_HIDDEN: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * Spread onto a control inside the row that owns its own click, so the row's
 * long press does not also fire on it.
 *
 * BOTH triggers, because `useLongPress` has two and they are independent: the
 * held-pointer timer that `pointerdown` starts, and `contextmenu` — which is
 * what Android Chrome fires on a long press, and which bubbles on its own even
 * when the pointer event beneath it was stopped. Guarding only `pointerdown`
 * leaves the gesture live on exactly the platform the second trigger exists
 * for, and leaves the hook's click-suppression flag set with no `pointerdown`
 * reaching the row to clear it — which then swallows the row's next activation.
 */
const stopGesture = {
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onContextMenu: (e: React.MouseEvent) => e.stopPropagation(),
};

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

  const { handleClick, handleActivate, gestureProps, inert, showCheckbox, checkboxLabel, hoverProps, checkboxFocusProps } = useCardActivation({
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
        // No opacity here, and none anywhere else in this row — see the note
        // above `ellipsis`. The separator is what sets the job apart from the
        // status; at 12px the colour cannot be.
        <>
          {card.status ? " · " : ""}
          {jobName}
        </>
      )}
    </span>
  );

  // 794 of 818 cards (97.1%) have at most one path — 722 in exactly one
  // folder, 72 with none at all. An affordance that does nothing on 794 of
  // 818 rows is noise on every one of them, so the chevron exists only where
  // there is a second folder to open onto.
  const expandable = folders.length > 1 && Boolean(onToggleExpand);
  const showExpansion = expandable && expanded;

  // One entry PER FOLDER, not per chat: the 20-folder card in the real data
  // has 38 chats, and 38 inline rows on the board is a second drawer.
  const shownFolders = folders.slice(0, EXPANSION_CAP);
  const hiddenCount = folders.length - shownFolders.length;

  const rowRef = useRef<HTMLButtonElement>(null);
  // Whether focus is currently somewhere inside the expansion.
  const focusInsideExpansion = useRef(false);
  // The entries as they actually stand, so the guard below re-runs when the
  // poll drops ONE of three — the case it names but did not watch, since
  // `showExpansion` stays true throughout and the effect never fired.
  const shownKey = shownFolders.map((f) => f.path).join("\n");
  useEffect(() => {
    if (!focusInsideExpansion.current) return;
    // Focus is still on something real — a surviving entry, or wherever the
    // user has since put it. Nothing to hand back.
    if (document.activeElement && document.activeElement !== document.body) {
      if (!showExpansion) focusInsideExpansion.current = false;
      return;
    }
    focusInsideExpansion.current = false;
    // A collapse — by the chevron, by the header toggle, or by the 15s poll
    // dropping a folder unprompted — must not leave a keyboard user on
    // <body>, back at the top of the document. The row it belonged to is the
    // nearest thing that still exists.
    rowRef.current?.focus();
  }, [showExpansion, shownKey]);

  // ArrowRight opens, ArrowLeft closes — the disclosure convention, and the
  // only keyboard path to one row's expansion now that the chevron is a span
  // inside the button rather than a control of its own.
  //
  // Deliberately NO aria-expanded on that button: Enter opens the drawer, so
  // a button announcing itself as the expander would be lying about what
  // activating it does.
  const handleKeyDown = expandable
    ? (e: React.KeyboardEvent) => {
        if (e.key === "ArrowRight" && !expanded) onToggleExpand?.();
        else if (e.key === "ArrowLeft" && expanded) onToggleExpand?.();
        else return;
        e.preventDefault();
      }
    : undefined;

  /**
   * Whether there is a folder line to draw at all.
   *
   * 8.8% of cards — 72 of 818, every lineage on the retired provider — come
   * back with no member rows and so no folders, which is one card in eleven
   * rather than an edge case. Both faces agree there is nothing to draw; they
   * differ only in what they do with the space, and that difference is the
   * grid: desktop still emits an empty cell because the template has a track
   * for it and a missing child shifts every cell after it into the wrong
   * column, while mobile's second line is a free flex row with no column to
   * hold open and would only be spending width on a blank.
   */
  const hasFolderLine = folders.length > 0;

  const folderCell = (
    <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
      {/* The 12px slot phase 2a reserved. Held open on every DESKTOP row,
          chevron or not, so each path in the column starts at the same x.
          Mobile has no such column — line two is a free flex row — so there
          the slot is the touch target or it is nothing; 36px of dead space on
          a 360px screen aligns nothing and costs the path its width.

          A span rather than a button, deliberately: this cell lives inside the
          row's main <button>, and a focusable control nested in a button is
          invalid HTML that screen readers and keyboards both mishandle. The
          keyboard path is ArrowRight/ArrowLeft on the row button itself. */}
      <span
        style={{
          width: isMobile ? (expandable ? CHEVRON_TOUCH : 0) : 12,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {expandable && (
          // The state, for anyone who cannot see the chevron pointing at it.
          //
          // The chevron itself is `aria-hidden` (a decorative span with no
          // keyboard path, whose `title` would otherwise leak into the row's
          // name) and the row button deliberately carries no `aria-expanded`,
          // because Enter on it opens the drawer and the attribute would be
          // lying about what activating it does. Between those two correct
          // decisions, nothing said the state existed or that ArrowRight had
          // changed it. This participates in name-from-content, so the row is
          // named "… 3 folders, collapsed …" without any part of it claiming
          // to be the expander.
          <span style={VISUALLY_HIDDEN}>{`${folders.length} folders, ${expanded ? "expanded" : "collapsed"}`}</span>
        )}
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
            {...stopGesture}
            title={expanded ? "Hide folders" : `Show all ${folders.length} folders`}
            // A decision, not an accident: this span has no keyboard path and
            // is already absent from the accessibility tree, so saying so
            // stops its `title` from leaking into the row's name. The keyboard
            // equivalent is on the row button, where focus actually lands.
            aria-hidden
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: "var(--board-tile-meta-text)",
              // A thumb needs more than 12px, and what it hits by mistake is
              // the row underneath, which opens a drawer. Sized rather than
              // bled sideways, so the target cannot reach into the status
              // cell beside it — and bled upwards and downwards, so it does
              // not make its row a third taller than the ones around it. See
              // CHEVRON_TOUCH.
              ...(isMobile && { width: CHEVRON_TOUCH, height: CHEVRON_TOUCH, marginBlock: CHEVRON_BLEED }),
            }}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </span>
      <CardFolderLine folders={folders} extraCount={extraCount} extrasLive={extrasLive} />
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

  // The row's accessible name is built from its contents, so without labels
  // on these last two cells it ends "…callboard +3 Active 4 2h" — a run-on of
  // bare numbers whose meaning was carried entirely by an icon and a column
  // position. A descendant's aria-label does participate in name-from-content,
  // so one label per cell is enough; the row needs no name of its own.
  const countCell = (
    <span
      aria-label={`${card.chatCount} chat${card.chatCount === 1 ? "" : "s"}`}
      style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 3, fontSize: 11, color: "var(--board-tile-meta-text)", ...(isMobile ? {} : { width: COUNT_WIDTH }) }}
    >
      <MessageSquare size={11} />
      {card.chatCount}
    </span>
  );

  const timeCell = (
    <span
      aria-label={`last active ${formatRelativeTime(card.lastActivityAt)} ago`}
      style={{ fontSize: 11, color: "var(--board-tile-meta-text)", textAlign: "right", ...(isMobile ? {} : { width: TIME_WIDTH }) }}
    >
      {formatRelativeTime(card.lastActivityAt)}
    </span>
  );

  // Hoisted out of what is actually on screen, so the header describes the
  // rows under it. This is what stops a twelve-row list printing /home/cybil
  // twelve times; each label keeps the full path in its title regardless.
  const sharedPrefix = commonPathPrefix(shownFolders.map((f) => f.path)) ?? undefined;

  const expansion = showExpansion && (
    <div
      // As with the chevron: the outer element carries the long-press, and a
      // held finger on a folder entry would otherwise select the card and then
      // open the drawer on that folder as it lifted.
      {...stopGesture}
      // Tab lands in here from the row above with no announcement that the
      // context changed; the group ties these buttons back to the card whose
      // folders they are.
      role="group"
      aria-label={`Folders ${card.title} spans`}
      onFocus={() => (focusInsideExpansion.current = true)}
      onBlur={(e) => {
        // Tabbing from one entry to the next: the focus that follows would
        // set the flag straight back, but there is no reason to drop it.
        if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) return;
        // Focus has left, and the flag goes with it — UNLESS this is the
        // expansion going away under the focused entry, which leaves
        // `relatedTarget` null and is the one case the flag exists for.
        //
        // Whether the entry is still in the document tells the two apart. A
        // click on unfocusable board background also blurs to null, and
        // reading that as an unmount left the flag standing for the next
        // unprompted collapse, which then yanked focus — and the viewport —
        // back to a row the user had walked away from.
        if (e.relatedTarget || e.target.isConnected) focusInsideExpansion.current = false;
      }}
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
        <span style={{ fontSize: 11, color: "var(--board-tile-meta-text)", paddingBottom: 2 }}>{sharedPrefix}</span>
      )}
      {shownFolders.map((folder) => (
        <button
          key={folder.path}
          // The same activation contract as the row above it, not a raw
          // handler: the expansion is a SIBLING of the row's button, so it
          // inherits none of that button's `disabled`, and a click here has to
          // answer a long press and a selection in progress exactly as a click
          // on the row does. Only the destination differs — filtered, not open.
          onClick={handleActivate(() => onOpenFolder(folder.path))}
          disabled={inert}
          // Named in full, because the path label inside is middle-truncated
          // and the chat count and time beside it are bare numbers in columns
          // a screen reader cannot see. The card's title is in here too: this
          // button is one of eight identical-looking rows under one of many
          // cards, and the group label above is not repeated per entry.
          aria-label={[
            folder.path,
            `${folder.chatCount} chat${folder.chatCount === 1 ? "" : "s"}`,
            folder.isRoot ? "root folder" : null,
            folder.live === "waiting" ? "needs you" : folder.live === "ongoing" ? "active" : null,
            `in ${card.title}`,
          ]
            .filter(Boolean)
            .join(", ")}
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
            cursor: inert ? "default" : "pointer",
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
            <span style={{ flexShrink: 0, fontSize: 10 }}>root</span>
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
          // handleClick, not the raw prop: this is the row's own "open
          // unfiltered" gesture, and going straight to onClick bypassed the
          // click-suppression that keeps a long press from also navigating.
          onClick={handleClick}
          disabled={inert}
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
            cursor: inert ? "default" : "pointer",
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
            // The row's own top padding, NOT a 50% of the outer element: that
            // element is a column holding the row AND its expansion, so on an
            // expanded card the checkbox centred on it drifted a hundred pixels
            // down the folder list while the emoji it replaces stayed blanked
            // on the first line. Both branches align to the padding of the
            // button beside them — 7px desktop, 8px mobile plus 2 to sit on
            // the first of two lines.
            top: isMobile ? 10 : 7,
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
          ref={rowRef}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
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
            {showPath && hasFolderLine && <span style={{ flex: 1, minWidth: 0, display: "flex" }}>{folderCell}</span>}
            <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              {countCell}
              {timeCell}
            </span>
          </span>
        </button>
      ) : (
        <button
          ref={rowRef}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
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
          {/* The track's placeholder on a card with nothing to put in it —
              see `hasFolderLine`. An empty <span> rather than `folderCell`,
              so the 12px chevron slot is not held open to align a path that
              is not there. */}
          {showPath && (hasFolderLine ? folderCell : <span />)}
          {rollupCell}
          {countCell}
          {timeCell}
        </button>
      )}

      {expansion}
    </div>
  );
}
