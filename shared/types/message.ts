export interface ParsedMessage {
  role: "user" | "assistant" | "system";
  type: "text" | "thinking" | "tool_use" | "tool_result" | "system";
  content: string;
  toolName?: string;
  toolUseId?: string;
  /**
   * Where the tool executed: "local" for tools run by the agent process (Claude
   * Code tools, MCP tools, a harness's own function calls), "openrouter_server"
   * for tools executed on the provider's servers. Absent ⇒ local.
   *
   * Nothing writes the second value today — the OpenRouter harness that did was
   * removed. It stays because the paired field in `shared/types/stream.ts` is a
   * published interface, and because transcripts written before the removal
   * still carry it.
   */
  toolSource?: "local" | "openrouter_server";
  isBuiltInCommand?: boolean;
  timestamp?: string;
  teamName?: string;
  /**
   * Present on system messages: `compact_boundary`, `clear_boundary`,
   * `interrupted`, `session_error`, `background_task`.
   */
  subtype?: string;
  /**
   * Outcome a `background_task` marker is reporting — `completed`, `failed`,
   * `stopped`, … Taken verbatim from the CLI's notification rather than
   * narrowed to a union, since the CLI owns the vocabulary and a value this
   * build hasn't seen should still render. Absent when the notice declares no
   * status.
   */
  backgroundTaskStatus?: string;
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
    /** Reasoning-trace tokens billed as output, when the adapter reports them. */
    reasoning_tokens?: number;
  };
  /** USD cost for this response, when the adapter exposes it. */
  costUsd?: number;
  /** End-to-end duration of the assistant turn that produced this message, in ms, when the transcript records it. */
  durationMs?: number;
  /** API service tier, e.g. "standard" */
  serviceTier?: string;
  /**
   * Image IDs attached to this message — user-sent images on user messages,
   * or images the agent read (e.g. Read tool on an image file) on tool_result
   * messages. Served from GET /api/images/:id.
   */
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
  /**
   * Unique key identifying a single model generation within the responses
   * debug table. For Claude Code this equals `requestId` (every API call
   * already has its own id). A harness that reuses one `requestId` across all
   * intra-cycle turns needs its transcript parser to synthesise `generationKey`
   * as `"<requestId>/<turnNumber>"` instead, giving each generation a distinct
   * identity the debug panel can group on. Falls back to `requestId` when
   * absent, which is every row this build produces.
   */
  generationKey?: string;
  /** Server-side tool usage counts */
  serverToolUse?: { webSearchRequests?: number; webFetchRequests?: number };
  /** Ephemeral cache tier breakdown */
  cacheCreation?: { ephemeral5m?: number; ephemeral1h?: number };
  /** Milliseconds since the previous message in the conversation */
  deltaMs?: number;
  /** Milliseconds per output token (deltaMs / output_tokens), when output_tokens > 0 */
  msPerOutputToken?: number;
}
