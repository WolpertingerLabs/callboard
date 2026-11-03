import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MenuRoleContext } from "./MenuRow";

/** Where the popup sits, in viewport coordinates (it is `position: fixed`). */
export interface PopupMenuPosition {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

/** How long a touch-opened menu ignores its backdrop — see `openedByTouch`. */
const TOUCH_GRACE_MS = 300;

/**
 * The sidebar's popup menu: ChatListItem's kebab menu and ChatTreeList's
 * right-click / long-press menu are both this, so they open, close and read
 * the same way.
 *
 * Portaled to the body, not rendered in place. A dimmed row carries `opacity`,
 * which fades every descendant — `position: fixed` does not opt a child out of
 * its parent's alpha — and makes the row a stacking context the popup's
 * z-index cannot escape. React events still bubble through the React tree, so
 * the stopPropagation calls below keep a click in the menu (or on the
 * backdrop) from reaching the row's own onClick.
 *
 * Closes on a backdrop click or right-click, on Escape, and on any scroll or
 * resize — the position is a snapshot of where the trigger was when it
 * opened, so a scrolled sidebar would leave the menu floating over the wrong
 * row. Escape hands focus back to `returnFocusTo`.
 *
 * Keyboard: the first item takes focus on open, ArrowUp/ArrowDown move between
 * items, Tab closes.
 */
export default function PopupMenu({
  position,
  onClose,
  label,
  minWidth = 180,
  openedByTouch = false,
  returnFocusTo,
  children,
}: {
  position: PopupMenuPosition;
  onClose: () => void;
  /** Accessible name for the menu. */
  label: string;
  minWidth?: number;
  /**
   * The menu was opened by a long press. The finger that held it is still
   * down, and its release can land as a click on the backdrop that just
   * appeared under it — closing the menu the instant it opened. Backdrop
   * clicks are ignored for a moment after a touch open.
   */
  openedByTouch?: boolean;
  /** Focused again when Escape closes the menu — normally its trigger. */
  returnFocusTo?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  // When the menu mounted — a lazy initializer, read once, so render stays pure.
  const [openedAt] = useState(() => Date.now());
  // Read through refs so the listeners are bound once per open, not per render.
  const onCloseRef = useRef(onClose);
  const returnFocusRef = useRef(returnFocusTo);
  useEffect(() => {
    onCloseRef.current = onClose;
    returnFocusRef.current = returnFocusTo;
  });

  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    const close = () => onCloseRef.current();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      close();
      returnFocusRef.current?.current?.focus();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => items[(i + items.length) % items.length]?.focus();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusAt(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusAt(index - 1);
    } else if (e.key === "Tab") {
      onClose();
    }
  };

  const backdropClose = () => {
    if (openedByTouch && Date.now() - openedAt < TOUCH_GRACE_MS) return;
    onClose();
  };

  return createPortal(
    <>
      <div
        onClick={(e) => {
          e.stopPropagation();
          backdropClose();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          backdropClose();
        }}
        style={{ position: "fixed", inset: 0, zIndex: 50 }}
      />
      <div
        ref={menuRef}
        role="menu"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        onKeyDown={onMenuKeyDown}
        style={{
          position: "fixed",
          ...position,
          minWidth,
          zIndex: 51,
          padding: 6,
          borderRadius: 10,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-md)",
        }}
      >
        <MenuRoleContext.Provider value={true}>{children}</MenuRoleContext.Provider>
      </div>
    </>,
    document.body,
  );
}

/**
 * Place a menu of roughly `estimatedHeight` against a point: below it, or
 * above when it would run off the bottom of the viewport. `align` picks which
 * edge of the menu meets `x` — "right" for a menu hanging off a trigger at the
 * row's right edge, "left" for one opening at the pointer.
 */
export function placePopupMenu({
  x,
  below,
  above = below,
  align,
  estimatedHeight,
  width = 0,
}: {
  x: number;
  /** y to open downward from. */
  below: number;
  /** y to open upward from, when flipping (defaults to `below`). */
  above?: number;
  align: "left" | "right";
  estimatedHeight: number;
  /** Menu width, to keep a left-aligned menu inside the viewport. */
  width?: number;
}): PopupMenuPosition {
  const vertical = below + estimatedHeight > window.innerHeight ? { bottom: window.innerHeight - above } : { top: below };
  const horizontal = align === "right" ? { right: Math.max(8, window.innerWidth - x) } : { left: Math.max(8, Math.min(x, window.innerWidth - width - 8)) };
  return { ...vertical, ...horizontal };
}
