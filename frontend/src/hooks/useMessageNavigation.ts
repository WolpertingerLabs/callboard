import { useCallback, useEffect, useMemo, useState, type MutableRefObject, type RefObject } from "react";
import type { ParsedMessage } from "shared/types/index.js";
import { findLatestTaskListIndex } from "../utils/taskListNav";

/** How long a jumped-to message keeps its highlight. */
const FLASH_MS = 2000;

/**
 * Scroll the transcript row for message `index` into view and outline it
 * briefly. Looks inside `container` only: the rows are rendered there, and
 * nowhere else carries `data-message-index`. Returns whether a row was found.
 */
export function flashMessage(container: HTMLElement | null, index: number): boolean {
  const el = container?.querySelector<HTMLElement>(`[data-message-index="${index}"]`);
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.style.outline = "2px solid var(--accent)";
  el.style.borderRadius = "8px";
  setTimeout(() => {
    el.style.outline = "";
    el.style.borderRadius = "";
  }, FLASH_MS);
  return true;
}

export interface MessageNavigationLatch {
  /** Latch auto-scroll to the bottom now. */
  latchNow: () => void;
  /** Release the latch, so the pin loop stops following. */
  unlatch: () => void;
  /** Keeps a programmatic scroll away from the bottom from re-latching on its way out. */
  suppressRelatchRef: MutableRefObject<boolean>;
}

/**
 * The transcript's jump controls: previous/next user message, top, bottom and
 * the latest task list. Every jump away from the bottom unlatches auto-scroll
 * and suppresses the re-latch its own smooth scroll would otherwise trigger.
 */
export function useMessageNavigation(
  messages: ParsedMessage[],
  containerRef: RefObject<HTMLElement | null>,
  { latchNow, unlatch, suppressRelatchRef }: MessageNavigationLatch,
) {
  // Compute indices of user text messages for navigation
  const userMessageIndices = useMemo(() => {
    const indices: number[] = [];
    messages.forEach((msg, i) => {
      if (msg.role === "user" && msg.type === "text") {
        indices.push(i);
      }
    });
    return indices;
  }, [messages]);

  // Track which user message we're currently navigated to
  const [userMsgNavIndex, setUserMsgNavIndex] = useState<number | null>(null);

  // Reset user message nav when messages change (new messages arrive)
  useEffect(() => {
    setUserMsgNavIndex(null);
  }, [messages.length]);

  // Navigate to previous (older) user message
  const navigatePrevUserMessage = useCallback(() => {
    if (userMessageIndices.length === 0) return;
    suppressRelatchRef.current = true;
    unlatch();
    const newNavIndex = userMsgNavIndex === null ? userMessageIndices.length - 1 : Math.max(0, userMsgNavIndex - 1);
    setUserMsgNavIndex(newNavIndex);
    flashMessage(containerRef.current, userMessageIndices[newNavIndex]);
  }, [userMessageIndices, userMsgNavIndex, unlatch, suppressRelatchRef, containerRef]);

  // Navigate to next (newer) user message
  const navigateNextUserMessage = useCallback(() => {
    if (userMessageIndices.length === 0 || userMsgNavIndex === null) return;
    const newNavIndex = userMsgNavIndex + 1;
    if (newNavIndex >= userMessageIndices.length) {
      // Past the last user message — go to bottom and re-latch
      setUserMsgNavIndex(null);
      suppressRelatchRef.current = false;
      latchNow();
      return;
    }
    suppressRelatchRef.current = true;
    setUserMsgNavIndex(newNavIndex);
    flashMessage(containerRef.current, userMessageIndices[newNavIndex]);
  }, [userMessageIndices, userMsgNavIndex, latchNow, suppressRelatchRef, containerRef]);

  // Scroll to top of chat
  const scrollToTop = useCallback(() => {
    suppressRelatchRef.current = true;
    unlatch();
    containerRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [unlatch, suppressRelatchRef, containerRef]);

  // Scroll to bottom of chat — re-latching hands off to the pin loop
  const scrollToBottom = useCallback(() => {
    suppressRelatchRef.current = false;
    latchNow();
  }, [latchNow, suppressRelatchRef]);

  // The newest task list in the conversation, from whichever engine ran it —
  // one scan answering both "is there a button?" and "where does it go?", so the
  // two can't disagree.
  const latestTodoIndex = useMemo(() => findLatestTaskListIndex(messages), [messages]);
  const hasTodoList = latestTodoIndex >= 0;

  const handleTodoListClick = useCallback(() => {
    if (latestTodoIndex < 0) return;
    // Scroll to the todo list — unlatch so auto-scroll doesn't yank the
    // user back to the bottom while they're looking at it. A row that isn't
    // on screen leaves the latch alone. (Same task as the scroll call, so the
    // smooth scroll's events, which come on a later frame, see both.)
    if (!flashMessage(containerRef.current, latestTodoIndex)) return;
    suppressRelatchRef.current = true;
    unlatch();
  }, [latestTodoIndex, unlatch, suppressRelatchRef, containerRef]);

  return {
    userMessageIndices,
    userMsgNavIndex,
    navigatePrevUserMessage,
    navigateNextUserMessage,
    scrollToTop,
    scrollToBottom,
    hasTodoList,
    handleTodoListClick,
  };
}
