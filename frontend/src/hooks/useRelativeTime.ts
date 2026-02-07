import { useState, useEffect } from "react";
import { formatRelativeTime, shouldAutoRefresh } from "../utils/dateFormat";

const AUTO_REFRESH_INTERVAL_MS = 5_000;

/**
 * Returns a live-updating relative time string for the given timestamp.
 * Auto-refreshes every 5 seconds while the timestamp is showing seconds
 * or minutes. Once it rolls over to hours (or beyond), the interval stops.
 */
export function useRelativeTime(timestamp: string | undefined): string | null {
  // tick state exists solely to trigger periodic re-renders
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!timestamp || !shouldAutoRefresh(timestamp)) return;

    const id = setInterval(() => {
      setTick((t) => t + 1);

      if (!shouldAutoRefresh(timestamp)) {
        clearInterval(id);
      }
    }, AUTO_REFRESH_INTERVAL_MS);

    return () => clearInterval(id);
  }, [timestamp]);

  // tick is consumed here to prevent unused-variable warnings
  void tick;

  // Compute the formatted value on every render (tick changes force re-render)
  return timestamp ? formatRelativeTime(timestamp) : null;
}
