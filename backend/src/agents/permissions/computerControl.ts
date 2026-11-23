/** Explicit managed names only: never infer control authority from display text.
 * Some engines sanitize the MCP server/tool separator to `_` (the retired
 * ACP harness's OpenCode did; kept as generic coverage); Claude/Codex use
 * `mcp__server__tool`. Bare aliases are used by the pi custom-tool bridge.
 * This is categorization, NOT authorization; the owner-bound service gates calls.
 * The category is always `computerControl` for both targets — the tool name
 * cannot tell a browser call from a desktop call — and `decidePermission` reads
 * `browserControl`, `computerControl` and `sandboxControl` for it.
 */
export function isComputerControlToolName(name: string): boolean {
  return /^(?:cu_[a-z0-9_]+|computer_use(?:__|[_.:/])[a-z0-9_]+|mcp__computer_use__[a-z0-9_]+)$/.test(name);
}
