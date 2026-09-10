/**
 * The click/press/select contract of one selectable row, independent of what
 * it is a row OF.
 *
 * Lifted out of `components/board/cardFace.ts`, where it lived as
 * `useCardActivation`, when the sidebar's chat list grew a multi-select of its
 * own. Nothing in here was ever about cards: the only board-shaped thing it
 * touched was `card.title`, for the checkbox's accessible name, which is now
 * the `label` option. Two surfaces answering "what does a click mean while a
 * selection is live?" from two copies of these rules is the bug this file
 * exists to make impossible — the rules are subtle (a click left over from a
 * long press must not act; a modified click toggles instead of navigating; an
 * out-of-scope row is dead rather than merely dimmed) and a second copy would
 * drift on exactly those.
 *
 * `useCardActivation` remains as a thin wrapper so the board's two faces are
 * untouched — see cardFace.ts.
 */

import { useState } from "react";
import { useLongPress, type UseLongPressResult } from "./useLongPress";

export interface UseSelectionActivationOptions {
  /**
   * What the checkbox announces itself as selecting — a card's title, a chat's
   * display name. The one thing this hook needs to know about the row's data.
   */
  label: string;
  /** Every field below is optional: with none passed the row behaves exactly as it did before multi-select existed. */
  selectionMode?: boolean;
  selectable?: boolean;
  onClick: () => void;
  /** Receives the event so the page can read shift/meta/ctrl for range and toggle. */
  onToggleSelect?: (e: React.MouseEvent) => void;
  onLongPress?: () => void;
}

export interface UseSelectionActivationResult {
  handleClick: (e: React.MouseEvent) => void;
  /**
   * The same contract with a different destination.
   *
   * A board row's folder entry opens the drawer *filtered*, which is a
   * different `open` from the row's — but every step in front of that decision
   * is identical, and it is the steps in front that are easy to get wrong: a
   * click left over from a long press must not act, and in selection mode a
   * click anywhere on the row toggles it rather than navigating away from a
   * selection in progress. `handleClick` is this with `onClick`.
   */
  handleActivate: (open: () => void) => (e: React.MouseEvent) => void;
  /** Spread onto the row's outer element; empty when the page asked for no gesture. */
  gestureProps: Partial<UseLongPressResult["handlers"]>;
  /** True for a row outside the selection's scope — render it dimmed and disabled. */
  inert: boolean;
  showCheckbox: boolean;
  /** Accessible name for the checkbox — shared so every surface names the same control identically. */
  checkboxLabel: string;
  /** Spread onto the row's outer element to drive `showCheckbox` from hover. */
  hoverProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  /** Spread onto the checkbox so keyboard focus reveals it too, not only the mouse. */
  checkboxFocusProps: { onFocus: () => void; onBlur: () => void };
}

export function useSelectionActivation({
  label,
  selectionMode = false,
  selectable = true,
  onClick,
  onToggleSelect,
  onLongPress,
}: UseSelectionActivationOptions): UseSelectionActivationResult {
  const [hovered, setHovered] = useState(false);
  const [checkboxFocused, setCheckboxFocused] = useState(false);

  const gestures = useLongPress({ onLongPress: () => onLongPress?.() });
  // Only mounted when the page asked for the gesture. Otherwise the
  // contextmenu handler's preventDefault would silently take the browser's own
  // menu away from a row that has no selection behaviour to offer instead.
  const gestureProps = onLongPress ? gestures.handlers : {};

  const inert = selectionMode && !selectable;
  // Discoverability is the checkbox — Ctrl+click is invisible, and nobody
  // long-presses a surface that has never shown them it can be selected.
  const showCheckbox = Boolean(onToggleSelect) && selectable && (selectionMode || hovered || checkboxFocused);

  const handleActivate = (open: () => void) => (e: React.MouseEvent) => {
    // Out of the selection's scope: the row is dead, and a control that is a
    // sibling of the disabled button rather than inside it does not get that
    // for free.
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
    checkboxLabel: `Select ${label}`,
    hoverProps: { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) },
    checkboxFocusProps: { onFocus: () => setCheckboxFocused(true), onBlur: () => setCheckboxFocused(false) },
  };
}
