/**
 * Whether an Escape pressed with focus on `target` is for a popover that
 * lives inside `own` (a composer's menu, a command chip's body).
 *
 * The page can hold two chats at once — the main one and the aside panel's —
 * each with its own composer. A popover open in one must not swallow an
 * Escape pressed in the other, so the claim is scoped to the chat the popover
 * belongs to (its nearest `.chat-layout`, else `own` itself). Focus on the
 * page body (nothing focused, after a mouse-opened menu) still counts: that
 * Escape has nowhere else to go.
 */
export function escapeIsInScope(target: EventTarget | null, own: Element | null): boolean {
  if (!own) return false;
  if (!(target instanceof Node) || target === document || target === document.body || target === document.documentElement) return true;
  const scope = own.closest(".chat-layout") ?? own;
  return scope.contains(target);
}
