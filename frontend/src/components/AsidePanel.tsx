/**
 * The frame the aside chat sits in, beside the main chat: a resizable
 * right-hand column on desktop, a full-screen sheet on mobile.
 *
 * The frame only frames. What is in it — the aside's own Chat, embedded — and
 * its header (title, close) come from the chat page. The frame owns:
 *  - width: dragged on its left edge (or the edge's ArrowLeft / ArrowRight),
 *    kept in localStorage; clamped so the main chat keeps room;
 *  - Escape: closes, unless something inside claimed it first — a menu, a
 *    modal, a text selection the quote bar is showing for;
 *  - focus: moves into the panel on open (the embedded composer takes it on a
 *    device with a keyboard; otherwise the panel itself) and goes back on
 *    close to whatever had it before.
 *
 * No `transform` anywhere on the frame: modals the embedded chat opens are
 * `position: fixed`, and a transformed ancestor would trap them inside it.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ASIDE_PANEL_MIN_WIDTH, getAsidePanelWidth, saveAsidePanelWidth } from "../utils/localStorage";
import { isModalOpen } from "../utils/modalOpen";

/** Room the main chat keeps beside the panel. */
const MAIN_MIN_WIDTH = 360;
const KEY_STEP = 32;

function maxWidth(available: number): number {
  return Math.max(ASIDE_PANEL_MIN_WIDTH, available - MAIN_MIN_WIDTH);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep Tab inside `root`: from the last focusable to the first, and back. */
function trapTab(root: HTMLElement, e: React.KeyboardEvent) {
  // Not inside something switched off (inert, or hidden like the composer under a prompt).
  const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.closest('[inert], [hidden], [style*="display: none"]'));
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === root)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/** Whether an Escape inside the panel is someone else's to handle. */
function escapeIsClaimed(panel: HTMLElement, e: React.KeyboardEvent): boolean {
  if (e.defaultPrevented || isModalOpen()) return true;
  // An input method composing text (Japanese, Chinese, Korean…) uses Escape to
  // cancel the composition; that Escape is the IME's, not a request to close.
  // keyCode 229 is how some browsers report keys an IME is processing.
  if (e.nativeEvent.isComposing || e.keyCode === 229) return true;
  // An open menu (the composer's, a bubble's) closes first.
  if (panel.querySelector('[role="menu"], [role="listbox"]')) return true;
  // The quote bar dismisses a selection on Escape.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount > 0 && panel.contains(selection.getRangeAt(0).commonAncestorContainer)) return true;
  return false;
}

export default function AsidePanel({
  label,
  isMobile,
  onClose,
  getReturnFocus,
  getFallbackFocus,
  children,
}: {
  /** Accessible name — the aside's title. */
  label: string;
  isMobile: boolean;
  onClose: () => void;
  /**
   * The control that opened the panel, when the one that had focus will be
   * gone by the time it closes (a menu row): focus goes back there. Read on
   * close. Without one, focus goes back to whatever had it at open.
   */
  getReturnFocus?: () => HTMLElement | null;
  /** Where focus goes when neither the opener nor what had focus at open is still there (the main composer). */
  getFallbackFocus?: () => HTMLElement | null;
  children: ReactNode;
}) {
  // What had focus when the panel was asked for — read during the first
  // render, before any child mounts: by the time this component's own effect
  // runs, the embedded composer's (earlier) effect has already focused itself.
  const [focusAtOpen] = useState(() => {
    const active = document.activeElement;
    return active instanceof HTMLElement && active !== document.body ? active : null;
  });
  const getFallbackFocusRef = useRef(getFallbackFocus);
  getFallbackFocusRef.current = getFallbackFocus;
  const getReturnFocusRef = useRef(getReturnFocus);
  getReturnFocusRef.current = getReturnFocus;
  const panelRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => getAsidePanelWidth());
  const widthRef = useRef(width);
  widthRef.current = width;

  // Focus in on open, back out on close.
  useEffect(() => {
    // After the embedded chat's own autofocus has had its chance.
    const timer = setTimeout(() => {
      const panel = panelRef.current;
      if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
    }, 0);
    return () => {
      clearTimeout(timer);
      // Only when focus went down with the panel (it is on the body now), not
      // when the user had already moved it somewhere else in the page.
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) return;
      const target = [getReturnFocusRef.current?.(), focusAtOpen, getFallbackFocusRef.current?.()].find((el) => el?.isConnected);
      target?.focus({ preventScroll: true });
    };
  }, [focusAtOpen]);

  // The page row the panel shares with the main chat; the window where that has no layout.
  const available = () => panelRef.current?.parentElement?.getBoundingClientRect().width || window.innerWidth;
  const commit = useCallback((next: number) => {
    const clamped = Math.round(Math.max(ASIDE_PANEL_MIN_WIDTH, Math.min(next, maxWidth(available()))));
    setWidth(clamped);
    return clamped;
  }, []);

  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = widthRef.current;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const onMove = (ev: PointerEvent) => commit(startWidth + (startX - ev.clientX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      saveAsidePanelWidth(widthRef.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onSeparatorKey = (e: React.KeyboardEvent) => {
    const delta = e.key === "ArrowLeft" ? KEY_STEP : e.key === "ArrowRight" ? -KEY_STEP : 0;
    if (!delta) return;
    e.preventDefault();
    saveAsidePanelWidth(commit(widthRef.current + delta));
  };

  // A window narrowed under the panel: keep the main chat its room.
  useEffect(() => {
    if (isMobile) return;
    const onResize = () => commit(widthRef.current);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [isMobile, commit]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The mobile sheet is modal: Tab cycles inside it.
    if (e.key === "Tab" && isMobile && panelRef.current) {
      trapTab(panelRef.current, e);
      return;
    }
    if (e.key !== "Escape" || !panelRef.current || escapeIsClaimed(panelRef.current, e)) return;
    e.preventDefault();
    onClose();
  };

  return (
    <div
      ref={panelRef}
      role={isMobile ? "dialog" : "complementary"}
      aria-modal={isMobile ? true : undefined}
      // Not a modal to the rest of the page's floating UI: the quote bar
      // works inside the sheet (utils/modalOpen.ts skips this marker).
      data-aside-panel=""
      aria-label={label}
      data-testid="aside-panel"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="aside-panel"
      style={
        isMobile
          ? { position: "fixed", inset: 0, zIndex: 40, background: "var(--bg)", display: "flex", flexDirection: "column", outline: "none" }
          : {
              position: "relative",
              width,
              flexShrink: 0,
              height: "100%",
              borderLeft: "1px solid var(--border)",
              background: "var(--bg)",
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              outline: "none",
            }
      }
    >
      {!isMobile && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize aside panel"
          aria-valuenow={width}
          aria-valuemin={ASIDE_PANEL_MIN_WIDTH}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={onSeparatorKey}
          className="aside-panel-resizer"
          style={{ position: "absolute", left: -3, top: 0, bottom: 0, width: 6, cursor: "col-resize", zIndex: 5 }}
        />
      )}
      {children}
    </div>
  );
}
