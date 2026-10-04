export function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return "";

  const now = new Date();
  const diff = now.getTime() - date.getTime();

  // Handle future timestamps (clock skew)
  if (diff < 0) return "just now";

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return days === 1 ? "1 day ago" : `${days} days ago`;
  } else if (hours > 0) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  } else if (minutes > 0) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  } else if (seconds > 10) {
    return `${seconds} seconds ago`;
  } else {
    return "just now";
  }
}

/**
 * Returns true if the timestamp is recent enough to be showing
 * seconds or minutes (i.e. less than 1 hour old), meaning it
 * should auto-refresh on a short interval.
 */
export function shouldAutoRefresh(timestamp: string): boolean {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return false;
  const diff = Date.now() - date.getTime();
  if (diff < 0) return true; // Future timestamp, keep refreshing
  const hours = Math.floor(diff / 3_600_000);
  return hours < 1;
}

/**
 * Compact age — `Just now`, `5m ago`, `3h ago`, `2d ago` — for dense rows.
 *
 * `now` defaults to the clock; pass it when a parent ticks one `now` for a whole
 * list. `seconds` adds a `12s ago` tier from 10 seconds up (below that it is
 * still "just now"). Future timestamps read as "just now".
 */
export function formatShortAgo(
  ms: number,
  now: number = Date.now(),
  { seconds = false }: { seconds?: boolean } = {},
): string {
  const diff = now - ms;
  if (seconds) {
    const secs = Math.floor(diff / 1000);
    if (secs < 10) return "Just now";
    if (secs < 60) return `${secs}s ago`;
  }
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
