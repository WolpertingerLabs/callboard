import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type RefObject } from "react";
import { setMessageStarred } from "../api";
import { sameStarred, type StarredMessage } from "../utils/starredMessages";
import { flashMessage, type MessageNavigationLatch } from "./useMessageNavigation";

/** One toggle sent to the server and not yet answered. */
interface PendingStar {
  seq: number;
  key: string;
  starred: boolean;
}

/**
 * How long after this tab's last reply a refetched record with an older
 * revision is still taken for one fetched before that write landed. Past it,
 * an older revision means the record itself went back — hand-edited, or
 * recreated from older metadata — and is the truth to adopt.
 */
const STALE_RECORD_WINDOW_MS = 10_000;

/**
 * `base` is the server list to render from and `pending` the toggles still in
 * flight, oldest first. What renders is the pending toggles replayed over the
 * base: each is idempotent, so replaying one the base already reflects
 * changes nothing.
 */
interface StarState {
  chatId: string | undefined;
  base: readonly string[];
  /** Revision of `base`. -1 until a record for this chat has been seen. */
  rev: number;
  pending: readonly PendingStar[];
  /** Highest request seq answered, and when — replies are ordered by it. */
  answeredSeq: number;
  answeredAt: number;
  /** Highest request seq queued. */
  sentSeq: number;
  /** The last refetched record adopted: its revision, and `sentSeq` when it arrived. */
  refetch: { rev: number; afterSeq: number } | null;
}

type StarAction =
  | { type: "server"; chatId: string | undefined; keys: readonly string[]; rev: number; now: number }
  | { type: "queue"; op: PendingStar }
  | { type: "answered"; chatId: string; seq: number; keys: readonly string[]; rev: number; now: number }
  | { type: "failed"; chatId: string; seq: number };

const NO_STARS: readonly string[] = [];

const sameKeys = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((k, i) => k === b[i]);

const freshState = (chatId: string | undefined, keys: readonly string[], rev: number): StarState => ({
  chatId,
  base: keys,
  rev,
  pending: [],
  answeredSeq: 0,
  answeredAt: -Infinity,
  sentSeq: 0,
  refetch: null,
});

