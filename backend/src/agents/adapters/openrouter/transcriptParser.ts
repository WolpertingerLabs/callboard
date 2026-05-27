/**
 * Transcript-based session reader for the OpenRouter adapter.
 *
 * The `openrouter-agent-coder` library writes an append-only JSONL side-car
 * at `<logsRoot>/<sessionId>/transcript.jsonl` containing every user-visible
 * record (`session_start`, `user`, `assistant`, `tool_result`, `compact`,
 * `session_end`) with per-record timestamps, post-routing model names,
 * token usage, cost, and turn durations. This file is the canonical
 * user-visible view of an OR session.
 *
 * `readOpenRouterTranscript` opens the file synchronously, line-parses it,
 * and projects each {@link TranscriptRecord} into the neutral
 * {@link ParsedMessage} timeline the rest of callboard consumes. Sessions
 * persisted before the transcript landed (or those started with
 * `persistSession: false` for utility flows) have no transcript file —
 * callers fall back to {@link readOpenRouterSession} (state.json plus the
 * req_*&#47;gen_* tree) for those.
 *
 * @see ../../../node_modules/@cybourgeoisie/openrouter-agent-coder/dist/logging/transcript.d.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ParsedMessage } from "shared/types/index.js";
import { extractTextContent } from "./sessionParser.js";

/** Subset of TranscriptRecord fields we read. Mirrors the OR library's schema
 *  loosely so we tolerate forward-compatible field additions without a
 *  hard runtime dep on the SDK type. Lines whose `v` we don't understand
 *  are skipped silently — same shape as the OR library's own
 *  `readTranscript()` does.
 */
interface RawRecord {
  v?: unknown;
  sessionId?: unknown;
  ts?: unknown;
  kind?: unknown;
  // assistant
  turnNumber?: unknown;
  requestId?: unknown;
  model?: unknown;
  text?: unknown;
  reasoning?: unknown;
  toolCalls?: unknown;
  usage?: unknown;
  costUsd?: unknown;
  durationMs?: unknown;
  // tool_result
  callId?: unknown;
  name?: unknown;
  isError?: unknown;
  output?: unknown;
  // compact
  reason?: unknown;
  droppedMessages?: unknown;
  summaryText?: unknown;
}

const SUPPORTED_SCHEMA_VERSION = 1;

/**
 * Read `<sessionDir>/transcript.jsonl` if it exists and project every record
 * into a {@link ParsedMessage} timeline. Returns `null` when the file is
 * absent (caller should fall back to the state.json-based parser);
 * returns an empty array when the file exists but contains only records
 * we don't render (e.g. session_start / session_end).
 *
 * Sync I/O: each transcript is one record per turn, so a multi-thousand-turn
 * chat is still tens of KB. The route handler that calls this is sync
 * end-to-end (see `chats.ts:GET /:id/messages` → `parseSessionMessages`),
 * so streaming would require interface-wide async churn for no real-world
 * benefit at current sizes.
 */
export function readOpenRouterTranscript(sessionDir: string): ParsedMessage[] | null {
  const path = join(sessionDir, "transcript.jsonl");
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // File present but unreadable — treat as absent so caller can fall back.
    // Other failure modes (permissions, mid-write truncation) shouldn't
    // wedge the entire chat view.
    return null;
  }

  const messages: ParsedMessage[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let rec: RawRecord;
    try {
      rec = JSON.parse(line) as RawRecord;
    } catch {
      // Skip malformed lines — the OR library's reader does the same, and
      // a partial mid-write line shouldn't break the whole timeline.
      continue;
    }
    if (rec.v !== SUPPORTED_SCHEMA_VERSION) continue;
    const ts = typeof rec.ts === "string" ? rec.ts : undefined;
    const kind = rec.kind;
    if (kind === "user") {
      const text = typeof rec.text === "string" ? rec.text : "";
      messages.push({
        role: "user",
        type: "text",
        content: text,
        ...(ts && { timestamp: ts }),
      });
    } else if (kind === "assistant") {
      messages.push(...translateAssistantRecord(rec, ts));
    } else if (kind === "tool_result") {
      const callId = typeof rec.callId === "string" ? rec.callId : undefined;
      const name = typeof rec.name === "string" ? rec.name : "";
      const content = stringifyToolOutput(rec.output);
      messages.push({
        role: "user",
        type: "tool_result",
        content,
        ...(ts && { timestamp: ts }),
        ...(callId && { toolUseId: callId }),
        // OR's defensive fallback writes `name: ""` when the matching
        // function_call item wasn't observed. Omit toolName entirely in
        // that case so MessageBubble's "Tool result" header doesn't render
        // a stray empty label.
        ...(name && { toolName: name }),
      });
    } else if (kind === "compact") {
      // Mirror the Claude provider's compact_boundary projection so the
      // UI can render the boundary line the same way regardless of
      // provider. summaryText is preserved as the message content for
      // post-compact diagnostics.
      const summary = typeof rec.summaryText === "string" ? rec.summaryText : "";
      messages.push({
        role: "system",
        type: "system",
        subtype: "compact_boundary",
        content: summary,
        ...(ts && { timestamp: ts }),
      });
    }
    // session_start / session_end carry only run-level metadata (cwd,
    // status totals). Not user-facing per-message data — skip.
  }
  return messages;
}

