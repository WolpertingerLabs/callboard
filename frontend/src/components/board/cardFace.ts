/**
 * Everything a card face knows that isn't markup.
 *
 * A tile and a list row show the same facts about the same card and answer the
 * same gestures; only their layout differs. This module is the shared half, so
 * the two faces cannot drift on what "Active" means or on when a click counts
 * as a selection — reimplementing the activation contract per face is exactly
 * where the bug would be.
 */

import { useState, useEffect } from "react";
import type { CardSummary, CardRollupState } from "../../api";
import { needsYouLabel, activeLabel } from "./pendingLabels";
import { cardFolders, type CardFolder } from "../../utils/cardFolders";
import { useLongPress, type UseLongPressResult } from "../../hooks/useLongPress";

export const ROLLUP_LABELS: Record<CardRollupState, string> = {
  needs_you: "Needs you",
  job_running: "Job running",
  active: "Active",
  idle: "Idle",
};

/** Rollup-state colors — themable via the --board-* section of index.css. */
export const ROLLUP_COLORS: Record<CardRollupState, string> = {
  needs_you: "var(--board-rollup-needs-you)",
  job_running: "var(--board-rollup-job-running)",
  active: "var(--board-rollup-active)",
  idle: "var(--board-rollup-idle)",
};

/**
 * `Date.now()`, re-read once a second, but only for cards that have something
 * counting down. The gate is a real perf guard, not a micro-optimisation: it
 * is what keeps a board of idle cards re-rendering no more than it did before
 * countdowns existed, and it matters more in list mode where more faces are on
 * screen at once.
 */
export function useCardCountdown(card: CardSummary): number {
  const hasCountdown =
    card.lifecycle !== "closed" &&
    (card.memberChats.some((c) => c.activity?.expiresAt !== undefined) ||
      card.memberRuns.some((r) => r.nextWakeAt && (r.status === "sleeping" || r.status === "waiting_event")));

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasCountdown) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [hasCountdown]);

  return now;
}

/** The one-line state a card face leads with. */
export function statusLine(card: CardSummary, now: number): string {
  if (card.lifecycle === "closed") return "Closed";
  if (card.rollup === "needs_you") return needsYouLabel(card);
  if (card.rollup === "idle") return ROLLUP_LABELS.idle;
  return activeLabel(card, now);
}

/**
 * Live folders only. `cardFolders` already distinguishes the two states, and
 * the distinction is the useful half: "someone is blocked on you in that
 * worktree" is a different fact from "something is running there".
 */
export const FOLDER_LIVE_COLORS: Record<"waiting" | "ongoing", string> = {
  waiting: "var(--board-rollup-needs-you)",
  ongoing: "var(--board-rollup-active)",
};

export interface CardFolderSummary {
  /** Ordered root-first; empty when paths are off, or the card's member rows are gone. */
  folders: CardFolder[];
  /** Distinct folders OTHER than the root's — zero on 97% of cards, where nothing renders. */
  extraCount: number;
  /**
   * The most urgent live state among those other folders; undefined when none
   * of them is live.
   *
   * The state of the OTHER folders, deliberately, not the card's rollup. A
   * card whose root needs you but whose second folder is merely ticking over
   * would otherwise paint its `+N` in "needs you" — a glyph claiming someone
   * is blocked over there when nobody is, which is the one thing this glyph
   * exists to say.
   */
  extrasLive?: "waiting" | "ongoing";
}

/**
 * The collapsed folder story both faces tell: one path, plus a `+N` that is
 * coloured when the action is somewhere other than the path on show.
 *
 * That colour rule is the whole reason this is shared rather than inlined
 * twice. It is the one glyph that says "the work has moved", which is the
 * failure mode of showing the root path alone — a tile and a row disagreeing
 * about when it lights up would make the board lie on one of them.
 */
