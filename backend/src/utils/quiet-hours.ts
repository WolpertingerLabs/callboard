/**
 * Quiet hours utility.
 *
 * Checks whether the current moment falls within an agent's configured
 * quiet hours window. Used by the cron scheduler and trigger dispatcher
 * to suppress repetitive executions during off-hours.
 */
import type { AgentConfig } from "shared";

/**
 * Returns true if the current time falls within the agent's quiet hours window,
 * meaning execution should be suppressed.
 *
 * Times are interpreted in the agent's userTimezone. If no timezone is configured,
 * falls back to the server's system timezone.
 *
 * Handles midnight crossover (e.g., start=22:00, end=07:00).
 */
export function isInQuietHours(agent: AgentConfig, context?: "crons" | "triggers"): boolean {
  if (!agent.quietHours?.enabled) return false;

  const { start, end, scope } = agent.quietHours;

  // Scope filtering: if scope targets a specific type and the caller is the other type, don't suppress
  const effectiveScope = scope || "all";
  if (context && effectiveScope !== "all" && effectiveScope !== context) {
    return false;
  }
  if (!start || !end) return false;

  const timezone = agent.userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Get current time in the agent's timezone
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
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
