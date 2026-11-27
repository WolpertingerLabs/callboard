import { useCallback, useEffect, useRef, useState } from "react";
import { usePolling } from "../../hooks/usePolling";
import { errorMessage } from "../../utils/errorMessage";
import { PR_REQUEST_TIMEOUT_MS, startTimedRequest, type TimedRequest } from "./timedRequest";

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

/**
 * Forget every remembered answer. Called on logout: what one login saw must
 * not be what the next one is shown first.
 */
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
  /**
   * An answer has landed since this mount, so `data` is the daemon's word and
   * not a memory. Until then a remembered answer is good for painting what it
   * holds, but not for saying there is nothing: that may have changed since.
   */
  landed: boolean;
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

/** What one mounted view's requests share. Mutable, and never read while rendering. */
interface Requests<T> {
  /** Only the newest request may land. */
  seq: number;
  /**
   * The seq of the newest refresh still in flight (for the mount: of whichever
   * of its two requests is); 0 when none is.
   */
  refreshInFlight: number;
  /** A `reload` asked for while a refresh was in flight, owed once it settles. */
  reloadOwed: boolean;
  /** Requests not yet settled, so an unmount can abort them. */
  pending: Set<TimedRequest>;
  /** The caller's latest options, so it need not memoize them. */
  options: UseGitRequestOptions<T>;
}

/** Where a request's outcome goes: the hook's state setters. */
interface Outcome<T> {
  setData: (data: T) => void;
  setLanded: (landed: boolean) => void;
  setError: (error: string | null) => void;
  setRefreshing: (refreshing: boolean) => void;
  setNow: (now: number) => void;
}

/**
 * One request. `forced` is what the daemon is asked; `leading` marks the
 * mount's unforced request, which holds the button busy like a refresh and
 * hands over to a forced request when it settles. A plain function rather than
 * a callback of the hook's, because it calls itself (the handover, the owed
 * reload).
 */
async function request<T>(m: Requests<T>, out: Outcome<T>, forced: boolean, leading = false, timeoutMs = PR_REQUEST_TIMEOUT_MS): Promise<void> {
  const mine = ++m.seq;
  const holdsButton = forced || leading;
  if (holdsButton) {
    m.refreshInFlight = mine;
    out.setRefreshing(true);
  }
  // Every request times out, so `finally` always runs: a request left
  // pending forever would keep the button disabled and polls paused.
  const startedAt = Date.now();
  const timed = startTimedRequest(timeoutMs);
  m.pending.add(timed);
  try {
    const res = await m.options.fetch(forced, timed.signal);
    if (mine !== m.seq) return;
    remember(m.options.cacheKey, res);
    out.setData(res);
    out.setLanded(true);
    out.setError(null);
  } catch (err) {
    if (mine !== m.seq) return;
    out.setError(timed.timedOut() ? m.options.timeoutMessage : errorMessage(err, m.options.failureMessage));
  } finally {
    timed.done();
    m.pending.delete(timed);
    if (holdsButton && m.refreshInFlight === mine) {
      // The mount's two requests share one deadline, so together they hold
      // the button no longer than a single refresh can: the forced request
      // gets what the unforced one left, and nothing at all if that timed out
      // (a daemon that did not answer the cheap request will not answer the
      // dear one; the next poll or a click asks again).
      const left = timeoutMs - (Date.now() - startedAt);
      if (leading && mine === m.seq && !timed.timedOut() && left > 0) {
        // Still the newest, so the view is still mounted: the forced request
        // takes the button over without it ever reading idle in between.
        void request(m, out, true, false, left);
      } else {
        // Only the newest refresh re-enables the button — a poll never does
        // (polls do not even start while a refresh is in flight).
        m.refreshInFlight = 0;
        out.setRefreshing(false);
        if (m.reloadOwed && mine === m.seq) {
          m.reloadOwed = false;
          void request(m, out, false);
        }
      }
    }
    out.setNow(Date.now());
  }
}

/**
 * The request machinery the Git page and a chat's PRs tab share: one endpoint,
 * asked on mount, polled every minute, and re-asked on demand.
 *
 * The daemon answers an unforced request from its PR cache — at once, unless
 * it has no entry for a repo or one older than ten minutes, when even an
 * unforced request waits on `gh` — and a forced one only after `gh` (seconds).
 * So a mount asks twice, in order: unforced, which paints, then forced, which
 * makes the data as fresh as a click on the refresh button would. In order
 * rather than together because the unforced answer is the one the first paint
 * waits on and should not share the daemon with the other. `gh` is not
 * normally asked twice for it: when the daemon's cache is cold the unforced
 * request does the fetch and the forced one, coming within 10s of that
 * request's start, reuses it (a cold fetch slower than 10s is fetched again);
 * when it is stale the unforced one starts a background fetch that the forced
 * one joins. The daemon's own work (worktree listings) is done twice.
 *
 * What it guarantees:
 * - Only the newest request may land: a slow poll (or the mount's unforced
 *   request) cannot overwrite a refresh started after it.
 * - Nothing unforced starts while a refresh is in flight, so nothing can
 *   supersede it: polls skip, and `reload` waits for it to settle.
 * - Only the newest refresh re-enables the button; a poll never does.
 * - Every request times out, so the button cannot stay disabled forever —
 *   nor, on mount, for longer than one timeout: the two requests share it.
 * - Unmounting aborts what is in flight, and nothing that settles later lands.
 */
export function useGitRequest<T>(options: UseGitRequestOptions<T>): GitRequest<T> {
  const [data, setData] = useState<T | null>(() => (cache.get(options.cacheKey) as T | undefined) ?? null);
  const [landed, setLanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The mount's requests end in a forced one, so the button starts disabled.
  const [refreshing, setRefreshing] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const requests = useRef<Requests<T>>({ seq: 0, refreshInFlight: 0, reloadOwed: false, pending: new Set(), options });
  useEffect(() => {
    requests.current.options = options;
  });

  const run = useCallback(
    (forced: boolean, leading = false) => request(requests.current, { setData, setLanded, setError, setRefreshing, setNow }, forced, leading),
    [],
  );

  // Paint first (unforced), then catch up with GitHub (forced). Switching to
  // the view remounts it.
  useEffect(() => {
    void run(false, true);
  }, [run]);

  // Going away: abort what is in flight, and let nothing that settles land.
  useEffect(() => {
    const mounted = requests.current;
    return () => {
      mounted.seq++;
      for (const pending of mounted.pending) pending.abort();
    };
  }, []);

  // Branches and PRs move slowly: background polls are not forced, and do not
  // start while a refresh is in flight. usePolling skips ticks while the
  // document is hidden.
  usePolling(() => {
    if (requests.current.refreshInFlight === 0) void run(false);
  }, 60_000);
  // Keeps "updated Xs ago" honest between polls.
  usePolling(() => setNow(Date.now()), 10_000, { catchUp: false });

  const refresh = useCallback(() => void run(true), [run]);
  const reload = useCallback(() => {
    if (requests.current.refreshInFlight !== 0) requests.current.reloadOwed = true;
    else void run(false);
  }, [run]);

  return { data, landed, error, refreshing, now, refresh, reload };
}
