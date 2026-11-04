import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { setMessageStarred } from "../api";
import type { StarredMessage } from "../utils/starredMessages";
import { flashMessage, type MessageNavigationLatch } from "./useMessageNavigation";

/** One toggle sent to the server and not yet answered. */
interface PendingStar {
  seq: number;
  key: string;
  starred: boolean;
}

/**
 * `base` is the newest server list seen — by revision, not by arrival — and
 * `pending` the toggles still in flight, oldest first. What renders is the
 * pending toggles replayed over the base: each is idempotent, so replaying
 * one the base already reflects changes nothing.
 */
interface StarState {
  chatId: string | undefined;
  base: readonly string[];
  /** Revision of `base`. -1 until a record for this chat has been seen. */
  rev: number;
  pending: readonly PendingStar[];
}

type StarAction =
  | { type: "server"; chatId: string | undefined; keys: readonly string[]; rev: number }
  | { type: "queue"; op: PendingStar }
  | { type: "answered"; chatId: string; seq: number; keys: readonly string[]; rev: number }
  | { type: "failed"; chatId: string; seq: number };

const NO_STARS: readonly string[] = [];

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

function starReducer(state: StarState, action: StarAction): StarState {
  switch (action.type) {
    case "server":
      // A different chat starts over: nothing in flight belongs to it.
      if (action.chatId !== state.chatId) return { chatId: action.chatId, base: action.keys, rev: action.rev, pending: [] };
      // A record fetched before one of our writes landed carries an older
      // revision than that write's reply. Keeping the newer is what stops a
      // slow refetch from reverting a star.
      // The same list again (a re-parse of unchanged metadata) is no change.
      if (action.rev < state.rev || (action.rev === state.rev && sameKeys(action.keys, state.base))) return state;
      return { ...state, base: action.keys, rev: action.rev };
    case "queue":
      return { ...state, pending: [...state.pending, action.op] };
    case "answered": {
      if (action.chatId !== state.chatId) return state;
      // Requests go out in order and the server applies them in order, so this
      // reply already reflects every toggle sent before it as well.
      const pending = state.pending.filter((op) => op.seq > action.seq);
      return action.rev > state.rev ? { ...state, base: action.keys, rev: action.rev, pending } : { ...state, pending };
    }
    case "failed":
      // Drop only this toggle — the ones around it still stand.
      if (action.chatId !== state.chatId) return state;
      return { ...state, pending: state.pending.filter((op) => op.seq !== action.seq) };
  }
}

function applyPending(base: readonly string[], pending: readonly PendingStar[]): readonly string[] {
  if (pending.length === 0) return base;
  return pending.reduce<readonly string[]>((keys, op) => (op.starred ? [...keys.filter((k) => k !== op.key), op.key] : keys.filter((k) => k !== op.key)), base);
}

/**
 * The chat's starred message keys, and the toggle that changes one.
 *
 * The server's list arrives with the chat record (`metadata.starredMessages`,
 * revisioned by `starredMessagesRev`), which is refetched on tab resume and
 * after every run — that is how a star made in another tab shows up here. A
 * toggle shows at once and stays shown until its reply, whatever replies to
 * other toggles or refetched records arrive in between.
 *
 * `serverStars` is undefined while this chat's record has not loaded.
 */
export function useStarredMessages(chatId: string | undefined, serverStars: readonly string[] | undefined, serverRev: number | undefined) {
  const [state, dispatch] = useReducer(starReducer, { chatId, base: serverStars ?? NO_STARS, rev: serverStars ? (serverRev ?? 0) : -1, pending: [] });
  // Which chat a reply is for is carried in the action and checked by the
  // reducer, so a reply for the chat the user just left lands nowhere. The ref
  // only tells `toggleStar` (stable, for the memoized bubbles) the current chat.
  const chatIdRef = useRef(chatId);
  const seqRef = useRef(0);

  useEffect(() => {
    chatIdRef.current = chatId;
    dispatch({ type: "server", chatId, keys: serverStars ?? NO_STARS, rev: serverStars ? (serverRev ?? 0) : -1 });
  }, [chatId, serverStars, serverRev]);

  const stars = useMemo(() => applyPending(state.base, state.pending), [state.base, state.pending]);
  const starredKeys = useMemo(() => new Set(stars), [stars]);

  const toggleStar = useCallback((key: string, starred: boolean) => {
    const forChat = chatIdRef.current;
    if (!forChat) return;
    const seq = ++seqRef.current;
    dispatch({ type: "queue", op: { seq, key, starred } });
    setMessageStarred(forChat, key, starred)
      .then((res) => dispatch({ type: "answered", chatId: forChat, seq, keys: res.starredMessages, rev: res.starredMessagesRev ?? 0 }))
      .catch((err) => {
        console.error("Failed to update starred message:", err);
        dispatch({ type: "failed", chatId: forChat, seq });
      });
  }, []);

  return { starredKeys, toggleStar };
}

