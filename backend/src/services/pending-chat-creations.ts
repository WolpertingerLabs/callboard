/**
 * New chats still being prepared — between `POST /new/message` arriving and
 * `sendMessage` taking over — addressable by the `clientTrackingId` the client
 * sent with it.
 *
 * The preparation that needs this is the worktree checkout, which runs up to
 * `WORKTREE_CREATE_TIMEOUT_MS`. No session exists yet, so `stopSession` has
 * nothing to stop, and the client hanging up is deliberately *not* a cancel:
 * navigating off the compose screen aborts the POST too, and a chat whose
 * creation the user merely walked away from has always gone on to start. A
 * cancel is asked for explicitly, through `POST /:id/stop` with the tracking id.
 */

const pending = new Map<string, AbortController>();

/**
 * Register a creation under `trackingId` and get the signal that fires when it
 * is cancelled. Call the returned `end` once the creation is past the point of
 * cancelling (or failed), so a late stop finds nothing rather than a stale entry.
 */
export function beginPendingCreation(trackingId: string | undefined): { signal: AbortSignal; end: () => void } {
  const controller = new AbortController();
  if (!trackingId) return { signal: controller.signal, end: () => {} };
  pending.set(trackingId, controller);
  return {
    signal: controller.signal,
    // Only our own entry: a later creation reusing the id must not be dropped by this one ending.
    end: () => {
      if (pending.get(trackingId) === controller) pending.delete(trackingId);
    },
  };
}

/** Cancel the creation registered under `trackingId`. True when there was one to cancel. */
export function cancelPendingCreation(trackingId: string): boolean {
  const controller = pending.get(trackingId);
  if (!controller) return false;
  pending.delete(trackingId);
  controller.abort();
  return true;
}
