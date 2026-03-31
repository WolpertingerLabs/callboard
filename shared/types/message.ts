export interface ParsedMessage {
  role: "user" | "assistant" | "system";
  type: "text" | "thinking" | "tool_use" | "tool_result" | "system";
  content: string;
  toolName?: string;
  toolUseId?: string;
  isBuiltInCommand?: boolean;
  timestamp?: string;
  teamName?: string;
  /** Present on system messages like compact_boundary */
  subtype?: string;
  /** Model name from the API response, e.g. "claude-opus-4-6" */
  model?: string;
  /** Git branch at the time this message was recorded */
  gitBranch?: string;
  /** Token usage from the API response */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /** API service tier, e.g. "standard" */
  serviceTier?: string;
  /** Image IDs attached to this user message (for rendering sent images) */
  imageIds?: string[];

  // ── Debug / metrics fields ──

  /** Why the model stopped: "end_turn", "tool_use", "max_tokens", or null for streaming partials */
  stopReason?: string | null;
  /** Speed mode: "standard" or "fast" */
  speed?: string;
  /** Inference geography hint from the API */
  inferenceGeo?: string;
  /** API request ID from the JSONL entry (useful for support escalation) */
  requestId?: string;
  /** Server-side tool usage counts */
  serverToolUse?: { webSearchRequests?: number; webFetchRequests?: number };
  /** Ephemeral cache tier breakdown */
  cacheCreation?: { ephemeral5m?: number; ephemeral1h?: number };
  /** Milliseconds since the previous message in the conversation */
  deltaMs?: number;
  /** Milliseconds per output token (deltaMs / output_tokens), when output_tokens > 0 */
  msPerOutputToken?: number;
}