export function cardFolderSummary(card: CardSummary, showPath: boolean): CardFolderSummary {
  // Computing it is one pass over an array the face already holds, but there
  // is no reason to make that pass for a board with paths switched off.
  const folders = showPath ? cardFolders(card) : [];
  // `cardFolders` already ranks waiting above ongoing, so the first live one
  // among the extras is the most urgent of them. A closed card has no live
  // anything, whatever its member rows still say.
  const extrasLive = card.lifecycle === "closed" ? undefined : folders.slice(1).find((f) => f.live)?.live;
  return {
    folders,
    extraCount: Math.max(0, folders.length - 1),
    ...(extrasLive && { extrasLive }),
  };
}

export interface UseCardActivationOptions {
  card: CardSummary;
  /** Every field below is optional: with none passed the face behaves exactly as it did before multi-select existed. */
  selectionMode?: boolean;
  selectable?: boolean;
  onClick: () => void;
  /** Receives the event so the board can read shift/meta/ctrl for range and toggle. */
  onToggleSelect?: (e: React.MouseEvent) => void;
  onLongPress?: () => void;
}

export interface UseCardActivationResult {
  handleClick: (e: React.MouseEvent) => void;
  /**
   * The same contract with a different destination.
   *
   * A row's folder entry opens the drawer *filtered*, which is a different
   * `open` from the row's — but every step in front of that decision is
   * identical, and it is the steps in front that are easy to get wrong: a
   * click left over from a long press must not act, and in selection mode a
   * click anywhere on the face toggles the card rather than navigating away
   * from a selection in progress. `handleClick` is this with `onClick`.
   */
  handleActivate: (open: () => void) => (e: React.MouseEvent) => void;
  /** Spread onto the face's outer element; empty when the board asked for no gesture. */
  gestureProps: Partial<UseLongPressResult["handlers"]>;
  /** True for a face outside the selection's lifecycle scope — render it dimmed and disabled. */
  inert: boolean;
  showCheckbox: boolean;
  /** Accessible name for the checkbox — shared so the two faces name the same control identically. */
  checkboxLabel: string;
  /** Spread onto the face's outer element to drive `showCheckbox` from hover. */
  hoverProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  /** Spread onto the checkbox so keyboard focus reveals it too, not only the mouse. */
  checkboxFocusProps: { onFocus: () => void; onBlur: () => void };
}

/** The whole click/press/select contract of a card face, independent of its layout. */
export function useCardActivation({
  card,
  selectionMode = false,
  selectable = true,
  onClick,
  onToggleSelect,
  onLongPress,
}: UseCardActivationOptions): UseCardActivationResult {
  const [hovered, setHovered] = useState(false);
  const [checkboxFocused, setCheckboxFocused] = useState(false);

  const gestures = useLongPress({ onLongPress: () => onLongPress?.() });
  // Only mounted when the board asked for the gesture. Otherwise the
  // contextmenu handler's preventDefault would silently take the browser's own
  // menu away from a tile that has no selection behaviour to offer instead.
  const gestureProps = onLongPress ? gestures.handlers : {};

  const inert = selectionMode && !selectable;
  // Discoverability is the checkbox — Ctrl+click is invisible, and nobody
  // long-presses a surface that has never shown them it can be selected.
  const showCheckbox = Boolean(onToggleSelect) && selectable && (selectionMode || hovered || checkboxFocused);

  const handleActivate = (open: () => void) => (e: React.MouseEvent) => {
    // Out of the selection's lifecycle scope: the face is dead, and a control
    // that is a sibling of the disabled button rather than inside it does not
    // get that for free.
    if (inert) return;
    // A long press or a context menu has already acted on this gesture; the
    // click browsers emit afterwards must not act on it a second time.
    if (onLongPress && gestures.consumeClickSuppression()) return;
    const modified = e.metaKey || e.ctrlKey || e.shiftKey;
    if (selectionMode || (modified && onToggleSelect)) {
      onToggleSelect?.(e);
      return;
    }
    open();
  };

  return {
    handleClick: handleActivate(onClick),
    handleActivate,
    gestureProps,
    inert,
    showCheckbox,
    checkboxLabel: `Select ${card.title}`,
    hoverProps: { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) },
    checkboxFocusProps: { onFocus: () => setCheckboxFocused(true), onBlur: () => setCheckboxFocused(false) },
  };
}
