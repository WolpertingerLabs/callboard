import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import { WORKTREE_CREATE_TIMEOUT_MS } from "shared/types/git.js";

/** How often the elapsed time and the bar move. Fine enough to look continuous. */
const TICK_MS = 250;

interface Props {
  /** `Date.now()` when the request that creates the worktree went out. */
  startedAt: number;
  /** Abort the creation. The prompt goes back into the composer; nothing is created. */
  onCancel: () => void;
  /**
   * The budget the daemon gives the checkout before it gives up. Defaults to
   * the shared constant the backend kills git at, which is the only value
   * that makes the bar mean anything; overridable for tests.
   */
  timeoutMs?: number;
}

/**
 * `65_000` → `"1:05"`, `9_000` → `"9s"`. A count *up* floors and a count
 * *down* ceils, so the two read "0s elapsed, 1:00 left" at the start rather
 * than having lost a second before the first tick.
 */
function formatSeconds(ms: number, round: (n: number) => number = Math.floor): string {
  const total = Math.max(0, round(ms / 1000));
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Shown above the new-chat composer while the daemon is creating the chat's
 * worktree — a full checkout, which on a large repository takes long enough
 * that a spinner alone reads as a hang. Says that creation started, how long
 * it has been running, and how much of the daemon's budget is left, with a way
 * out that keeps the prompt.
 */
export default function WorktreeCreationIndicator({ startedAt, onCancel, timeoutMs = WORKTREE_CREATE_TIMEOUT_MS }: Props) {
  const [now, setNow] = useState(() => Date.now());
  // Mounted per creation, so the initial state is already this one's clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const elapsed = Math.max(0, now - startedAt);
  const remaining = Math.max(0, timeoutMs - elapsed);
  const fraction = Math.min(1, elapsed / timeoutMs);
  // The last quarter of the budget is where a slow checkout turns into a
  // failed one; say so in the bar's colour before it happens.
  const late = fraction >= 0.75;

  return (
    <div
      role="status"
      aria-label="Creating worktree"
      data-testid="worktree-creation-indicator"
      style={{
        margin: "0 16px 8px",
        padding: "8px 12px",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--bg-secondary)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        <GitBranch size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        <span style={{ color: "var(--text)", flex: 1, minWidth: 0 }}>Creating worktree…</span>
        <span data-testid="worktree-creation-elapsed" style={{ color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
          {formatSeconds(elapsed)} elapsed
        </span>
        <span data-testid="worktree-creation-remaining" style={{ color: late ? "var(--warning)" : "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
          {remaining > 0 ? `${formatSeconds(remaining, Math.ceil)} left` : "timing out…"}
        </span>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: "2px 10px",
            fontSize: 12,
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            background: "var(--surface)",
            color: "var(--text)",
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
      <div
        role="progressbar"
        aria-label="Time until worktree creation times out"
        aria-valuemin={0}
        aria-valuemax={Math.round(timeoutMs / 1000)}
        aria-valuenow={Math.min(Math.round(timeoutMs / 1000), Math.floor(elapsed / 1000))}
        aria-valuetext={`${formatSeconds(remaining, Math.ceil)} of ${formatSeconds(timeoutMs)} left`}
        style={{ height: 4, borderRadius: 2, background: "var(--border-light)", overflow: "hidden" }}
      >
        <div
          data-testid="worktree-creation-bar"
          style={{
            height: "100%",
            width: `${fraction * 100}%`,
            background: late ? "var(--warning)" : "var(--accent)",
            transition: `width ${TICK_MS}ms linear`,
          }}
        />
      </div>
    </div>
  );
}
