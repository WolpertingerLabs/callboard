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

/** Whether an Escape inside the panel is someone else's to handle. */
function escapeIsClaimed(panel: HTMLElement, e: React.KeyboardEvent): boolean {
  if (e.defaultPrevented || isModalOpen()) return true;
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
  children,
}: {
  /** Accessible name — the aside's title. */
  label: string;
  isMobile: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(() => getAsidePanelWidth());
  const widthRef = useRef(width);
  widthRef.current = width;

  // Focus in on open, back out on close.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
      if (before?.isConnected && (!active || active === document.body || !active.isConnected)) before.focus({ preventScroll: true });
    };
  }, []);

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
    if (e.key !== "Escape" || !panelRef.current || escapeIsClaimed(panelRef.current, e)) return;
    e.preventDefault();
    onClose();
  };

  return (
    <div
      ref={panelRef}
      role={isMobile ? "dialog" : "complementary"}
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
