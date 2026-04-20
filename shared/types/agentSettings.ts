export interface AgentSettings {
  /** @deprecated Use localMcpConfigDir / remoteMcpConfigDir instead. Kept as fallback. */
  mcpConfigDir?: string;

  /** Absolute path to the .drawlatch.local/ directory for local mode */
  localMcpConfigDir?: string;

  /** Absolute path to the .drawlatch.remote/ directory for remote mode */
  remoteMcpConfigDir?: string;

  /** Proxy mode: 'local' runs in-process, 'remote' connects to external server */
  proxyMode?: "local" | "remote";

  /** URL of the remote MCP secure proxy server (used in 'remote' mode only) */
  remoteServerUrl?: string;

  /** Enable cloudflared tunnel for webhook event ingestion (local mode only) */
  tunnelEnabled?: boolean;

  /** Default local MCP config directory path (read-only, computed by backend) */
  defaultLocalMcpConfigDir?: string;

  /** Default remote MCP config directory path (read-only, computed by backend) */
  defaultRemoteMcpConfigDir?: string;

  // ── Claude Agent SDK API / auth / model overrides ─────────────────
  // Each field maps to a single environment variable that the Agent SDK
  // consumes. When set, the value is injected into the SDK subprocess env;
  // when empty/undefined, the surrounding process.env takes over (which is
  // usually the subscription-based login flow).

  /** ANTHROPIC_BASE_URL — override the API endpoint (proxy / gateway). */
  apiBaseUrl?: string;

  /** ANTHROPIC_API_KEY — raw API key sent as X-Api-Key. */
  apiKey?: string;

  /** ANTHROPIC_AUTH_TOKEN — Bearer token (mutually exclusive with apiKey in practice). */
  authToken?: string;

  /** ANTHROPIC_MODEL — primary model alias or full ID for the session. */
  model?: string;

  /** ANTHROPIC_DEFAULT_OPUS_MODEL — model the `opus` alias resolves to. */
  defaultOpusModel?: string;

  /** ANTHROPIC_DEFAULT_SONNET_MODEL — model the `sonnet` alias resolves to. */
  defaultSonnetModel?: string;

  /** ANTHROPIC_DEFAULT_HAIKU_MODEL — model the `haiku` alias resolves to. */
  defaultHaikuModel?: string;

  /** CLAUDE_CODE_SUBAGENT_MODEL — model used by spawned subagents. */
  subagentModel?: string;
}

export interface KeyAliasInfo {
  /** Directory name under keys/callers/ */
  alias: string;
  /** Whether signing.pub.pem exists in the alias directory */
  hasSigningPub: boolean;
  /** Whether exchange.pub.pem exists in the alias directory */
  hasExchangePub: boolean;
}
