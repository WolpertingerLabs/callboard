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
}
