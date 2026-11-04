import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { setMessageStarred } from "../api";
import type { StarredMessage } from "../utils/starredMessages";
import { flashMessage, type MessageNavigationLatch } from "./useMessageNavigation";

const NO_STARS: readonly string[] = [];

/**
 * The chat's starred message keys, and the toggle that changes one.
 *
 * The server's list arrives with the chat record (`metadata.starredMessages`),
 * which is refetched on tab resume and after every run — that is how a star
 * made in another tab shows up here. A toggle applies optimistically and is
 * then replaced by the list the server answers with, which already includes
 * anything another tab starred in the meantime.
 *
 * While a toggle is in flight a refetched record is ignored: it may have been
 * read before the write landed, and adopting it would flick the star off and
 * back on.
 */
export function useStarredMessages(chatId: string | undefined, serverStars: readonly string[] | undefined) {
  const [stars, setStars] = useState<readonly string[]>(serverStars ?? NO_STARS);
  const inFlightRef = useRef(0);
  // Which chat `stars` belongs to. Chat is not remounted on navigation, so a
  // response for the chat the user just left must not land in this one.
  const chatIdRef = useRef(chatId);

  useEffect(() => {
    chatIdRef.current = chatId;
    inFlightRef.current = 0;
  }, [chatId]);

  useEffect(() => {
    if (inFlightRef.current === 0) setStars(serverStars ?? NO_STARS);
  }, [serverStars]);

  const starredKeys = useMemo(() => new Set(stars), [stars]);

  // Stable, so the memoized bubbles are not handed a fresh closure per render.
  const toggleStar = useCallback((key: string, starred: boolean) => {
    const forChat = chatIdRef.current;
    if (!forChat) return;
    const apply = (on: boolean) => setStars((prev) => (on ? [...prev.filter((k) => k !== key), key] : prev.filter((k) => k !== key)));
    apply(starred);
    inFlightRef.current++;
    setMessageStarred(forChat, key, starred)
      .then((res) => {
        if (chatIdRef.current === forChat) setStars(res.starredMessages);
      })
      .catch((err) => {
        console.error("Failed to update starred message:", err);
        // Undo just this toggle — another one may have landed since.
        if (chatIdRef.current === forChat) apply(!starred);
      })
      .finally(() => {
        if (chatIdRef.current === forChat) inFlightRef.current = Math.max(0, inFlightRef.current - 1);
      });
  }, []);

  return { starredKeys, toggleStar };
}

/**
 * Previous/next over the starred messages. Ends do not wrap: up at the first
 * star and down at the last are disabled, matching the user-message arrows.
 *
 * "Where am I" is the last star navigated to, held by key so new messages
 * arriving (or a star being added above it) don't move it. Before the first
 * jump — or once that star is unstarred — it falls back to the scroll
 * position: up goes to the nearest star above the middle of the viewport,
 * down to the nearest below it.
 */
export function useStarredNavigation(
  starred: readonly StarredMessage[],
  containerRef: RefObject<HTMLElement | null>,
  { unlatch, suppressRelatchRef }: Pick<MessageNavigationLatch, "unlatch" | "suppressRelatchRef">,
) {
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const position = currentKey === null ? -1 : starred.findIndex((s) => s.key === currentKey);
  const current = position >= 0 ? position : null;

  const jumpTo = useCallback(
    (target: StarredMessage | undefined) => {
      if (!target) return;
      suppressRelatchRef.current = true;
      unlatch();
      setCurrentKey(target.key);
      flashMessage(containerRef.current, target.index);
    },
    [unlatch, suppressRelatchRef, containerRef],
  );

  /** Index into `starred` of the nearest star past the viewport middle, or -1. */
  const fromScroll = useCallback(
    (direction: -1 | 1): number => {
      const container = containerRef.current;
      if (!container) return -1;
      const box = container.getBoundingClientRect();
      const middle = box.top + box.height / 2;
      const centers = starred.map((s) => {
        const rect = container.querySelector(`[data-message-index="${s.index}"]`)?.getBoundingClientRect();
        return rect ? rect.top + rect.height / 2 : null;
      });
      if (direction < 0) {
        for (let i = centers.length - 1; i >= 0; i--) if (centers[i] !== null && centers[i]! < middle - 1) return i;
      } else {
        for (let i = 0; i < centers.length; i++) if (centers[i] !== null && centers[i]! > middle + 1) return i;
      }
      return -1;
    },
    [starred, containerRef],
  );

  const goPrev = useCallback(() => {
    if (starred.length === 0) return;
    if (current !== null) return jumpTo(starred[current - 1]);
    // Nothing above the viewport (or no layout to ask): start from the newest,
    // the same place the user-message arrows start.
    const i = fromScroll(-1);
    jumpTo(starred[i >= 0 ? i : starred.length - 1]);
  }, [starred, current, jumpTo, fromScroll]);

  const goNext = useCallback(() => {
    if (starred.length === 0) return;
    if (current !== null) return jumpTo(starred[current + 1]);
    const i = fromScroll(1);
    jumpTo(starred[i >= 0 ? i : 0]);
  }, [starred, current, jumpTo, fromScroll]);

  return {
    count: starred.length,
    /** 0-based position of the last star navigated to, or null before the first jump. */
    current,
    goPrev,
    goNext,
    canPrev: starred.length > 0 && (current === null || current > 0),
    canNext: starred.length > 0 && (current === null || current < starred.length - 1),
  };
}
