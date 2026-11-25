/**
 * Application-layer message types exchanged over the encrypted channel.
 *
 * All messages are JSON-serialized, encrypted with AES-256-GCM, and sent
 * as hex-encoded payloads over the HTTP transport.
 */

/** Request from MCP proxy → remote server */
export interface ProxyRequest {
  type: 'proxy_request';
  /** Unique request ID for correlation */
  id: string;
  /** The tool name the MCP client invoked */
  toolName: string;
  /** The tool's input parameters */
  toolInput: Record<string, unknown>;
  /** How long (ms) the remote may spend on an outbound fetch for this request,
   *  derived by the local proxy from the deadline it actually armed on its own
   *  socket, minus its slack. Clamps the matched connection's
   *  `requestTimeoutMs` so the nested deadlines stay ordered innermost-first
   *  even for tools that expose no per-call `timeoutMs`.
   *
   *  Lives on the envelope rather than in `toolInput` precisely because it must
   *  reach handlers that do not forward their input (test_connection,
   *  test_ingestor, resolve_listener_options).
   *
   *  Optional, and absence means "no clamp" — an older local proxy talking to a
   *  newer remote simply omits it, and the admin API never sets it. Both
   *  sides tolerate absence, so adding it is not a breaking protocol change. */
  outboundBudgetMs?: number;
  /** Timestamp (ms since epoch) */
  timestamp: number;
}

/** Response from remote server → MCP proxy */
export interface ProxyResponse {
  type: 'proxy_response';
  /** Correlates to ProxyRequest.id */
  id: string;
  /** Whether the operation succeeded */
  success: boolean;
  /** The result payload (tool output) */
  result?: unknown;
  /** Error message if success=false */
  error?: string;
  /** Timestamp */
  timestamp: number;
}

/** Ping to keep the connection alive / verify the channel */
export interface PingMessage {
  type: 'ping';
  timestamp: number;
}

/** Pong response */
export interface PongMessage {
  type: 'pong';
  timestamp: number;
  /** Echo back the ping timestamp for RTT measurement */
  echoTimestamp: number;
}

export type AppMessage = ProxyRequest | ProxyResponse | PingMessage | PongMessage;
