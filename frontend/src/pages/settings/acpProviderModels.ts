/**
 * Fold the ACP tab's edited Default Model back into `AgentSettings.acpProviderModels`.
 *
 * The settings page edits ONE vendor at a time — the tab that is open — but the
 * stored value is a map keyed by vendor id, and `PUT /api/agent-settings`
 * replaces that key wholesale when the request carries it. So the edit has to be
 * merged into the map the page loaded rather than sent on its own, or every
 * other vendor's entry is dropped by a save made from this vendor's tab.
 *
 * A blank edit is passed through as `""` rather than deleted here. The settings
 * route's map normalizer already drops a blank-value entry (the same rule it
 * applies to every row of every string map it takes), and collapses the whole
 * map to `undefined` once nothing is left — duplicating that client-side would
 * be a second place for the two to disagree.
 *
 * An empty `vendorId` returns the map untouched. That is the "vendor id has not
 * resolved yet" case — `getSystemInfo()` still in flight, or failed — and
 * writing under a `""` key would put a garbage entry in the user's settings that
 * nothing ever reads. It is effectively unreachable through the UI today, since
 * the ACP tab body (and this field within it) only renders once a real vendor id
 * is in hand, but the guard is what makes that a precondition rather than a
 * coincidence.
 */
export function mergeAcpProviderModel(existing: Record<string, string> | undefined, vendorId: string, value: string): Record<string, string> | undefined {
  if (!vendorId) return existing;
  return { ...existing, [vendorId]: value.trim() };
}
