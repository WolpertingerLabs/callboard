export interface AgentSettings {
  /** @deprecated Use localMcpConfigDir / remoteMcpConfigDir instead. Kept as fallback. */
  mcpConfigDir?: string;

  /** Absolute path to the .drawlatch/ directory for local mode */
  localMcpConfigDir?: string;

  /** Absolute path to the .drawlatch/ directory for remote mode */
  remoteMcpConfigDir?: string;

  /** Proxy mode: 'local' runs in-process, 'remote' connects to external server */
  proxyMode?: "local" | "remote";

  /** URL of the remote MCP secure proxy server (used in 'remote' mode only) */
  remoteServerUrl?: string;

  /** Default local MCP config directory path (read-only, computed by backend) */
  defaultLocalMcpConfigDir?: string;

  /** Default remote MCP config directory path (read-only, computed by backend) */
  defaultRemoteMcpConfigDir?: string;
}

export interface KeyAliasInfo {
  /** Directory name under keys/local/ */
  alias: string;
  /** Whether signing.pub.pem exists in the alias directory */
  hasSigningPub: boolean;
  /** Whether exchange.pub.pem exists in the alias directory */
  hasExchangePub: boolean;
}
