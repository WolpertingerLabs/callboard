/**
 * "A computer-control Stop, Revoke, takeover, resume or permission change just
 * settled for this chat."
 *
 * Stopping or revoking a session also withdraws any open computer-control
 * request aimed at it — an enable card, a GUI-action confirmation — and the
 * daemon can only take that card down in a tab with a live stream. The chat
 * page listens here and re-reads `/pending`, so the card goes (and anything
 * queued behind it appears) on an idle chat too. A plain listener set rather
 * than context: the emitters (the header's Stop computer control, the
 * Computer view's buttons) and the listener (the chat page) sit in unrelated
 * subtrees.
 */
type Listener = (chatId: string) => void;
const listeners = new Set<Listener>();

export function onComputerControlSettled(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitComputerControlSettled(chatId: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(chatId);
    } catch {
      /* a listener's failure is its own */
    }
  }
}

/**
 * The daemon withdraws requests a takeover, resume or permission change made
 * unrunnable on its 1s watchdog sweep, not in the request itself — so signal
 * now, and again once that sweep has run.
 */
export const WATCHDOG_SETTLE_MS = 1500;
export function emitComputerControlSettledSoon(chatId: string): void {
  emitComputerControlSettled(chatId);
  setTimeout(() => emitComputerControlSettled(chatId), WATCHDOG_SETTLE_MS);
}
