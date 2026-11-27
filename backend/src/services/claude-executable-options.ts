/**
 * The Agent SDK options that select `executable`: nothing when it is
 * `undefined` (the SDK's bundled CLI), otherwise the path plus
 * `mcpServersDelivery: "argv"`.
 *
 * Why pin the delivery: since Agent SDK 0.3.332 an app that spawns its own
 * Claude Code without the option gets a `CLAUDE_SDK_MCP_SERVERS_ARGV_DEPRECATED`
 * warning, and a later SDK changes the default to `"initialize"` (servers over
 * stdin), which a Claude Code older than the SDK's bundled one cannot read —
 * the session would fail to start. The binary resolved here is usually the
 * user's PATH `claude`, whose version callboard does not control, so it stays
 * on the command line, which every version reads. In-process SDK servers
 * (`createSdkMcpServer`) are unaffected either way.
 */
export function claudeExecutableOptions(executable: string | undefined): { pathToClaudeCodeExecutable?: string; mcpServersDelivery?: "argv" } {
  return executable ? { pathToClaudeCodeExecutable: executable, mcpServersDelivery: "argv" } : {};
}
