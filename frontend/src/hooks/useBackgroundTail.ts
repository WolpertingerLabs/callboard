import { useCallback, useEffect, useRef, useState } from "react";
import { BackgroundTailError, getBackgroundTail, type BackgroundTailResponse } from "../api";
import { usePolling } from "./usePolling";

export const BACKGROUND_TAIL_POLL_MS = 2500;
/** Wait after the 1st, 2nd and 3rd+ consecutive failure before polling again. */
const BACKOFF_MS = [5_000, 10_000, 30_000];

interface Options {
  chatId: string;
  toolUseId: string;
  /** Poll while true (the task is still running). Turning false triggers one last fetch. */
  live: boolean;
  /** Stream to show; omitted, the first response's `defaultStream` is pinned. */
  stream?: string;
  intervalMs?: number;
}

export interface BackgroundTailState {
  data: BackgroundTailResponse | null;
  error: string | null;
  loading: boolean;
  /** The server has no tail for this call (404); polling has stopped. */
  gone: boolean;
  refresh: () => void;
}

/**
 * The live tail of a background tool call's output, polled only while the
 * caller is mounted and `live`. Mount it only while the panel is open:
 * unmounting aborts the request in flight and stops the timer.
 *
 * Polling goes through {@link usePolling}, so a hidden tab sends nothing and
 * catches up on return. Ticks never overlap; repeated failures back off; a 404
 * stops for good. Each request sends `since` for the stream on screen, and an
 * `unchanged` answer keeps the lines already shown.
 */
export function useBackgroundTail({ chatId, toolUseId, live, stream, intervalMs = BACKGROUND_TAIL_POLL_MS }: Options): BackgroundTailState {
  const [data, setData] = useState<BackgroundTailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [gone, setGone] = useState(false);
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
      const keep = prevTail && effective !== undefined && prevTail.stream === effective && !prevTail.binary ? prevTail : null;
      try {
        let res = await getBackgroundTail(chatId, toolUseId, {
          ...(effective !== undefined && { stream: effective }),
          ...(keep && { since: `${keep.size}-${keep.mtimeMs}` }),
          signal: ctrl.signal,
        });
        if (mine !== seq.current) return;
        if (res.tail?.unchanged) {
          // Same bytes as last time: keep the lines on screen.
          res = keep && keep.stream === res.tail.stream ? { ...res, tail: keep } : { ...res, tail: null };
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
    intervalMs,
    { enabled: live && !gone },
  );

  const refresh = useCallback(() => {
    retryAt.current = 0;
    void load(true);
  }, [load]);

  return { data, error, loading, gone, refresh };
}
