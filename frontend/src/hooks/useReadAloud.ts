import { useCallback, useSyncExternalStore } from "react";
import { getSnapshot, subscribe, type ReadAloudState, type ReadAloudStatus } from "../utils/readAloudPlayer";

/** What every bubble but the playing one sees: one shared object, so nothing changes for them. */
const IDLE: ReadAloudState = Object.freeze({ ownerId: null, status: "idle", currentTime: 0, duration: 0, rate: 1, truncated: false });

/**
 * The read-aloud playback, as `ownerId` sees it: the live state when it is
 * the bubble playing, else a shared idle constant. `useSyncExternalStore`
 * skips a render when the selected value is unchanged, so the 4 Hz
 * `timeupdate` re-renders the owner's player and nothing else.
 */
export function useReadAloud(ownerId: string): ReadAloudState {
  const select = useCallback(() => {
    const s = getSnapshot();
    return s.ownerId === ownerId ? s : IDLE;
  }, [ownerId]);
  return useSyncExternalStore(subscribe, select, select);
}

/**
 * Just the status, for the speaker button: it changes a handful of times per
 * playback, not on every `timeupdate`.
 */
export function useReadAloudStatus(ownerId: string): ReadAloudStatus {
  const select = useCallback(() => {
    const s = getSnapshot();
    return s.ownerId === ownerId ? s.status : "idle";
  }, [ownerId]);
  return useSyncExternalStore(subscribe, select, select);
}
