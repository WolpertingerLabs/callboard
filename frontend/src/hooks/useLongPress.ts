import { useCallback, useEffect, useRef } from "react";

export interface UseLongPressOptions {
  onLongPress: () => void;
  /** How long the pointer must be held before the gesture fires. */
  delayMs?: number;
  /** Movement past this many px in either axis abandons the press. */
  moveTolerance?: number;
}

export interface UseLongPressResult {
  /** Spread onto the pressable element. */
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerLeave: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
    onContextMenu: (e: React.MouseEvent) => void;
  };
  /**
   * True at most once per gesture, then self-clearing: the click that a long
   * press or a context menu leaves behind must not also be treated as a tap.
   */
  consumeClickSuppression: () => boolean;
}

/**
 * Long-press / context-menu entry into a selection gesture.
 *
 * Two triggers, because no single one covers the field:
 *
 *  - **A held pointer.** iOS Safari does not reliably fire `contextmenu`, so
 *    without a timer the gesture simply does not exist on iPhone.
 *  - **`contextmenu`.** What Android Chrome fires on a long press (and what
 *    would otherwise pop the browser's own menu over ours). It also hands us
 *    desktop right-click and the keyboard Menu key / Shift+F10 for free.
 *
 * Both are idempotent, so a browser firing both is not a problem.
 *
 * **The timer is gated to non-mouse pointers.** A mouse long-press is a
 * misfire, not a feature: a deliberately slow click — a hand resting on the
 * button past the delay — would enter selection mode instead of doing what
 * the user asked, and the click suppression below would then swallow the
 * action they actually wanted. Desktop gets modifier-click instead.
 *
 * **`pointercancel` is the primary scroll-cancel signal**, not the movement
 * threshold. It is the browser telling us outright that the gesture became a
 * scroll; it needs no coordinates and cannot disagree with the compositor.
 * The `moveTolerance` check is a backstop for browsers slow to fire it.
 *
 * Consequently the pressable element must keep its default `touch-action`.
 * Setting `touch-action: none` to "own" the gesture breaks board scrolling
 * *and* suppresses the very `pointercancel` this design leans on.
 */
export function useLongPress({ onLongPress, delayMs = 500, moveTolerance = 10 }: UseLongPressOptions): UseLongPressResult {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  // A ref, not state: the click arrives in the same interaction as the
  // pointerup that precedes it, and a state update would not be committed in
  // time to be read by the click handler.
  const suppressClickRef = useRef(false);
  // Kept in a ref so a re-rendered parent's fresh callback is picked up
  // without restarting an in-flight timer.
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
  }, []);

  // A timer outliving its component would fire onLongPress against an
  // unmounted tree.
  useEffect(() => clearTimer, [clearTimer]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Bound the suppression flag to one gesture: a flag left set by an
      // earlier press must never swallow an unrelated later click.
      suppressClickRef.current = false;
      if (e.pointerType === "mouse") return;
      clearTimer();
      startRef.current = { x: e.clientX, y: e.clientY };
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        startRef.current = null;
        suppressClickRef.current = true;
        onLongPressRef.current();
      }, delayMs);
    },
    [clearTimer, delayMs],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = startRef.current;
      if (timerRef.current === null || start === null) return;
      if (Math.abs(e.clientX - start.x) > moveTolerance || Math.abs(e.clientY - start.y) > moveTolerance) clearTimer();
    },
    [clearTimer, moveTolerance],
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      clearTimer();
      // macOS turns Ctrl+click into a synthetic right-click: it fires
      // `contextmenu` AND may fire `click` with ctrlKey set. Routing both
      // orderings through the same suppression flag collapses them into one
      // toggle instead of a select-then-immediately-deselect.
      suppressClickRef.current = true;
      onLongPressRef.current();
    },
    [clearTimer],
  );

  const consumeClickSuppression = useCallback(() => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  }, []);

  return {
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: clearTimer,
      onPointerLeave: clearTimer,
      onPointerCancel: clearTimer,
      onContextMenu,
    },
    consumeClickSuppression,
  };
}

export default useLongPress;
