/**
 * Which job runs are currently parked on a user approval, and which chat row
 * is carrying the badge for each.
 *
 * A standalone leaf module for the same reason chat-list-cache.ts is one: the
 * chat-list route needs to ask the question, and importing job-runner.ts to do
 * it would close a cycle back through claude.ts. Nothing here imports anything.
 *
 * job-runner.ts is the only writer — `syncApprovalSignal` maintains it on every
 * transition into and out of `waiting_approval`, and `resumeRunAfterRestart`
 * re-seeds it at boot from `listResumableRuns`, which returns every non-terminal
 * run. That boot seeding is what makes {@link hasParkedApprovals} safe to use as
 * a gate: the map is not a cache that warms up, it is complete from startup.
 *
 * Read it as a global boolean, not as a per-run oracle. The chat-list route uses
 * it to skip work when nothing is parked at all — the overwhelmingly common
 * state — and falls back to the run files themselves to decide *which* row is
 * the representative. A stale entry therefore costs a pointless scan, not a
 * badge on the wrong row.
 */

/** runId → the chat row announced as carrying that run's approval badge. */
const parkedApprovalChats = new Map<string, string | undefined>();

export function isApprovalAnnounced(runId: string): boolean {
  return parkedApprovalChats.has(runId);
}

export function announcedApprovalChat(runId: string): string | undefined {
  return parkedApprovalChats.get(runId);
}

export function markApprovalParked(runId: string, chatId: string | undefined): void {
  parkedApprovalChats.set(runId, chatId);
}

export function clearApprovalParked(runId: string): void {
  parkedApprovalChats.delete(runId);
}

/**
 * Is any run anywhere parked on an approval right now?
 *
 * The chat-list route's short-circuit. When this is false no chat row can be a
 * representative, so the triggered-filter carve-out and the needs-you stamp can
 * both skip their run-file reads entirely.
 */
export function hasParkedApprovals(): boolean {
  return parkedApprovalChats.size > 0;
}
