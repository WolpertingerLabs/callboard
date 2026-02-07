import { useState, useEffect } from 'react';
import { formatRelativeTime, shouldAutoRefresh } from '../utils/dateFormat';

const AUTO_REFRESH_INTERVAL_MS = 5_000;

/**
 * Returns a live-updating relative time string for the given timestamp.
 * Auto-refreshes every 5 seconds while the timestamp is showing seconds
 * or minutes. Once it rolls over to hours (or beyond), the interval stops.
 */
export function useRelativeTime(timestamp: string | undefined): string | null {
  const [formatted, setFormatted] = useState<string | null>(
    timestamp ? formatRelativeTime(timestamp) : null,
  );

  useEffect(() => {
    if (!timestamp) return;

    // Immediately compute the current value
    setFormatted(formatRelativeTime(timestamp));

    // Only set up the interval if the timestamp is recent enough
    if (!shouldAutoRefresh(timestamp)) return;

    const id = setInterval(() => {
      setFormatted(formatRelativeTime(timestamp));

      // Once we've crossed into "hours" territory, stop refreshing
      if (!shouldAutoRefresh(timestamp)) {
        clearInterval(id);
      }
    }, AUTO_REFRESH_INTERVAL_MS);

    return () => clearInterval(id);
  }, [timestamp]);

  return formatted;
}