export function starReducer(state: StarState, action: StarAction): StarState {
  switch (action.type) {
    case "server": {
      // A different chat starts over: nothing in flight belongs to it.
      if (action.chatId !== state.chatId) return freshState(action.chatId, action.keys, action.rev);
      // The same list again (a re-parse of unchanged metadata) is no change.
      if (action.rev === state.rev && sameKeys(action.keys, state.base)) return state;
      if (action.rev < state.rev) {
        // An older revision just after our own write is a record fetched before
        // that write landed; adopting it would revert the star. Otherwise the
        // revision really went backwards, and refusing it would freeze this
        // tab on its own list for good.
        const justWrote = state.pending.length > 0 || action.now - state.answeredAt < STALE_RECORD_WINDOW_MS;
        if (justWrote || action.rev < 0) return state;
      }
      return { ...state, base: action.keys, rev: action.rev, refetch: { rev: action.rev, afterSeq: state.sentSeq } };
    }
    case "queue":
      return { ...state, pending: [...state.pending, action.op], sentSeq: action.op.seq };
    case "answered": {
      if (action.chatId !== state.chatId) return state;
      // Requests go out in order and the server applies them in order, so this
      // reply already reflects every toggle sent before it as well — and a
      // reply to an earlier request arriving after it is older news.
      const pending = state.pending.filter((op) => op.seq > action.seq);
      if (action.seq < state.answeredSeq) return { ...state, pending };
      // A record refetched after this request went out, at a higher revision,
      // already reflects it and whatever happened since — another tab's star,
      // say. The reply is older news. (A lower revision there is the record
      // being reset, and the reply wins as usual.)
      if (state.refetch && action.seq <= state.refetch.afterSeq && action.rev < state.refetch.rev) {
        return { ...state, pending, answeredSeq: action.seq, answeredAt: action.now };
      }
      return { ...state, base: action.keys, rev: action.rev, pending, answeredSeq: action.seq, answeredAt: action.now };
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
  const [state, dispatch] = useReducer(starReducer, freshState(chatId, serverStars ?? NO_STARS, serverStars ? (serverRev ?? 0) : -1));
  // Which chat a reply is for is carried in the action and checked by the
  // reducer, so a reply for the chat the user just left lands nowhere. The ref
  // only tells `toggleStar` (stable, for the memoized bubbles) the current chat.
  const chatIdRef = useRef(chatId);
  const seqRef = useRef(0);

  // A chat switch starts over during render, as the navigator's position
  // does, so a fork (which shares its parent's star keys) never paints the
  // parent's stars for a frame. `now` is unused on that path.
  if (state.chatId !== chatId) {
    dispatch({ type: "server", chatId, keys: serverStars ?? NO_STARS, rev: serverStars ? (serverRev ?? 0) : -1, now: 0 });
  }

  useEffect(() => {
    chatIdRef.current = chatId;
    dispatch({ type: "server", chatId, keys: serverStars ?? NO_STARS, rev: serverStars ? (serverRev ?? 0) : -1, now: Date.now() });
  }, [chatId, serverStars, serverRev]);

  const forThisChat = state.chatId === chatId;
  const stars = useMemo(() => (forThisChat ? applyPending(state.base, state.pending) : NO_STARS), [forThisChat, state.base, state.pending]);
  const starredKeys = useMemo(() => new Set(stars), [stars]);

  const toggleStar = useCallback((key: string, starred: boolean) => {
    const forChat = chatIdRef.current;
    if (!forChat) return;
    const seq = ++seqRef.current;
    dispatch({ type: "queue", op: { seq, key, starred } });
    setMessageStarred(forChat, key, starred)
      .then((res) => dispatch({ type: "answered", chatId: forChat, seq, keys: res.starredMessages, rev: res.starredMessagesRev ?? 0, now: Date.now() }))
      .catch((err) => {
        console.error("Failed to update starred message:", err);
        dispatch({ type: "failed", chatId: forChat, seq });
      });
  }, []);

  return { starredKeys, toggleStar };
}

/**
 * `starred`, keeping the previous array while its contents are unchanged. The
 * transcript is refetched on every stream frame during a run, which rebuilds
 * the list each time; the navigator's listeners and measurements key on it.
 */
export function useStableStarred(starred: readonly StarredMessage[]): readonly StarredMessage[] {
  const [stable, setStable] = useState(starred);
  if (stable === starred || sameStarred(stable, starred)) return stable;
  setStable(starred);
  return starred;
}

/**
 * How far outside the viewport (as a fraction of its height) the remembered
 * star may drift before it stops being "here".
 */
const NEAR_VIEWPORT = 0.5;
/** How long a jump has to bring its target near the viewport before the out-of-view rule applies to it. */
const ARRIVAL_GRACE_MS = 1500;

/**
 * Previous/next over the starred messages. Ends never wrap: there is always a
 * "from here", and an arrow with no star in its direction is disabled.
 *
 * "Here" is the last star navigated to, held by key so new messages or a star
 * added above it don't move it — but only while it is still near the viewport.
 * Whatever moves the transcript away from it lets go of it: the jump-to-bottom
 * and jump-to-top buttons, the user-message arrows, auto-scroll following a
 * run, a chat restored at the bottom. That is checked on every scroll, resize
 * and click in the transcript rather than by listing scroll sources, which is
 * the only way the list stays complete — a hand scroll is one more source, by
 * wheel, touch, keys or any kind of scrollbar. A chat switch always lets go: a
 * fork shares its parent's timestamps, hence its star keys. Without a remembered star
 * it is the middle of the viewport: up goes to the nearest star above it, down
 * to the nearest below. A jump's own smooth scroll starts with its target out
 * of view, so the out-of-view rule waits until the target has arrived (or
 * {@link ARRIVAL_GRACE_MS} has passed).
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
  const [remembered, setRemembered] = useState<string | null>(null);
  // Forgotten on a chat switch, during render so the old label never shows.
  const [navChatId, setNavChatId] = useState(chatId);
  if (navChatId !== chatId) {
    setNavChatId(chatId);
    setRemembered(null);
  }
  const currentKey = navChatId === chatId ? remembered : null;
  // The measuring side of `remembered`: whether its jump has arrived yet.
  const rememberedRef = useRef<{ key: string; at: number; arrived: boolean } | null>(null);
  useEffect(() => {
    rememberedRef.current = null;
  }, [chatId]);
  const release = useCallback(() => {
    rememberedRef.current = null;
    setRemembered(null);
  }, []);

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

    // Is the remembered star still "here"?
    const mark = rememberedRef.current;
    const container = containerRef.current;
    if (!mark || !container) return;
    const box = container.getBoundingClientRect();
    if (box.height === 0) return;
    const target = starred.find((s) => s.key === mark.key);
    const rect = target && container.querySelector(`[data-message-index="${target.index}"]`)?.getBoundingClientRect();
    if (!rect) return;
    const margin = box.height * NEAR_VIEWPORT;
    const near = rect.top + rect.height > box.top - margin && rect.top < box.top + box.height + margin;
    if (near) mark.arrived = true;
    else if (mark.arrived || Date.now() - mark.at > ARRIVAL_GRACE_MS) release();
  }, [fromScroll, starred, containerRef, release]);

  useEffect(() => {
    // First measurement on the next frame, once the rows it reads are laid out.
    let frame = requestAnimationFrame(() => {
      frame = 0;
      measure();
    });
    if (starred.length === 0) return () => cancelAnimationFrame(frame);
    const inContainer = (target: EventTarget | null) => target instanceof Node && !!containerRef.current?.contains(target);
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    // Layout shifts without a scroll: expanding a tool call or a thinking
    // block (a click in the transcript), or the viewport itself resizing.
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    let observed: HTMLElement | null = null;
    const watch = (el: HTMLElement | null) => {
      if (!resize || el === observed) return;
      if (observed) resize.unobserve(observed);
      if (el) resize.observe(el);
      observed = el;
    };
    watch(containerRef.current);
    // Capture at the document, so a container remounted by a view switch is
    // still covered without re-subscribing — and is the one the resize
    // observer moves to, rather than the detached node it started on.
    const onScroll = (e: Event) => {
      if (e.target !== containerRef.current) return;
      watch(containerRef.current);
      schedule();
    };
    const onClick = (e: Event) => {
      if (!inContainer(e.target)) return;
      watch(containerRef.current);
      schedule();
    };
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("click", onClick, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize?.disconnect();
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [starred, containerRef, measure]);

  const jumpTo = useCallback(
    (target: StarredMessage | undefined) => {
      if (!target) return;
      suppressRelatchRef.current = true;
      unlatch();
      rememberedRef.current = { key: target.key, at: Date.now(), arrived: false };
      setRemembered(target.key);
      flashMessage(containerRef.current, target.index);
    },
    [unlatch, suppressRelatchRef, containerRef],
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
