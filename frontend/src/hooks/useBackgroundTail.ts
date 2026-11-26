import { useCallback, useEffect, useRef, useState } from "react";
import { BackgroundTailError, getBackgroundTail, type BackgroundTailResponse } from "../api";
import { usePolling } from "./usePolling";

export const BACKGROUND_TAIL_POLL_MS = 2500;
/** Poll interval once the output has sat unchanged for {@link QUIET_AFTER_MS}. */
export const BACKGROUND_TAIL_QUIET_POLL_MS = 15_000;
/** How long the output must stay the same before polling slows down. */
const QUIET_AFTER_MS = 2 * 60_000;
/** Wait after the 1st, 2nd and 3rd+ consecutive failure before polling again. */
const BACKOFF_MS = [5_000, 10_000, 30_000];
/**
 * A 404 this soon after opening may only mean the transcript line has not
 * been written yet (the row can appear the instant the launch streams in):
 * it is retried once on the next tick before being taken as final.
 */
const EARLY_404_MS = 5_000;

interface Options {
  chatId: string;
  toolUseId: string;
  /** Poll while true. Turning false triggers one last fetch. */
  live: boolean;
  /** Stream to show; omitted, the first response's stream is pinned. */
  stream?: string;
  intervalMs?: number;
}

export interface BackgroundTailState {
  data: BackgroundTailResponse | null;
  /** The stream being fetched (the caller's pick, else the pinned default), once known. */
  stream: string | undefined;
  error: string | null;
  loading: boolean;
  /** The server has no tail for this call (404); polling has stopped. */
  gone: boolean;
  /** Fetch now, clearing any error backoff (and a 404's stop). */
  refresh: () => void;
}

/**
 * The live tail of a background tool call's output, polled only while the
 * caller is mounted and `live`. Mount it only while the panel is open:
 * unmounting aborts the request in flight and stops the timer.
 *
 * Polling goes through {@link usePolling}, so a hidden tab sends nothing and
 * catches up on return. Ticks never overlap; repeated failures back off; a
 * 404 stops; output that has not changed for a couple of minutes is polled
 * less often until it changes again. Each request sends `since` for the
 * stream on screen, and an `unchanged` answer keeps what is already shown.
 */
export function useBackgroundTail({ chatId, toolUseId, live, stream, intervalMs = BACKGROUND_TAIL_POLL_MS }: Options): BackgroundTailState {
  const [data, setData] = useState<BackgroundTailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [gone, setGone] = useState(false);
  const [quiet, setQuiet] = useState(false);
  // The server's first pick, kept so the view doesn't hop between streams as
  // each is written to in turn.
  const [pinned, setPinned] = useState<string | undefined>(undefined);
  const effective = stream ?? pinned;

  const dataRef = useRef<BackgroundTailResponse | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const failures = useRef(0);
  const retryAt = useRef(0);
  const goneRef = useRef(false);
  const pinnedRef = useRef<string | undefined>(undefined);
  const mountedAt = useRef(0);
  const retried404 = useRef(false);
  const lastChange = useRef(0);
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
    if (mountedAt.current === 0) mountedAt.current = Date.now();
  });

  const load = useCallback(
    async (force = false) => {
      if (goneRef.current) return;
      if (inFlight.current) {
        if (!force) return;
        inFlight.current.abort();
      }
      const ctrl = new AbortController();
      inFlight.current = ctrl;
      const mine = ++seq.current;
      const prevTail = dataRef.current?.tail ?? null;
      const keep = prevTail && effective !== undefined && prevTail.stream === effective ? prevTail : null;
      try {
        let res = await getBackgroundTail(chatId, toolUseId, {
          ...(effective !== undefined && { stream: effective }),
          ...(keep && { since: `${keep.size}-${keep.mtimeMs}` }),
          signal: ctrl.signal,
        });
        if (mine !== seq.current) return;
        const now = Date.now();
        if (res.tail?.unchanged) {
          // Same bytes as last time: keep what is on screen (lines, or the binary notice).
          res = keep && keep.stream === res.tail.stream ? { ...res, tail: keep } : { ...res, tail: null };
          if (lastChange.current === 0) lastChange.current = now;
          if (now - lastChange.current >= QUIET_AFTER_MS) setQuiet(true);
        } else {
          lastChange.current = now;
          setQuiet(false);
        }
        dataRef.current = res;
        setData(res);
        setError(null);
        failures.current = 0;
        retryAt.current = 0;
        if (pinnedRef.current === undefined && res.tail) {
          pinnedRef.current = res.tail.stream;
          setPinned(res.tail.stream);
        }
      } catch (err) {
        if (mine !== seq.current || ctrl.signal.aborted) return;
        if (err instanceof BackgroundTailError && err.status === 404) {
          if (!retried404.current && liveRef.current && Date.now() - mountedAt.current < EARLY_404_MS) {
            retried404.current = true;
            return; // the next tick asks again
          }
          goneRef.current = true;
          setGone(true);
          setError(err.message);
          return;
        }
        failures.current++;
        retryAt.current = Date.now() + BACKOFF_MS[Math.min(failures.current, BACKOFF_MS.length) - 1];
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (inFlight.current === ctrl) inFlight.current = null;
        if (mine === seq.current) setLoading(false);
      }
    },
    [chatId, toolUseId, effective],
  );

  // First fetch, and again whenever the stream changes — unless the answer
  // already on screen is for that stream (the default being pinned).
  useEffect(() => {
    if (effective !== undefined && dataRef.current?.tail?.stream === effective) return;
    lastChange.current = 0;
    setQuiet(false);
    void load(true);
  }, [load, effective]);

  useEffect(
    () => () => {
      seq.current++;
      inFlight.current?.abort();
      inFlight.current = null;
    },
    [],
  );

  // One last read once the task finishes, so the panel ends on the final output.
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) void load(true);
    wasLive.current = live;
  }, [live, load]);

  usePolling(
    () => {
      if (Date.now() < retryAt.current) return;
      void load();
    },
    quiet ? Math.max(intervalMs, BACKGROUND_TAIL_QUIET_POLL_MS) : intervalMs,
    { enabled: live && !gone },
  );

  const refresh = useCallback(() => {
    retryAt.current = 0;
    failures.current = 0;
    goneRef.current = false;
    setGone(false);
    void load(true);
  }, [load]);

  return { data, stream: effective, error, loading, gone, refresh };
}
