import type { CardRollupState } from "../../api";

/**
 * Rollup-state colours for a conversation's status dot — themable via the
 * `--board-rollup-*` variables in index.css.
 */
export const ROLLUP_COLORS: Record<CardRollupState, string> = {
  needs_you: "var(--board-rollup-needs-you)",
  job_running: "var(--board-rollup-job-running)",
  active: "var(--board-rollup-active)",
  idle: "var(--board-rollup-idle)",
};
