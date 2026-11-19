/**
 * The user's text selection in a chat transcript, when it lies within one
 * message's bubble — what the floating Quote / Ask toolbar is shown for.
 *
 * Nothing here touches the bubbles: the transcript is read through its
 * `[data-message-index]` wrappers (Chat.tsx) and the document's own
 * `Selection`, so the memoized `MessageBubble`s are never re-rendered by a
 * selection. Unrelated to `useSelectionActivation`, which is list
 * multi-select (rows, not text).
 *
 * When the selection is "settled" is the subtle part:
 *  - mouse: while the button is down the toolbar stays hidden, so it does not
 *    chase a drag; it appears on release;
 *  - touch and keyboard: `selectionchange` is the only signal (a long-press
 *    and the handles fire no pointer event we can use), so it is debounced;
 *  - a press on the toolbar itself must not count as the selection going
 *    away. On desktop the toolbar's `mousedown` is prevented and the
 *    selection survives; on touch the tap may still collapse it before the
 *    click lands, so a press inside `[data-selection-toolbar]` holds the
 *    current selection until the click has been handled.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface SelectionRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface MessageTextSelection {
  messageIndex: number;
  /** The selected text, raw — `Selection.toString()` of the part inside the bubble. */
  text: string;
  /** Viewport rect of the selection, for positioning the toolbar. */
  rect: SelectionRect;
  /**
   * The selected text is scrolled out of the transcript's viewport. The
   * selection still stands — scrolling back shows the toolbar again — but a
   * toolbar now would float over the header or the composer.
   */
  offscreen?: boolean;
}

/** Marks the toolbar's root, so pressing it does not read as the selection ending. */
export const SELECTION_TOOLBAR_ATTR = "data-selection-toolbar";

const MESSAGE_SELECTOR = "[data-message-index]";
const SETTLE_MS = 250;

/**
 * Which message a range selects text in, and that text — or null when the
 * selected text is spread over more than one message, or lies (partly)
 * outside every message.
 *
 * Judged by text, not by boundary nodes: a triple-click selection ends at
 * offset 0 of the *next* block, and so does a drag released just past the
 * end of a bubble. Neither selects any of that next message's text, so
 * neither is a cross-message selection.
 */
export function resolveMessageSelection(range: Range, container: Element): { messageIndex: number; text: string } | null {
  if (range.collapsed) return null;
  const doc = container.ownerDocument;
  const hits: { el: Element; text: string }[] = [];
  for (const el of container.querySelectorAll(MESSAGE_SELECTOR)) {
    if (!range.intersectsNode(el)) continue;
    const clipped = doc.createRange();
    clipped.selectNodeContents(el);
    if (clipped.compareBoundaryPoints(Range.START_TO_START, range) < 0) clipped.setStart(range.startContainer, range.startOffset);
    if (clipped.compareBoundaryPoints(Range.END_TO_END, range) > 0) clipped.setEnd(range.endContainer, range.endOffset);
    const text = clipped.toString();
    if (text.trim()) hits.push({ el, text });
    if (hits.length > 1) return null;
  }
  if (hits.length !== 1) return null;
  const [{ el, text }] = hits;
  // Text selected outside every bubble (an in-flight message, a notice).
  if (range.toString().replace(/\s+/g, "") !== text.replace(/\s+/g, "")) return null;
  const messageIndex = Number(el.getAttribute("data-message-index"));
  return Number.isInteger(messageIndex) ? { messageIndex, text } : null;
}

function rectOf(range: Range): SelectionRect | null {
  // jsdom has no layout, and no Range.getBoundingClientRect at all.
  if (typeof range.getBoundingClientRect !== "function") return { top: 0, bottom: 0, left: 0, right: 0 };
  const r = range.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}

interface Options {
  containerRef: RefObject<HTMLElement | null>;
  /** Whether text in the message at this transcript index may be quoted. */
  isEligible: (messageIndex: number) => boolean;
  /** Off, nothing is tracked and the result is null. */
  enabled?: boolean;
  /** A change (the chat being shown) drops the current selection's toolbar. */
  resetKey?: unknown;
}

export interface UseMessageTextSelectionResult {
  selection: MessageTextSelection | null;
  /** Hide the toolbar. With `clearDocumentSelection`, also deselect the text. */
  dismiss: (clearDocumentSelection?: boolean) => void;
}

export function useMessageTextSelection({ containerRef, isEligible, enabled = true, resetKey }: Options): UseMessageTextSelectionResult {
  const [selection, setSelection] = useState<MessageTextSelection | null>(null);
  const isEligibleRef = useRef(isEligible);
  useEffect(() => {
    isEligibleRef.current = isEligible;
  }, [isEligible]);
  const rangeRef = useRef<Range | null>(null);
  const holdRef = useRef(false);

  const dismiss = useCallback((clearDocumentSelection = false) => {
    holdRef.current = false;
    rangeRef.current = null;
    setSelection(null);
    if (clearDocumentSelection) window.getSelection()?.removeAllRanges();
  }, []);

  // A new chat (or view) drops the toolbar: adjusted during render, not in an
  // effect, so the outgoing selection's bar is never painted over the new one.
  const [shownFor, setShownFor] = useState(resetKey);
  if (shownFor !== resetKey) {
    setShownFor(resetKey);
    setSelection(null);
  }

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let mouseDown = false;

    const evaluate = () => {
      timer = null;
      const container = containerRef.current;
      const sel = window.getSelection();
      if (!container || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
        if (!holdRef.current) {
          rangeRef.current = null;
          setSelection(null);
        }
        return;
      }
      const range = sel.getRangeAt(0);
      const hit = resolveMessageSelection(range, container);
      const rect = hit && isEligibleRef.current(hit.messageIndex) ? rectOf(range) : null;
      if (!hit || !rect) {
        rangeRef.current = null;
        setSelection(null);
        return;
      }
      rangeRef.current = range.cloneRange();
      setSelection({ messageIndex: hit.messageIndex, text: hit.text, rect });
    };

    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(evaluate, ms);
    };

    const onSelectionChange = () => {
      if (holdRef.current) return;
      if (mouseDown) {
        // Mid-drag: hide, and look again on release.
        if (timer) clearTimeout(timer);
        timer = null;
        setSelection((prev) => (prev ? null : prev));
        return;
      }
      schedule(SETTLE_MS);
    };

    const inToolbar = (target: EventTarget | null) => target instanceof Element && !!target.closest(`[${SELECTION_TOOLBAR_ATTR}]`);

    const onPointerDown = (e: PointerEvent) => {
      if (inToolbar(e.target)) {
        holdRef.current = true;
        return;
      }
      holdRef.current = false;
      if (e.pointerType === "mouse" && e.button === 0) mouseDown = true;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (inToolbar(e.target) || holdRef.current) return;
      if (e.pointerType !== "mouse") return;
      mouseDown = false;
      // The selection a click collapses is updated after mouseup.
      schedule(0);
    };
    const onPointerCancel = () => {
      mouseDown = false;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    const onReposition = () => {
      const range = rangeRef.current;
      const container = containerRef.current;
      if (!range || !container) return;
      const rect = rectOf(range);
      if (!rect) return;
      const box = container.getBoundingClientRect();
      const offscreen = rect.bottom < box.top || rect.top > box.bottom;
      setSelection((prev) => (prev ? { ...prev, rect, offscreen } : prev));
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [enabled, containerRef, dismiss]);

  return { selection: enabled ? selection : null, dismiss };
}
