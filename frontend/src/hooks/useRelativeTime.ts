import { useState, useEffect } from "react";
import { formatRelativeTime, shouldAutoRefresh } from "../utils/dateFormat";

const AUTO_REFRESH_INTERVAL_MS = 5_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Fire just past a label boundary rather than exactly on it. */
const BOUNDARY_SLACK_MS = 50;

/**
 * How long until the label for `timestamp` can next change, or null when it
 * never will (unparseable). Under an hour that is the 5s seconds/minutes
 * cadence; past it, the next hour or day rollover — so an old label costs one
 * timer per hour, not one per 5s.
 */
function msUntilNextChange(timestamp: string): number | null {
  const time = new Date(timestamp).getTime();
  if (isNaN(time)) return null;
  if (shouldAutoRefresh(timestamp)) return AUTO_REFRESH_INTERVAL_MS;
  const diff = Date.now() - time;
  const unit = diff < DAY_MS ? HOUR_MS : DAY_MS;
  return unit - (diff % unit) + BOUNDARY_SLACK_MS;
}

/**
 * Returns a live-updating relative time string for the given timestamp.
 * Refreshes every 5 seconds while the timestamp is showing seconds or
 * minutes, then at each hour (and later day) rollover.
 *
 * It must keep itself current: MessageBubble is memoized, so a parent
 * re-render no longer refreshes the label for it.
 */
export function useRelativeTime(timestamp: string | undefined): string | null {
  // tick state exists solely to trigger periodic re-renders
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!timestamp) return;
    const delay = msUntilNextChange(timestamp);
    if (delay === null) return;
    // Re-armed after every tick, since the next delay depends on the new age.
    const id = setTimeout(() => setTick((t) => t + 1), delay);
    return () => clearTimeout(id);
  }, [timestamp, tick]);

  // Compute the formatted value on every render (tick changes force re-render)
  return timestamp ? formatRelativeTime(timestamp) : null;
}
