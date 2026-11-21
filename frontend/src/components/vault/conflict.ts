/** The message to show for a failed vault write. A 409 means the vault
 *  changed (any caller's item, or another tab) since the list loaded; the
 *  list is reloaded, so the same action can be retried at once. */
export function conflictMessage(res: { error: string; status?: number }): string {
  return res.status === 409
    ? "The vault changed since this list loaded. It has been reloaded: check the item and try again."
    : res.error;
}
