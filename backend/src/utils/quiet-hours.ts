/**
 * Quiet hours utility.
 *
 * Checks whether the current moment falls within a quiet hours window.
 * Used by the cron scheduler and trigger dispatcher to suppress
 * executions during off-hours.
 */
import type { QuietHours } from "shared";

/**
 * Returns true if the current time falls within the given quiet hours window,
 * meaning execution should be suppressed.
 *
 * Times are interpreted in the provided timezone. If no timezone is given,
 * falls back to the server's system timezone.
 *
 * Handles midnight crossover (e.g., start=22:00, end=07:00).
 */
export function isInQuietHours(quietHours: QuietHours | undefined, timezone?: string): boolean {
  if (!quietHours?.enabled) return false;

  const { start, end } = quietHours;
  if (!start || !end) return false;

  const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Get current time in the target timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const currentHour = parseInt(parts.find((p) => p.type === "hour")?.value || "0") % 24;
  const currentMinute = parseInt(parts.find((p) => p.type === "minute")?.value || "0");
  const currentMinutes = currentHour * 60 + currentMinute;

  // Parse start/end into total minutes since midnight
  const [startH, startM] = start.split(":").map(Number);
  const [endH, endM] = end.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Same-day window (e.g., 09:00 to 17:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  } else {
    // Wraps midnight (e.g., 22:00 to 07:00)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }
}
