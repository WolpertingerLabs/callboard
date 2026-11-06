/**
 * How long the Branches view and the PRs tab wait on the daemon before giving
 * a request up. The slowest honest answer is a repository's first PR lookup:
 * two `gh api` listings at up to 15s each (GH_TIMEOUT_MS in
 * backend/src/services/github-prs.ts), plus time queued behind the two-at-a-
 * time fetch limit and the worktree listings — so 45s rather than 30. Anything
 * longer is a request that will never settle (a socket left dead by a laptop
 * sleep, a dropped remote connection), and leaving it pending would keep the
 * refresh button disabled and polling paused until the view remounted.
 */
export const PR_REQUEST_TIMEOUT_MS = 45_000;

/** One request's abort handle: a timeout of its own, and an abort for unmount. */
export interface TimedRequest {
  signal: AbortSignal;
  /** True once the timeout, not the caller, aborted it. */
  timedOut: () => boolean;
  /** Abort now (the view is going away). */
  abort: () => void;
  /** Stop the timer once the request has settled. */
  done: () => void;
}

/**
 * Start a request's signal. A plain timer rather than `AbortSignal.timeout` so
 * the clock it runs on is the one tests drive.
 */
export function startTimedRequest(timeoutMs = PR_REQUEST_TIMEOUT_MS): TimedRequest {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => expired,
    abort: () => {
      clearTimeout(timer);
      controller.abort();
    },
    done: () => clearTimeout(timer),
  };
}
