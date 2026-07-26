/**
 * Client-generated identifiers.
 *
 * Everything here must work on any origin the UI is actually opened from.
 * Callboard is a server you browse to — often over plain HTTP at a LAN IP, a
 * tunnel hostname, or a phone on the same network — and those are *insecure
 * contexts*, where `crypto.randomUUID` is not exposed at all. Reaching for it
 * unguarded throws a TypeError, which is how a missing id took down new-chat
 * sends entirely.
 */

/**
 * Random-enough unique suffix for contexts without `crypto.randomUUID`.
 * `Math.random` is not cryptographically strong, and doesn't need to be: these
 * ids are per-tab handles for an in-flight request, never secrets.
 */
function fallbackUnique(): string {
  const rand = () => Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand()}-${rand()}`;
}

/**
 * Temporary session key for a chat that doesn't exist yet, so the run can be
 * stopped during the window before the server reports its real chat id.
 *
 * The `new-` prefix is required: the server only accepts a clientTrackingId
 * matching `^new-[A-Za-z0-9_-]+$`, which keeps a caller from claiming the
 * registry slot of a real chat. An id the server rejects (or one already in
 * use) is ignored server-side and the run falls back to a server-generated
 * key — so a collision costs the stoppability of that startup window, nothing
 * more.
 */
export function newChatTrackingId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `new-${uuid ?? fallbackUnique()}`;
}
