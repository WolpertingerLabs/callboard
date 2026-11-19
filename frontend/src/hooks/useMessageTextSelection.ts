/**
 * The user's text selection in a chat transcript, when it lies within one
 * message's quotable content — what the floating Quote / Ask toolbar is
 * shown for.
 *
 * The transcript is read through its `[data-message-index]` wrappers
 * (Chat.tsx), the `[data-quote-content]` element MessageBubble puts round a
 * message's rendered body, and the document's own `Selection`. Clipping to
 * the content element is what keeps the bubble's chrome — the relative time,
 * model and timing line under it, the fork marker, open copy / fork menus —
 * out of a quote when a drag or a triple-click runs past the body's end.
 * Unrelated to `useSelectionActivation`, which is list multi-select.
 *
 * When the selection is "settled" is the subtle part:
 *  - mouse: while the button is down the toolbar stays hidden, so it does not
 *    chase a drag; it appears on release;
 *  - touch and keyboard: `selectionchange` is the only signal (a long-press
 *    and the handles fire no pointer event we can use), so it is debounced;
 *  - a tap on a toolbar button on a touch screen may collapse the selection
 *    before its click lands, so a touch/pen press on one holds the current
 *    selection until shortly after the finger lifts. On desktop the
 *    toolbar's `mousedown` is prevented and the selection simply survives.
 *
 * A selection dismissed with Escape stays dismissed until it changes. An
 * Escape another listener has claimed (`preventDefault`) leaves it alone.
 *
 * Callers should keep this hook in a small component of its own: the result
 * changes on every (frame-throttled) scroll while a selection is shown.
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { QuoteOrigin } from "../utils/messageQuotes";

export interface SelectionRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface MessageTextSelection {
  messageIndex: number;
  /** Timestamp and role of the message, captured when the text was selected. */
  origin: QuoteOrigin;
  /** The selected text, raw — `Selection.toString()` of the part inside the message's content. */
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
/** Marks the element holding a message's quotable text (MessageBubble). */
export const QUOTE_CONTENT_ATTR = "data-quote-content";

const MESSAGE_SELECTOR = "[data-message-index]";
const CONTENT_SELECTOR = `[${QUOTE_CONTENT_ATTR}]`;
const SETTLE_MS = 250;
/** How long a touch press on the toolbar holds the selection after the finger lifts — the click comes in between. */
const TOUCH_HOLD_MS = 400;

function contentOf(node: Node, container: Element): Element | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const content = el?.closest(CONTENT_SELECTOR) ?? null;
  return content && container.contains(content) ? content : null;
}

function messageIndexOf(content: Element): number | null {
  const wrapper = content.closest(MESSAGE_SELECTOR);
  if (!wrapper) return null;
  const index = Number(wrapper.getAttribute("data-message-index"));
  return Number.isInteger(index) ? index : null;
}

/** The part of `range` inside `el`, as text. */
function clippedText(range: Range, el: Element): string {
  const clipped = el.ownerDocument.createRange();
  clipped.selectNodeContents(el);
  if (clipped.compareBoundaryPoints(Range.START_TO_START, range) < 0) clipped.setStart(range.startContainer, range.startOffset);
  if (clipped.compareBoundaryPoints(Range.END_TO_END, range) > 0) clipped.setEnd(range.endContainer, range.endOffset);
  return clipped.toString();
}

/**
 * Which message a range selects text in, and that text (only the part inside
 * the message's quotable content) — or null when the selected text is spread
 * over more than one message, or touches no message's content at all.
 *
 * The usual case — both ends in the same content element — is two `closest`
 * lookups. Only when the ends lie elsewhere is every content element the
 * range crosses looked at, and then judged by text, not boundary nodes: a
 * triple-click ends at offset 0 of the *next* block, a drag released past a
 * bubble ends in its metadata line. Neither selects text of another message,
 * so neither is a cross-message selection.
 */
export function resolveMessageSelection(range: Range, container: Element): { messageIndex: number; text: string } | null {
  if (range.collapsed) return null;
  const start = contentOf(range.startContainer, container);
  if (start && start === contentOf(range.endContainer, container)) {
    const messageIndex = messageIndexOf(start);
    const text = range.toString();
    return messageIndex !== null && text.trim() ? { messageIndex, text } : null;
  }
  let hit: { el: Element; text: string } | null = null;
  for (const el of container.querySelectorAll(CONTENT_SELECTOR)) {
    if (!range.intersectsNode(el)) continue;
    const text = clippedText(range, el);
    if (!text.trim()) continue;
    if (hit) return null;
    hit = { el, text };
  }
  if (!hit) return null;
  const messageIndex = messageIndexOf(hit.el);
  return messageIndex !== null ? { messageIndex, text: hit.text } : null;
}

function rectOf(range: Range): SelectionRect {
  // jsdom has no layout, and no Range.getBoundingClientRect at all.
  if (typeof range.getBoundingClientRect !== "function") return { top: 0, bottom: 0, left: 0, right: 0 };
  const r = range.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
}

const sameRect = (a: SelectionRect, b: SelectionRect) => a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right;

