import { useCallback, useEffect, useRef, useState } from "react";
import { usePolling } from "../../hooks/usePolling";
import { errorMessage } from "../../utils/errorMessage";
import { startTimedRequest, type TimedRequest } from "./timedRequest";

/**
 * The last answer this tab holds per request, so a view that remounts (the
 * Git page reopened, the PRs tab switched back to) paints what it showed last
 * instead of "Loading…". Module-level: it lives as long as the tab does.
 * Bounded, oldest out first — the PRs tab adds a key per chat visited.
 */
const CACHE_LIMIT = 32;
const cache = new Map<string, unknown>();

function remember(key: string, value: unknown): void {
  // Delete first so a key written again moves to the young end.
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
}

/** Forget every remembered answer (tests). */
export function clearGitRequestCache(): void {
  cache.clear();
}

interface UseGitRequestOptions<T> {
  /**
   * What the request is of — everything `fetch` closes over. It must not
   * change while the view is mounted (key the component on it, as ChatGitView
   * keys ChatPrsView): an answer is remembered under the key the view mounted
   * with.
   */
  cacheKey: string;
  /** `refresh` asks the daemon to refetch PR data rather than serve its cache. */
  fetch: (refresh: boolean, signal: AbortSignal) => Promise<T>;
  /** Shown when a request is given up after PR_REQUEST_TIMEOUT_MS. */
  timeoutMessage: string;
  /** Shown when a request fails with nothing better to say. */
  failureMessage: string;
}

interface GitRequest<T> {
  /** The newest answer, or the remembered one until it arrives; null before either. */
  data: T | null;
  error: string | null;
  /** A forced refresh (the mount's included) is in flight: the button is busy. */
  refreshing: boolean;
  /** A clock for "updated Xs ago", ticked every 10s and whenever a request settles. */
  now: number;
  /** The refresh button: a forced request. */
  refresh: () => void;
  /**
   * Something the answer depends on changed: ask again, unforced. Runs after a
   * refresh already in flight rather than under it.
   */
  reload: () => void;
}

/**
 * The request machinery the Git page and a chat's PRs tab share: one endpoint,
 * asked on mount, polled every minute, and re-asked on demand.
 *
 * The daemon answers an unforced request from its PR cache at once and a forced
 * one only after `gh` (seconds). So a mount asks twice, in order: unforced,
 * which paints, then forced, which makes the data as fresh as a click on the
 * refresh button would. In order rather than together because the unforced
 * answer is the one the first paint waits on and should not share the daemon
 * with the other; and nothing is fetched twice for it — when the daemon's
 * cache is cold the unforced request does the fetch and the forced one, coming
 * within 10s, reuses it; when it is stale the unforced one starts a background
 * fetch that the forced one joins.
 *
 * What it guarantees:
 * - Only the newest request may land: a slow poll (or the mount's unforced
 *   request) cannot overwrite a refresh started after it.
 * - Nothing unforced starts while a refresh is in flight, so nothing can
 *   supersede it: polls skip, and `reload` waits for it to settle.
 * - Only the newest refresh re-enables the button; a poll never does.
 * - Every request times out, so the button cannot stay disabled forever.
 * - Unmounting aborts what is in flight, and nothing that settles later lands.
 */
export function useGitRequest<T>({ cacheKey, fetch, timeoutMessage, failureMessage }: UseGitRequestOptions<T>): GitRequest<T> {
  const [data, setData] = useState<T | null>(() => (cache.get(cacheKey) as T | undefined) ?? null);
  const [error, setError] = useState<string | null>(null);
  // The mount's requests end in a forced one, so the button starts disabled.
  const [refreshing, setRefreshing] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  // Only the newest request may land.
  const seq = useRef(0);
  // The seq of the newest refresh still in flight (for the mount: of whichever
  // of its two requests is); 0 when none is.
  const refreshInFlight = useRef(0);
  // A `reload` asked for while a refresh was in flight, owed once it settles.
  const reloadOwed = useRef(false);
  // Requests not yet settled, so an unmount can abort them.
  const pending = useRef(new Set<TimedRequest>());
  // Read through a ref so callers need not memoize.
  const options = useRef({ cacheKey, fetch, timeoutMessage, failureMessage });
  useEffect(() => {
    options.current = { cacheKey, fetch, timeoutMessage, failureMessage };
  });

  /**
   * One request. `forced` is what the daemon is asked; `leading` marks the
   * mount's unforced request, which holds the button busy like a refresh and
   * hands over to a forced request when it settles, however it settles.
   */
  const run = useCallback(async (forced: boolean, leading = false): Promise<void> => {
    const mine = ++seq.current;
    const holdsButton = forced || leading;
    if (holdsButton) {
      refreshInFlight.current = mine;
      setRefreshing(true);
    }
    // Every request times out, so `finally` always runs: a request left
    // pending forever would keep the button disabled and polls paused.
    const timed = startTimedRequest();
    pending.current.add(timed);
    try {
      const res = await options.current.fetch(forced, timed.signal);
      if (mine !== seq.current) return;
      remember(options.current.cacheKey, res);
      setData(res);
      setError(null);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(timed.timedOut() ? options.current.timeoutMessage : errorMessage(err, options.current.failureMessage));
    } finally {
      timed.done();
      pending.current.delete(timed);
      if (holdsButton && refreshInFlight.current === mine) {
        if (leading && mine === seq.current) {
          // Still the newest, so the view is still mounted: the forced request
          // takes the button over without it ever reading idle in between.
          void run(true);
        } else {
          // Only the newest refresh re-enables the button — a poll never does
          // (polls do not even start while a refresh is in flight).
          refreshInFlight.current = 0;
          setRefreshing(false);
          if (reloadOwed.current && mine === seq.current) {
            reloadOwed.current = false;
            void run(false);
          }
        }
      }
      setNow(Date.now());
    }
  }, []);

  // Paint first (unforced), then catch up with GitHub (forced). Switching to
  // the view remounts it.
  useEffect(() => {
    void run(false, true);
  }, [run]);

  // Going away: abort what is in flight, and let nothing that settles land.
  useEffect(() => {
    const requests = pending.current;
    const sequence = seq;
    return () => {
      sequence.current++;
      for (const request of requests) request.abort();
    };
  }, []);

  // Branches and PRs move slowly: background polls are not forced, and do not
  // start while a refresh is in flight. usePolling skips ticks while the
  // document is hidden.
  usePolling(() => {
    if (refreshInFlight.current === 0) void run(false);
  }, 60_000);
  // Keeps "updated Xs ago" honest between polls.
  usePolling(() => setNow(Date.now()), 10_000, { catchUp: false });

  const refresh = useCallback(() => void run(true), [run]);
  const reload = useCallback(() => {
    if (refreshInFlight.current !== 0) reloadOwed.current = true;
    else void run(false);
  }, [run]);

  return { data, error, refreshing, now, refresh, reload };
}
