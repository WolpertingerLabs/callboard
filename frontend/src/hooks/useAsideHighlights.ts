/**
 * Paint each aside's quoted passages in the main transcript, with the CSS
 * Custom Highlight API: `CSS.highlights` holds ranges the browser draws over
 * the text (`::highlight(aside-quote)` in index.css), so the memoized
 * bubbles' DOM is never touched. Where the API is missing it does nothing.
 *
 * Ranges point into live text nodes, so they go stale when a bubble
 * re-renders. Re-located on the next frame after the transcript changes —
 * the messages array, the asides, or any DOM change in the container (a
 * streamed reply, a lazily rendered code block) — at most once per frame.
 * The work per paint is proportional to the quoted messages, not the
 * transcript: only bubbles a quote names are read.
 *
 * `activeIds`' ranges are painted again in a second, stronger highlight: the
 * aside whose chip is hovered or focused, or the one open in the panel.
 *
 * Only one Chat instance on a page may own these names. The embedded aside
 * chat passes no asides, so it never paints (or clears) them.
 */
import { useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from "react";
import type { ParsedMessage } from "../api";
import { locateAsides, quoteCandidates, type AsideEntry, type LocatedAsides } from "../utils/asideHighlights";

export const ASIDE_HIGHLIGHT = "aside-quote";
export const ASIDE_HIGHLIGHT_ACTIVE = "aside-quote-active";

interface HighlightRegistryLike {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

function registry(): { highlights: HighlightRegistryLike; Highlight: new (...ranges: Range[]) => { priority: number } } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => { priority: number } }).Highlight;
  if (!css?.highlights || typeof Highlight !== "function") return null;
  return { highlights: css.highlights, Highlight };
}

/** Whether this browser can paint aside highlights at all. */
export function asideHighlightsSupported(): boolean {
  return registry() !== null;
}

/**
 * @returns a ref to the ranges last painted, per aside id — for hit-testing a
 * click on a highlight.
 */
export function useAsideHighlights({
  containerRef,
  messages,
  asides,
  activeIds,
  enabled,
}: {
  containerRef: RefObject<HTMLElement | null>;
  messages: readonly ParsedMessage[];
  asides: readonly AsideEntry[];
  activeIds: readonly string[];
  /** Off while the transcript is not the view on screen. */
  enabled: boolean;
}): MutableRefObject<Map<string, Range[]>> {
  const rangesRef = useRef<Map<string, Range[]>>(new Map());
  const activeRef = useRef(activeIds);
  activeRef.current = activeIds;
  const paintRef = useRef<() => void>(() => {});
  // The transcript array is replaced on every streamed refetch; what matters
  // here is only where each quote's message is. Re-locate when that moves —
  // a quoted bubble's own text changing is caught by the observer below.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const placesKey = useMemo(() => asides.map((a) => a.quotes.map((q) => quoteCandidates(messages, q).join(",")).join(";")).join("|"), [messages, asides]);

  useEffect(() => {
    const reg = registry();
    const container = containerRef.current;
    if (!reg || !enabled || !container || asides.length === 0) {
      rangesRef.current = new Map();
      return;
    }
    let frame: number | null = null;
    // What the last pass found; re-located only when a change could have moved it.
    let last: LocatedAsides | null = null;
    let relocate = true;
    const paint = () => {
      frame = null;
      if (relocate || !last) {
        last = locateAsides(container, messagesRef.current, asides);
        relocate = false;
      }
      const located = last.ranges;
      rangesRef.current = located;
      const all = [...located.values()].flat();
      if (all.length === 0) reg.highlights.delete(ASIDE_HIGHLIGHT);
      else reg.highlights.set(ASIDE_HIGHLIGHT, new reg.Highlight(...all));
      const active = activeRef.current.flatMap((id) => located.get(id) ?? []);
      if (active.length > 0) {
        const highlight = new reg.Highlight(...active);
        highlight.priority = 1;
        reg.highlights.set(ASIDE_HIGHLIGHT_ACTIVE, highlight);
      } else reg.highlights.delete(ASIDE_HIGHLIGHT_ACTIVE);
    };
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(paint);
    };
    // Emphasis changes repaint what was found, without finding it again.
    paintRef.current = schedule;
    schedule();
    // A streamed reply mutates the transcript many times a second; most of it
    // is nowhere near a quote. Re-locate only when a change is inside a
    // quoted bubble, a painted range has gone stale (its text node replaced),
    // or a quote is still missing (its bubble may just have rendered).
    const isStale = (r: Range) => !r.startContainer.isConnected || !r.endContainer.isConnected;
    const onMutations = (records: MutationRecord[]) => {
      const prev = last;
      const affected =
        !prev ||
        prev.missing ||
        [...prev.ranges.values()].some((list) => list.some(isStale)) ||
        records.some((record) => [...prev.contents].some((content) => content.contains(record.target)));
      if (!affected) return;
      relocate = true;
      schedule();
    };
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(onMutations);
    observer?.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer?.disconnect();
      paintRef.current = () => {};
      rangesRef.current = new Map();
      reg.highlights.delete(ASIDE_HIGHLIGHT);
      reg.highlights.delete(ASIDE_HIGHLIGHT_ACTIVE);
    };
  }, [containerRef, placesKey, asides, enabled]);

  // Emphasis changes repaint without re-observing.
  const activeKey = activeIds.join("\n");
  useEffect(() => {
    paintRef.current();
  }, [activeKey]);

  return rangesRef;
}

/** The aside whose painted range lies under the viewport point, if any. */
export function asideAtPoint(ranges: Map<string, Range[]>, x: number, y: number): string | null {
  for (const [chatId, list] of ranges) {
    for (const range of list) {
      if (typeof range.getClientRects !== "function") continue;
      for (const rect of range.getClientRects()) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return chatId;
      }
    }
  }
  return null;
}