/**
 * Expand a single `assistant` transcript record into the per-block
 * ParsedMessage sequence the UI expects: reasoning → tool_use(s) → text.
 *
 * Per-cycle metadata (model, usage, costUsd, durationMs, requestId, ts) is
 * attached to whichever assistant-role message will be the last one in the
 * sequence — typically the final text, but for tool-only turns (no `text`)
 * it lands on the last tool_use so the "Tokens / Cost / Duration" line
 * stays visible. Reasoning carries timestamp only; per-token usage on
 * reasoning would duplicate the figures shown on the turn's main row.
 */
function translateAssistantRecord(rec: RawRecord, ts: string | undefined): ParsedMessage[] {
  const out: ParsedMessage[] = [];

  const reasoning = typeof rec.reasoning === "string" ? rec.reasoning : "";
  if (reasoning) {
    out.push({
      role: "assistant",
      type: "thinking",
      content: reasoning,
      ...(ts && { timestamp: ts }),
    });
  }

  const toolCalls = Array.isArray(rec.toolCalls) ? rec.toolCalls : [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const t = tc as { callId?: unknown; name?: unknown; input?: unknown };
    const callId = typeof t.callId === "string" ? t.callId : undefined;
    const name = typeof t.name === "string" ? t.name : "<unknown>";
    // The transcript records `input` as the structured tool args; the rest
    // of callboard expects tool_use `content` as the JSON-stringified args
    // (matching what state.json's function_call.arguments holds). Stringify
    // here so MessageBubble's getToolSummary regex parsing works
    // unchanged.
    const argsJson = stringifyToolInput(t.input);
    out.push({
      role: "assistant",
      type: "tool_use",
      toolName: name,
      content: argsJson,
      ...(ts && { timestamp: ts }),
      ...(callId && { toolUseId: callId }),
    });
  }

  const text = typeof rec.text === "string" ? rec.text : "";
  if (text) {
    out.push({
      role: "assistant",
      type: "text",
      content: text,
      ...(ts && { timestamp: ts }),
    });
  }

  // Attach per-cycle metadata to the last assistant-role item — that's
  // where users look for "what just happened in this turn" details.
  // If the turn produced no items (text empty AND no tool calls AND no
  // reasoning) we emit nothing; the UI will show a gap, but that's a
  // truthful representation of an empty model response.
  if (out.length > 0) {
    applyAssistantMeta(out[out.length - 1]!, rec);
  }
  return out;
}

function applyAssistantMeta(m: ParsedMessage, rec: RawRecord): void {
  if (typeof rec.model === "string" && rec.model.length > 0) m.model = rec.model;
  if (typeof rec.requestId === "string" && rec.requestId.length > 0) m.requestId = rec.requestId;
  if (typeof rec.costUsd === "number") m.costUsd = rec.costUsd;
  if (typeof rec.durationMs === "number") m.durationMs = rec.durationMs;

  const usage = rec.usage;
  if (usage && typeof usage === "object") {
    const u = usage as { prompt?: unknown; completion?: unknown; reasoning?: unknown; cached?: unknown };
    const out: NonNullable<ParsedMessage["usage"]> = {};
    if (typeof u.prompt === "number") {
      // The transcript records `prompt` as the TOTAL input (cached + fresh)
      // to match the OpenAI/OR API shape. Subtract cached so the
      // displayed "in" number is the fresh-input portion — matches the
      // accounting convention applied in sessionParser.ts (cached are
      // surfaced separately as "cache read"). Clamp at 0 against upstream
      // accounting drift.
      const cached = typeof u.cached === "number" ? u.cached : 0;
      out.input_tokens = Math.max(0, u.prompt - cached);
      if (cached > 0) out.cache_read_input_tokens = cached;
    }
    if (typeof u.completion === "number") out.output_tokens = u.completion;
    if (typeof u.reasoning === "number" && u.reasoning > 0) out.reasoning_tokens = u.reasoning;
    if (Object.keys(out).length > 0) m.usage = out;
  }
}

/**
 * Best-effort JSON-stringify a `tool_call.input` for storage as the
 * `tool_use` ParsedMessage `content`. The OR transcript records input as
 * the structured object; consumers downstream (MessageBubble's
 * getToolSummary) parse it back out, so JSON form is the round-trip
 * format.
 */
function stringifyToolInput(input: unknown): string {
  if (input === null || input === undefined) return "{}";
  if (typeof input === "string") return input;
  try {
    const json = JSON.stringify(input);
    return json ?? "{}";
  } catch {
    return "{}";
  }
}

/**
 * Tool output extraction: the transcript records `output` as whatever the
 * tool returned — a string, an object, an array, or null. Project it onto
 * a single display string using the same shape-tolerant rules
 * sessionParser.ts uses for state.json's `function_call_output`.
 */
function stringifyToolOutput(output: unknown): string {
  if (output === null || output === undefined) return "";
  if (typeof output === "string") return output;
  // For structured outputs, route through the shared content extractor
  // so content-block arrays render the same way they do for state.json-
  // derived tool results.
  const extracted = extractTextContent(output);
  if (extracted) return extracted;
  try {
    const json = JSON.stringify(output);
    return json ?? String(output);
  } catch {
    return String(output);
  }
}
