import { useCallback, useEffect, useRef, useState } from "react";

/** Passed to every poll so it can drop a result that arrived too late. */
export interface PollContext {
  /** False once the component unmounted, `key`/`enabled` changed, or a newer
   *  run (a `refresh()`) superseded this one. Check it after every `await`
   *  before setting state. */
  active: () => boolean;
}

export interface UsePollingOptions {
  /** Off: no polling at all (e.g. while the daemon is down). Default true. */
  enabled?: boolean;
  /** Restarts polling (and runs at once) when it changes, e.g. the selected
   *  caller. Results from the previous key report `active() === false`. */
  key?: string | number | null;
}

/**
 * Runs `task` now and then every `intervalMs` while the tab is visible.
 *
 * - **No overlap:** the next scheduled run starts only after the previous one
 *   settles, so a slow daemon never has a queue of requests piling up.
 * - **Hidden tab:** nothing runs while `document.visibilityState` is
 *   "hidden"; it runs straight away when the tab is shown again.
 * - **Unmount and key changes:** timers are cleared and `ctx.active()` turns
 *   false, so a late response can't set state on a dead or stale view.
 * - **`refresh()`** always starts a fresh request, even if one is in flight:
 *   the older run's `ctx.active()` turns false so its (possibly pre-mutation)
 *   result is dropped. Safe to call right after a mutation. It resolves when
 *   the fresh run is done.
 *
 * `task` may change on every render; the latest one is always called.
 */
export function usePolling(
  task: (ctx: PollContext) => Promise<void> | void,
  intervalMs: number,
  { enabled = true, key = null }: UsePollingOptions = {},
): { refresh: () => Promise<void> } {
  const taskRef = useRef(task);
  taskRef.current = task;
  // refresh() of the current effect run.
  const runRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;
    // Each run's number; only the newest run may deliver or reschedule.
    let generation = 0;

    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (!alive || document.visibilityState === "hidden") return;
      timer = setTimeout(() => void run(false), intervalMs);
    };

    /** `fresh`: start a new request even if one is in flight (refresh()). */
    const run = (fresh: boolean): Promise<void> => {
      if (inFlight && !fresh) return inFlight;
      clearTimer();
      const gen = ++generation;
      const ctx: PollContext = { active: () => alive && gen === generation };
      const p = (async () => {
        try {
          await taskRef.current(ctx);
        } catch (err) {
          // A poll must never stop the loop; the task reports its own errors.
          console.error("poll failed", err);
        } finally {
          // A superseded run leaves scheduling to the run that replaced it.
          if (gen === generation) {
            inFlight = null;
            schedule();
          }
        }
      })();
      inFlight = p;
      return p;
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") clearTimer();
      else void run(false);
    };

    const refresh = () => run(true);
    runRef.current = refresh;
    // Load once even in a background tab, so the page isn't empty when shown.
    void run(false);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      alive = false;
      clearTimer();
      document.removeEventListener("visibilitychange", onVisibility);
      if (runRef.current === refresh) runRef.current = null;
    };
  }, [enabled, intervalMs, key]);

  const refresh = useCallback(
    () => runRef.current?.() ?? Promise.resolve(),
    [],
  );
  return { refresh };
}

/** `Date.now()`, updated every `intervalMs` while the tab is visible, for
 *  relative times ("12s ago"). */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer !== null) return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), intervalMs);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else start();
    };
    if (document.visibilityState !== "hidden") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
  return now;
}
