export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** Epoch ms from an ISO string or epoch ms; NaN when it isn't a time. */
export function toEpochMs(t: string | number | null | undefined): number {
  if (t === null || t === undefined) return NaN;
  return typeof t === "number" ? t : Date.parse(t);
}

/**
 * "just now", "12s ago", "5m ago", "3h ago", "2d ago" for a past time, or
 * "—" when it isn't one. Pass `now` from `useNow()` so it re-renders.
 */
export function timeAgo(
  t: string | number | null | undefined,
  now: number = Date.now(),
): string {
  const ms = toEpochMs(t);
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const deltaMs = now - ms;
  if (deltaMs < 0) return "just now";
  const s = Math.floor(deltaMs / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "1 listener" / "3 listeners". */
export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}