function sameRange(a: Range, b: Range): boolean {
  try {
    return a.compareBoundaryPoints(Range.START_TO_START, b) === 0 && a.compareBoundaryPoints(Range.END_TO_END, b) === 0;
  } catch {
    return false; // different roots
  }
}

interface Options {
  containerRef: RefObject<HTMLElement | null>;
  /**
   * The message at this transcript index's origin, or null when its text may
   * not be quoted. Read when a selection settles, and kept on the result.
   */
  originOf: (messageIndex: number) => QuoteOrigin | null;
  /** Off, nothing is tracked and the result is null. */
  enabled?: boolean;
  /** A change (the chat or view being shown) drops the current selection's toolbar. */
  resetKey?: unknown;
}

export interface UseMessageTextSelectionResult {
  selection: MessageTextSelection | null;
  /** Hide the toolbar. With `clearDocumentSelection`, also deselect the text. */
  dismiss: (clearDocumentSelection?: boolean) => void;
}

export function useMessageTextSelection({ containerRef, originOf, enabled = true, resetKey }: Options): UseMessageTextSelectionResult {
  const [selection, setSelection] = useState<MessageTextSelection | null>(null);
  const originOfRef = useRef(originOf);
  useEffect(() => {
    originOfRef.current = originOf;
  }, [originOf]);
  /** The range the toolbar is shown for, to re-measure on scroll. */
  const rangeRef = useRef<Range | null>(null);
  /** A touch press on a toolbar button is in progress: selection changes are ignored. */
  const holdRef = useRef(false);
  /** The range Escape dismissed: no toolbar for it until the selection changes. */
  const dismissedRef = useRef<Range | null>(null);

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
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let frame: number | null = null;
    let mouseDown = false;

    const hide = () => {
      rangeRef.current = null;
      setSelection((prev) => (prev ? null : prev));
    };

    const evaluate = () => {
      timer = null;
      if (holdRef.current) return;
      const container = containerRef.current;
      const sel = window.getSelection();
      if (!container || !sel || sel.rangeCount === 0 || sel.isCollapsed) {
        dismissedRef.current = null;
        hide();
        return;
      }
      const range = sel.getRangeAt(0);
      if (dismissedRef.current) {
        if (sameRange(dismissedRef.current, range)) return;
        dismissedRef.current = null;
      }
      const hit = resolveMessageSelection(range, container);
      const origin = hit ? originOfRef.current(hit.messageIndex) : null;
      if (!hit || !origin) {
        hide();
        return;
      }
      rangeRef.current = range.cloneRange();
      setSelection({ messageIndex: hit.messageIndex, origin, text: hit.text, rect: rectOf(range) });
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
        hide();
        return;
      }
      schedule(SETTLE_MS);
    };

    const toolbarButton = (target: EventTarget | null) =>
      target instanceof Element && target.closest(`[${SELECTION_TOOLBAR_ATTR}]`) ? target.closest("button") : null;

    const releaseHold = () => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
      if (!holdRef.current) return;
      holdRef.current = false;
      // Whatever the tap did to the selection, look at it now.
      schedule(0);
    };

    const onPointerDown = (e: PointerEvent) => {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
      if (toolbarButton(e.target)) {
        // Only a finger or pen tap can collapse the selection before the click.
        holdRef.current = e.pointerType === "touch" || e.pointerType === "pen";
        return;
      }
      holdRef.current = false;
      if (e.pointerType === "mouse" && e.button === 0) mouseDown = true;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (holdRef.current) {
        if (holdTimer) clearTimeout(holdTimer);
        holdTimer = setTimeout(releaseHold, TOUCH_HOLD_MS);
        return;
      }
      if (e.pointerType !== "mouse" || !mouseDown) return;
      mouseDown = false;
      // The selection a click collapses is updated after mouseup.
      schedule(0);
    };
    const onPointerCancel = () => {
      // A touch that became a scroll, or a drag the browser took over.
      mouseDown = false;
      releaseHold();
    };
    const onBlur = () => {
      mouseDown = false;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !rangeRef.current) return;
      // Looked at once the event has been through every listener: an Escape
      // that closed something else (a bubble's copy menu, a popup menu) is
      // that thing's, and listeners added after this one run after it.
      setTimeout(() => {
        if (e.defaultPrevented || !rangeRef.current) return;
        dismissedRef.current = rangeRef.current;
        dismiss();
      }, 0);
    };
    const reposition = () => {
      frame = null;
      const range = rangeRef.current;
      const container = containerRef.current;
      if (!range || !container) return;
      const rect = rectOf(range);
      const box = container.getBoundingClientRect();
      const offscreen = rect.bottom < box.top || rect.top > box.bottom;
      setSelection((prev) => (!prev || (sameRect(prev.rect, rect) && !!prev.offscreen === offscreen) ? prev : { ...prev, rect, offscreen }));
    };
    const onReposition = () => {
      if (!rangeRef.current || frame !== null) return;
      frame = requestAnimationFrame(reposition);
    };

    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      if (timer) clearTimeout(timer);
      if (holdTimer) clearTimeout(holdTimer);
      if (frame !== null) cancelAnimationFrame(frame);
      holdRef.current = false;
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerCancel, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [enabled, containerRef, dismiss]);

  return { selection: enabled ? selection : null, dismiss };
}
