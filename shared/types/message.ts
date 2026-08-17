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
  /**
   * Token usage from the API response.
   *
   * **This field is the responses debug panel's row filter** — an assistant
   * message without it produces no row at all — so a parser that drops it makes
   * the panel blank for that engine rather than sparse.
   *
   * A sub-field is `undefined` when the engine does not report it and `0` when
   * it reported none; the two are not interchangeable, and no parser may
   * default one into the other. Cache-write availability, for instance:
   *
   *   claude-code  cache read ✓  cache write ✓
   *   codex        cache read ✓  cache write ✗ — OpenAI bills no cache writes
   *                                             and reports no such metric
   *   acp          cache read ✓  cache write ✓ — both optional in the schema;
   *                                             blank for a vendor that omits them
   *   cline        cache read ✓  cache write ✓ — cumulative, differenced on read
   *   pi           cache read ✓  cache write ✓
   */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    /** Reasoning-trace tokens billed as output, when the adapter reports them. */
    reasoning_tokens?: number;
  };
  /**
   * USD cost for this response, when the adapter exposes it.
   *
   * Reported by **cline** (from its running `totalCost`), **pi** (from
   * `usage.cost.total`) and **acp** (from a `usage_update` that carries a USD
   * amount) — all three differenced or taken per-turn so a row shows its own
   * spend rather than the chat's.
   *
   * Never populated for **claude-code** or **codex**, and not for want of
   * trying: the Agent SDK's JSONL records no cost field anywhere (surveyed
   * across the local session logs), and a Codex rollout has none either —
   * subscription runs are not priced per call. Deriving one from token counts
   * and a price table would be a guess wearing a cost's clothing, so the column
   * stays blank for those two.
   */
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

  /**
   * Why the model stopped: "end_turn", "tool_use", "max_tokens", or null for
   * streaming partials.
   *
   * Not narrowed to a union, because the vocabulary is per-engine and a value
   * this build has not seen must still render. Parsers translate into the three
   * names above **only** when the engine reports the same closed concept under a
   * different spelling — pi's `stop`/`length`/`toolUse` do, and are renamed.
   * Everything else passes through verbatim: ACP already uses these names for
   * the values that overlap and has its own (`refusal`, `cancelled`) for the
   * rest, and Cline reports why its agent *loop* finished (`completed`,
   * `max_iterations`), which is a different fact from why the model stopped and
   * is not relabelled as though it were.
   *
   * Absent for **codex**: a rollout carries no stop reason in any line type —
   * confirmed by a census over every `event_msg` and `response_item` in the 361
   * rollouts on the development machine. The turn-level `task_complete` says a
   * turn ended, not why the model yielded, and inferring one from "this
   * generation was followed by a tool call" would be callboard's inference
   * printed in an engine's column.
   */
  stopReason?: string | null;
  /**
   * Speed mode: "standard" or "fast". Anthropic-only — it comes off
   * `usage.speed` in the Claude Code JSONL, and no other engine has the
   * concept, let alone the field.
   */
  speed?: string;
  /** Inference geography hint from the API. Anthropic-only, as {@link speed}. */
  inferenceGeo?: string;
  /**
   * The **engine's own** request/response id, for support escalation. Claude
   * Code takes it from the JSONL line, Codex from the rollout's `turn_id`, pi
   * from the provider's `responseId`.
   *
   * Never synthesized. ACP mints no request id and neither does Cline, so this
   * stays unset for them and the panel's Req ID column shows a dash — an id
   * callboard invented would look like one a user could quote to a vendor.
   * Row *grouping* is a separate concern and uses {@link generationKey}.
   */
  requestId?: string;
  /**
   * Unique key identifying a single model generation within the responses
   * debug table. For Claude Code this equals `requestId` (every API call
   * already has its own id). A harness that reuses one `requestId` across all
   * intra-cycle turns needs its transcript parser to synthesise `generationKey`
   * as `"<requestId>/<turnNumber>"` instead, giving each generation a distinct
   * identity the debug panel can group on. Falls back to `requestId` when
   * absent.
   *
   * An **identity, not a datum** — which is what makes it the right home for an
   * engine that reports no id of its own. Codex uses `"<turnId>/<genIndex>"`,
   * pi `"pi:<sessionId>/<entryId>"` (its session entries *are* generations), and
   * ACP and Cline `"<engine>:<sessionId>/<turnIndex>"`, a positional key, since
   * a turn is the only granularity at which either reports usage. All four are
   * namespaced by session id because a chat's messages are the concatenation of
   * several session files, and a bare index would merge turn 0 of one with turn
   * 0 of the next into a single row.
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
