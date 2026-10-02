import { useEffect, useRef } from "react";

interface UsePollingOptions {
  /** Poll only while true. Default: true. */
  enabled?: boolean;
}

/**
 * Calls `fn` every `intervalMs` while `enabled`, skipping ticks while the tab
 * is hidden and firing once as soon as it becomes visible again to catch up.
 *
 * Does NOT fire on mount — callers do their own initial fetch, which usually
 * has different dependencies from the poll. `fn` is read through a ref, so it
 * needn't be memoized and changing it never restarts the interval; only
 * `intervalMs` and `enabled` do.
 */
export function usePolling(fn: () => unknown, intervalMs: number, { enabled = true }: UsePollingOptions = {}): void {
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState !== "hidden") fnRef.current();
    };
    const interval = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [enabled, intervalMs]);
}
