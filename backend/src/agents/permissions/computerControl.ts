/** Explicit managed names only: never infer control authority from display text.
 * OpenCode sanitizes the MCP server/tool separator to `_`; Claude/Codex use
 * `mcp__server__tool`. Bare aliases are shared by Cline/pi custom-tool bridges.
 * This is categorization, NOT authorization; the owner-bound service gates calls.
 */
export function isComputerControlToolName(name: string): boolean {
  return /^(?:cu_[a-z0-9_]+|computer_use(?:__|[_.:/])[a-z0-9_]+|mcp__computer_use__[a-z0-9_]+)$/.test(name);
}
