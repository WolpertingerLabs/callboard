import { createContext, useCallback, useSyncExternalStore } from "react";
import { getSnapshot, subscribe, type ReadAloudState, type ReadAloudStatus } from "../utils/readAloudPlayer";

/**
 * The chat view a bubble belongs to, for read aloud: the bubble's speaker
 * starts playback under it, and only that view's docked bar shows it. With
 * the aside panel open there are two chat views — and two composers — but one
 * playback, so one bar. Provided by pages/Chat.tsx; without a provider (a
 * bubble rendered on its own) it is undefined.
 */
export const ReadAloudScope = createContext<string | undefined>(undefined);

/** What a bar outside the playing scope sees. Frozen and shared, so it never changes for them. */
const IDLE: ReadAloudState = Object.freeze({ ownerId: null, status: "idle", currentTime: 0, duration: 0, rate: 1, truncated: false });

/**
 * The read-aloud playback as the docked bar of `scope` sees it: the live state
 * when the playing bubble is in that scope, else a shared idle constant. With
 * no `scope`, the live state whatever its scope.
 *
 * The bar is the only subscriber that re-renders on the 4 Hz `timeupdate`.
 */
export function useReadAloudPlayback(scope?: string): ReadAloudState {
  const select = useCallback(() => {
    const s = getSnapshot();
    return scope === undefined || s.scope === scope ? s : IDLE;
  }, [scope]);
  return useSyncExternalStore(subscribe, select, select);
}

/**
 * Just the status, for a bubble's speaker — "am I the one playing": it changes
 * a handful of times per playback, not on every `timeupdate`.
 */
export function useReadAloudStatus(ownerId: string): ReadAloudStatus {
  const select = useCallback(() => {
    const s = getSnapshot();
    return s.ownerId === ownerId ? s.status : "idle";
  }, [ownerId]);
  return useSyncExternalStore(subscribe, select, select);
}