const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/**
 * Previous/next over the starred messages. Ends never wrap: there is always a
 * "from here", and an arrow with no star in its direction is disabled.
 *
 * "Here" is the last star navigated to, held by key so new messages or a star
 * added above it don't move it — until the user scrolls by hand (wheel, touch,
 * a scroll key, the scrollbar), which lets go of it. Without a remembered star
 * it is the middle of the viewport: up goes to the nearest star above it, down
 * to the nearest below. Our own smooth scrolls produce scroll events but none
 * of those inputs, which is how the two are told apart.
 *
 * With no layout to measure (a hidden or zero-height container) nothing can be
 * placed above or below, so both arrows stay live and start from the ends.
 */
export function useStarredNavigation(
  chatId: string | undefined,
  starred: readonly StarredMessage[],
  containerRef: RefObject<HTMLElement | null>,
  { unlatch, suppressRelatchRef }: Pick<MessageNavigationLatch, "unlatch" | "suppressRelatchRef">,
) {
  // Keyed by chat: a fork shares its parent's timestamps, hence its star keys.
  const [remembered, setRemembered] = useState<{ chatId: string | undefined; key: string } | null>(null);
  const currentKey = remembered && remembered.chatId === chatId ? remembered.key : null;
  const position = currentKey === null ? -1 : starred.findIndex((s) => s.key === currentKey);
  const current = position >= 0 ? position : null;

  /** Index into `starred` of the nearest star past the viewport middle, -1 for none, null with no layout. */
  const fromScroll = useCallback(
    (direction: -1 | 1): number | null => {
      const container = containerRef.current;
      if (!container) return null;
      const box = container.getBoundingClientRect();
      if (box.height === 0) return null;
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

  // What lies above and below the viewport, re-measured as it scrolls. Only
  // consulted while no star is remembered.
  const [around, setAround] = useState<{ up: number | null; down: number | null }>({ up: null, down: null });
  const measure = useCallback(() => {
    const up = fromScroll(-1);
    const down = fromScroll(1);
    setAround((prev) => (prev.up === up && prev.down === down ? prev : { up, down }));
  }, [fromScroll]);

  useEffect(() => {
    // First measurement on the next frame, once the rows it reads are laid out.
    let frame = requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
    if (starred.length === 0) return () => cancelAnimationFrame(frame);
    const inContainer = (target: EventTarget | null) => target instanceof Node && !!containerRef.current?.contains(target);
    const release = () => setRemembered(null);
    // Capture at the document, so a container remounted by a view switch is
    // still covered without re-subscribing.
    const onScroll = (e: Event) => {
      if (e.target !== containerRef.current || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const onWheel = (e: Event) => inContainer(e.target) && release();
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (!SCROLL_KEYS.has(e.key) || !target) return;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      if (target === document.body || inContainer(target)) release();
    };
    // A press on the scrollbar lands outside the client area.
    const onPointerDown = (e: PointerEvent) => {
      const container = containerRef.current;
      if (container && e.target === container && e.offsetX >= container.clientWidth) release();
    };
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("wheel", onWheel, { capture: true, passive: true });
    document.addEventListener("touchmove", onWheel, { capture: true, passive: true });
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("touchmove", onWheel, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [starred, containerRef, measure]);

  const jumpTo = useCallback(
    (target: StarredMessage | undefined) => {
      if (!target) return;
      suppressRelatchRef.current = true;
      unlatch();
      setRemembered({ chatId, key: target.key });
      flashMessage(containerRef.current, target.index);
    },
    [chatId, unlatch, suppressRelatchRef, containerRef],
  );

  const goPrev = useCallback(() => {
    if (starred.length === 0) return;
    if (current !== null) return jumpTo(starred[current - 1]);
    const i = fromScroll(-1);
    // No layout: start from the newest, as the user-message arrows do.
    jumpTo(i === null ? starred[starred.length - 1] : starred[i]);
  }, [starred, current, jumpTo, fromScroll]);

  const goNext = useCallback(() => {
    if (starred.length === 0) return;
    if (current !== null) return jumpTo(starred[current + 1]);
    const i = fromScroll(1);
    jumpTo(i === null ? starred[0] : starred[i]);
  }, [starred, current, jumpTo, fromScroll]);

  const has = starred.length > 0;
  return {
    count: starred.length,
    /** 0-based position of the star navigated to, or null when none is remembered. */
    current,
    goPrev,
    goNext,
    canPrev: has && (current !== null ? current > 0 : around.up !== -1),
    canNext: has && (current !== null ? current < starred.length - 1 : around.down !== -1),
  };
}
