export interface AgentSettings {
  /** Absolute path to the .mcp-secure-proxy/ directory containing keys and identity */
  mcpConfigDir?: string;
}

export interface KeyAliasInfo {
  /** Directory name under keys/peers/ */
  alias: string;
  /** Whether signing.pub.pem exists in the alias directory */
  hasSigningPub: boolean;
  /** Whether exchange.pub.pem exists in the alias directory */
  hasExchangePub: boolean;
}
