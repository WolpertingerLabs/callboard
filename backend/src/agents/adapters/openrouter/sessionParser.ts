/**
 * OpenRouter session parser — reads an OR session's on-disk state and
 * projects it into callboard's neutral {@link ParsedMessage} shape.
 *
 * The OR library splits a session's state across two locations:
 *
 * 1. `<logsRoot>/<sessionId>/state.json` — the local message log. Tracks
 *    everything the OR API server doesn't already have: assistant outputs
 *    (`type:"message"`), tool calls (`type:"function_call"`), tool results
 *    (`type:"function_call_output"`), and server-side tool items
 *    (`type:"openrouter:datetime"`, etc.). When the OR run uses
 *    `previousResponseId` chaining (the default), user prompts are NOT in
 *    `state.messages` — the OR server owns them.
 * 2. `<logsRoot>/<sessionId>/req_<X>/request.json` — one file per user turn,
 *    storing the raw prompt text and an ISO timestamp.
 *
 * To rebuild a viewable timeline we walk request.json files in chronological
 * order (the user-prompt timeline) and `state.messages` in array order (the
 * assistant timeline), interleaving them at "turn boundaries" — each
 * assistant `type:"message"` item ends a turn.
 *
 * State.json `messages[]` item shapes we know how to handle:
 *
 * - `{ role: "user" | "assistant" | "developer" | "system", content }` —
 *   "easy" input message; `content` is a string OR an array of content
 *   blocks (`{ type: "input_text"|"output_text", text }`, etc.).
 * - `{ type: "message", role: "assistant", content: [{ type: "output_text",
 *   text }, ...] }` — output message (assistant response).
 * - `{ type: "function_call", callId, name, arguments }` — assistant
 *   tool call. `arguments` is a JSON-encoded string.
 * - `{ type: "function_call_output", callId, output }` — the tool result
 *   for a prior `function_call`. `output` is a string or content-block
 *   array.
 * - `{ type: "reasoning", ... }` — reasoning trace (mapped to `thinking`).
 *
 * Unknown items are skipped silently — OR's schema is forward-compatible
 * with unrecognized item types, and so are we.
 *
 * @see plans/openrouter-adapter.md §7 (SessionProvider)
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ParsedMessage } from "shared/types/index.js";

/** Loose typing of the on-disk state.json — only the fields we read. */
interface RawState {
  id?: string;
  messages?: unknown[];
  previousResponseId?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** Loose typing of a request.json — only the fields we read. */
interface RawRequest {
  requestId?: string;
  timestamp?: string;
  prompt?: string;
}

/**
 * Per-generation metadata distilled from a gen_N/response.json file. Surfaced
 * through the parser onto each assistant ParsedMessage for the cycle so the
 * frontend can render token/cost/model/serviceTier lines.
 *
 * One cycle (one req_N dir) may persist multiple gen_N directories — one per
 * intra-cycle `response.completed` event plus the final `getResponse`. Each
 * represents a distinct model invocation that the responses debug table should
 * show as its own row.
 */
interface ResponseMeta {
  model?: string;
  requestId?: string;
  /**
   * Per-generation unique key for the responses debug table. Synthesised as
   * `"<reqDirName>/<genIndex>"` so that multiple generations within the same
   * cycle each get a distinct panel row. Matches the transcript parser's
   * `"<requestId>/<turnNumber>"` convention so both code paths produce the
   * same grouping semantics.
   */
  generationKey?: string;
  timestamp?: string;
  serviceTier?: string;
  inferenceGeo?: string;
  stopReason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    reasoning_tokens?: number;
  };
  costUsd?: number;
}

/**
 * Read an OR session directory and project it into ParsedMessage[]. This is
 * the function the SessionProvider should call — `parseOpenRouterState`
 * below is the lower-level primitive that ignores request.json files and
 * is kept for tests + post-compaction sessions where state.messages becomes
 * self-contained.
 */
export function readOpenRouterSession(sessionDir: string): ParsedMessage[] {
  if (!existsSync(sessionDir)) return [];
  const state = readStateJson(sessionDir);
  const cycles = readCycleEntries(sessionDir);
  const requests = cycles.map((c) => ({ prompt: c.prompt, timestamp: c.timestamp }));
  const responseMetas = cycles.map((c) => c.responseMeta);

  // Sessions without persisted requests (rare — perhaps post-compaction or
  // recovered from a backup) fall back to the state-only parser. Sessions
  // without state.json (e.g. construction-time error) are equally rare and
  // also fall back gracefully — readStateJson returns null and we just emit
  // the user prompts.
  if (cycles.length === 0) {
    return state ? parseOpenRouterState(state) : [];
  }

  const stateItems = Array.isArray(state?.messages) ? (state!.messages as unknown[]) : [];

  // Slice state.messages into "turns" — sequences ending at each assistant
  // `type:"message"` item. Most chats produce one assistant message per
  // turn; tool-using turns produce a function_call(s) + function_call_output
  // sequence before the final assistant text. Empty trailing items (a
  // turn that hasn't yet produced its final assistant message) become their
  // own group at the end.
  const turns: unknown[][] = [];
  let currentTurn: unknown[] = [];
  for (const item of stateItems) {
    currentTurn.push(item);
    if (isAssistantMessage(item)) {
      turns.push(currentTurn);
      currentTurn = [];
    }
  }
  if (currentTurn.length > 0) turns.push(currentTurn);

  // Interleave. Imbalance between request count and turn count is expected
  // at the edges (e.g. an in-flight final turn whose assistant message
  // hasn't landed yet, or an abort that left a request without a response).
  const result: ParsedMessage[] = [];
  const maxLen = Math.max(requests.length, turns.length);
  for (let i = 0; i < maxLen; i++) {
    const req = requests[i];
    if (req) {
      result.push({
        role: "user",
        type: "text",
        content: req.prompt,
        ...(req.timestamp && { timestamp: req.timestamp }),
      });
    }
    const turn = turns[i];
    if (turn) {
      const meta = responseMetas[i];
      for (const item of turn) {
        const parsed = translateItem(item, () => undefined);
        if (parsed) {
          for (const m of parsed) {
            // Decorate ASSISTANT-side items with the cycle's response
            // metadata. Tool results (role: "user", type: "tool_result")
            // are part of the conversation but not API responses
            // themselves — they get no meta so the frontend doesn't
            // render misleading "Tokens: …" lines on tool-result rows.
            if (meta && m.role === "assistant") applyMeta(m, meta);
            result.push(m);
          }
        }
      }
    }
  }
  return result;
}

/** Attach per-generation response metadata to an assistant ParsedMessage in-place. */
function applyMeta(m: ParsedMessage, meta: ResponseMeta): void {
  if (meta.model && !m.model) m.model = meta.model;
  if (meta.requestId && !m.requestId) m.requestId = meta.requestId;
  if (meta.generationKey && !m.generationKey) m.generationKey = meta.generationKey;
  if (meta.timestamp && !m.timestamp) m.timestamp = meta.timestamp;
  if (meta.serviceTier && !m.serviceTier) m.serviceTier = meta.serviceTier;
  if (meta.inferenceGeo && !m.inferenceGeo) m.inferenceGeo = meta.inferenceGeo;
  if (meta.stopReason !== undefined && m.stopReason === undefined) m.stopReason = meta.stopReason;
  if (meta.costUsd !== undefined && m.costUsd === undefined) m.costUsd = meta.costUsd;
  if (meta.usage && !m.usage) m.usage = { ...meta.usage };
}

function isAssistantMessage(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const obj = item as { type?: unknown; role?: unknown };
  return obj.type === "message" && obj.role === "assistant";
}

interface CycleEntry {
  prompt: string;
  timestamp?: string;
  responseMeta?: ResponseMeta;
}

/**
 * Walk `req_<id>/` directories in chronological order; for each, read the
 * user prompt out of `request.json` and the canonical response metadata
 * out of the latest `gen_<id>/response.json`. Cycles whose `request.json`
 * is missing or malformed are skipped; cycles without a `response.json`
 * yet (in-flight, aborted before model traffic) keep `responseMeta`
 * undefined so the parser can still emit the user prompt.
 */
function readCycleEntries(sessionDir: string): CycleEntry[] {
  if (!existsSync(sessionDir)) return [];
  let entries;
  try {
    entries = readdirSync(sessionDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const reqDirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("req_"))
    .map((e) => {
      const full = join(sessionDir, e.name);
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        /* unreadable — skip */
      }
      return { name: e.name, dir: full, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime);

  const result: CycleEntry[] = [];
  for (const { name, dir } of reqDirs) {
    let raw: RawRequest;
    try {
      raw = JSON.parse(readFileSync(join(dir, "request.json"), "utf-8")) as RawRequest;
    } catch {
      /* request.json missing or malformed — skip this cycle entirely */
      continue;
    }
    if (typeof raw.prompt !== "string") continue;

    const cycle: CycleEntry = {
      prompt: raw.prompt,
      ...(typeof raw.timestamp === "string" && { timestamp: raw.timestamp }),
    };
    const responseMeta = readLatestResponseMeta(dir, name);
    if (responseMeta) cycle.responseMeta = responseMeta;
    result.push(cycle);
  }
  return result;
}

/**
 * Locate the latest `<reqDir>/gen_N/response.json` by mtime (usage rolls
 * forward across intra-cycle turns) and translate the raw OR response
 * envelope into our ResponseMeta shape. Returns `undefined` when no
 * response.json exists yet (the cycle is in-flight or aborted before
 * model traffic).
 *
 * `requestIdFromDirName` is the req dir name (`req_<uuid>`) — used as the
 * `requestId` on the returned meta. A `generationKey` equal to `requestId`
 * is also set so that legacy sessions surface a consistent key in the
 * debug panel (matching Claude rows that use `requestId` as their key).
 */
function readLatestResponseMeta(reqDir: string, requestIdFromDirName: string): ResponseMeta | undefined {
  let genDirs;
  try {
    genDirs = readdirSync(reqDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("gen_"))
      .map((e) => {
        const full = join(reqDir, e.name);
        let mtime = 0;
        try {
          mtime = statSync(full).mtimeMs;
        } catch {
          /* unreadable — sort first; treat as oldest */
        }
        return { dir: full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime); // latest first
  } catch {
    return undefined;
  }
  for (const { dir } of genDirs) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, "response.json"), "utf-8")) as {
        timestamp?: string;
        response?: Record<string, unknown>;
      };
      const meta = extractResponseMeta(raw, requestIdFromDirName);
      if (meta) {
        // Set generationKey = requestId for legacy sessions so the debug
        // panel gets a consistent grouping field without needing to fall
        // back to the raw requestId (which also works — this is additive).
        if (!meta.generationKey) meta.generationKey = meta.requestId;
        return meta;
      }
    } catch {
      /* malformed — try the next-newest gen */
    }
  }
  return undefined;
}

/**
 * Distill an OR `response.json` envelope (the on-disk shape written by
 * `logGeneration`: `{ sessionId, requestId, generationId, response,
 * timestamp }`) into the ResponseMeta we attach onto ParsedMessages.
 *
 * The inner `response` is a raw `OpenResponsesResult` from `@openrouter/sdk`
 * (see `@openrouter/sdk/models/openresponsesresult.d.ts`) — we read it as
 * loosely-typed JSON so the parser doesn't take a hard dep on the SDK
 * runtime schema and stays forward-compatible with shape additions.
 *
 * Returns `undefined` if the envelope has no usable response payload.
 */
function extractResponseMeta(
  envelope: { timestamp?: string; response?: Record<string, unknown> },
  requestIdFromDirName: string,
): ResponseMeta | undefined {
  const response = envelope.response;
  if (!response || typeof response !== "object") return undefined;

  const meta: ResponseMeta = { requestId: requestIdFromDirName };
  if (typeof envelope.timestamp === "string") meta.timestamp = envelope.timestamp;

  if (typeof response.model === "string") meta.model = response.model;
  if (typeof response.serviceTier === "string") meta.serviceTier = response.serviceTier;

  // OpenRouterMetadata.region carries the inference geo (the region the
  // routed-to endpoint actually ran in). Treat empty string / null the
  // same as missing so we don't render "Geo: -" style noise.
  const orMeta = response.openrouterMetadata;
  if (orMeta && typeof orMeta === "object") {
    const region = (orMeta as { region?: unknown }).region;
    if (typeof region === "string" && region.length > 0) meta.inferenceGeo = region;
  }

  // Stop reason: prefer the precise `incompleteDetails.reason` when the
  // run was cut short (matches Claude's `max_tokens` / `content_filter`
  // semantics); otherwise project the lifecycle status. "completed"
  // becomes "end_turn" for parity with Claude's display.
  const status = typeof response.status === "string" ? response.status : undefined;
  const incomplete = response.incompleteDetails;
  let incompleteReason: string | undefined;
  if (incomplete && typeof incomplete === "object") {
    const r = (incomplete as { reason?: unknown }).reason;
    if (typeof r === "string") incompleteReason = r;
  }
  if (incompleteReason) {
    meta.stopReason = incompleteReason;
  } else if (status === "completed") {
    meta.stopReason = "end_turn";
  } else if (status) {
    meta.stopReason = status;
  }

  const usage = response.usage;
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    const inputTokens = typeof u.inputTokens === "number" ? u.inputTokens : undefined;
    const outputTokens = typeof u.outputTokens === "number" ? u.outputTokens : undefined;
    const inputDetails = u.inputTokensDetails as { cachedTokens?: unknown } | undefined;
    const cachedTokens =
      inputDetails && typeof inputDetails.cachedTokens === "number"
        ? inputDetails.cachedTokens
        : undefined;
    const outputDetails = u.outputTokensDetails as { reasoningTokens?: unknown } | undefined;
    const reasoningTokens =
      outputDetails && typeof outputDetails.reasoningTokens === "number"
        ? outputDetails.reasoningTokens
        : undefined;
    const cost = typeof u.cost === "number" ? u.cost : undefined;

    const usageOut: NonNullable<ResponseMeta["usage"]> = {};
    if (inputTokens !== undefined) {
      // OR reports `inputTokens` as the TOTAL input (cached + fresh). The
      // Claude-side convention surfaced through MessageBubble is "in" =
      // fresh input + "cache read" shown separately. Subtract so the
      // numbers add up to the right total and the cache-hit story reads
      // naturally next to Claude rows. Clamp at 0 in case cachedTokens
      // exceeds inputTokens (shouldn't happen, but defends against
      // upstream accounting drift).
      const fresh = cachedTokens !== undefined ? Math.max(0, inputTokens - cachedTokens) : inputTokens;
      usageOut.input_tokens = fresh;
    }
    if (outputTokens !== undefined) usageOut.output_tokens = outputTokens;
    if (cachedTokens !== undefined) usageOut.cache_read_input_tokens = cachedTokens;
    if (reasoningTokens !== undefined && reasoningTokens > 0) usageOut.reasoning_tokens = reasoningTokens;
    if (Object.keys(usageOut).length > 0) meta.usage = usageOut;

    if (cost !== undefined) meta.costUsd = cost;
  }

  return meta;
}

/**
 * Read state.json (if present) and translate its messages into
 * ParsedMessage[]. Returns [] for sessions with no state on disk
 * (in-memory runs, or sessions that errored before the first save).
 *
 * `timestamps` is an optional ordered list of ISO timestamps from each
 * request.json in the session directory; the parser interleaves them onto
 * user / first-assistant messages as a best-effort decoration. When omitted,
 * messages carry no per-row timestamp (matches the Claude provider's
 * behavior for sessions whose JSONL entries lack `timestamp`).
 */
export function parseOpenRouterState(
  state: RawState,
  timestamps: string[] = [],
): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  const items = Array.isArray(state.messages) ? state.messages : [];
  let userTurnIndex = 0;
  for (const item of items) {
    const parsed = translateItem(item, () => timestamps[userTurnIndex]);
    if (!parsed) continue;
    for (const m of parsed) {
      messages.push(m);
      if (m.role === "user" && m.type === "text") userTurnIndex++;
    }
  }
  return messages;
}

function translateItem(
  item: unknown,
  nextTimestamp: () => string | undefined,
): ParsedMessage[] | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : undefined;
  const role = typeof obj.role === "string" ? obj.role : undefined;

  // Function call (assistant tool_use)
  if (type === "function_call") {
    const callId = typeof obj.callId === "string" ? obj.callId : undefined;
    const name = typeof obj.name === "string" ? obj.name : "<unknown>";
    const args = typeof obj.arguments === "string" ? obj.arguments : "";
    return [{ role: "assistant", type: "tool_use", toolName: name, content: args, ...(callId && { toolUseId: callId }) }];
  }

  // Function call output (tool result, surfaced as user-role in the
  // ParsedMessage union for parity with Claude's tool_use → tool_result
  // pairing).
  if (type === "function_call_output") {
    const callId = typeof obj.callId === "string" ? obj.callId : undefined;
    const content = extractTextContent(obj.output);
    return [{ role: "user", type: "tool_result", content, ...(callId && { toolUseId: callId }) }];
  }

  // OpenRouter server-side tools (e.g. `openrouter:datetime`,
  // `openrouter:web_search`, `openrouter:web_fetch`). These items carry both
  // the invocation AND the result inline — OR's server executed the tool
  // and persisted the result back into state.messages without a preceding
  // `function_call`. Synthesize a tool_use/tool_result pair so the UI
  // renders them the same way as client-side tool calls.
  if (type && type.startsWith("openrouter:")) {
    const toolName = type.slice("openrouter:".length);
    const id = typeof obj.id === "string" ? obj.id : undefined;
    // The result payload is whatever non-shape fields the item carries —
    // for `datetime` that's `{ datetime, timezone }`; for `web_search`
    // that's a results array; etc. Skip the standard envelope keys.
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k !== "type" && k !== "id" && k !== "status") payload[k] = v;
    }
    const resultContent = Object.keys(payload).length === 0 ? "" : JSON.stringify(payload);
    return [
      {
        role: "assistant",
        type: "tool_use",
        toolName,
        // The model's input args aren't preserved by OR's server-side
        // tools — we don't know what query was passed to web_search, for
        // example. Show an empty object rather than fabricating.
        content: "{}",
        ...(id && { toolUseId: id }),
      },
      {
        role: "user",
        type: "tool_result",
        content: resultContent,
        ...(id && { toolUseId: id }),
      },
    ];
  }

  // Reasoning trace → thinking
  if (type === "reasoning") {
    const content = extractTextContent(obj.summary ?? obj.content);
    if (!content) return null;
    return [{ role: "assistant", type: "thinking", content }];
  }

  // Output message (assistant) — explicit type=message form
  if (type === "message" && role === "assistant") {
    const content = extractTextContent(obj.content);
    if (!content) return null;
    return [{ role: "assistant", type: "text", content }];
  }

  // Easy input message: { role, content } with no `type` field, or with
  // type: "message" on the input side. Role drives projection.
  if (role === "user" || role === "developer" || role === "system") {
    const content = extractTextContent(obj.content);
    if (!content) return null;
    // Only consume a request-timestamp slot for actual user turns —
    // developer / system messages are protocol-internal (compaction
    // summaries, injected context) and don't correspond to a
    // req_<id>/request.json entry. Stamping them with a future user
    // request's timestamp produces misordered timeline UI.
    const ts = role === "user" ? nextTimestamp() : undefined;
    return [
      {
        role: role === "user" ? "user" : "system",
        type: "text",
        content,
        ...(ts && { timestamp: ts }),
      },
    ];
  }
  if (role === "assistant") {
    const content = extractTextContent(obj.content);
    if (!content) return null;
    return [{ role: "assistant", type: "text", content }];
  }

  return null;
}

/**
 * Best-effort extraction of a displayable string from the various content
 * shapes the OR/OpenAI schema permits:
 *  - plain string → as-is
 *  - array of blocks → concatenate text-bearing blocks
 *  - object with `.text` → that text
 * Anything else falls through to JSON.stringify (or empty string for null).
 */
export function extractTextContent(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (!block || typeof block !== "object") return "";
        const b = block as Record<string, unknown>;
        if (typeof b.text === "string") return b.text;
        if (b.type === "input_image" || b.type === "image") return "[image]";
        if (b.type === "input_file" || b.type === "file") return "[file]";
        return "";
      })
      .filter((s) => s.length > 0)
      // Newline-join multi-block text — matches Claude's behavior in
      // claude-code/sessionParser.ts. Empty-string-join silently fuses
      // adjacent text segments into unreadable single lines.
      .join("\n");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
  }
  try {
    // JSON.stringify silently returns `undefined` (not a throw) for
    // Symbol / function / top-level-undefined values. Fall back to
    // String() in that case so the declared `string` return holds —
    // same pattern as messageAdapter.ts:stringifyOutput.
    const json = JSON.stringify(content);
    if (json === undefined) return String(content);
    return json;
  } catch {
    return String(content);
  }
}

/**
 * Walk `<sessionDir>/req_*` directories in chronological order (by mtime
 * since OR's request IDs are random ULIDs, not sortable) and collect their
 * recorded ISO timestamps. Used by parseOpenRouterState to decorate user
 * messages with when the request was issued.
 */
export function readRequestTimestamps(sessionDir: string): string[] {
  if (!existsSync(sessionDir)) return [];
  try {
    const entries = readdirSync(sessionDir, { withFileTypes: true });
    const reqDirs = entries
      .filter((e) => e.isDirectory() && e.name.startsWith("req_"))
      .map((e) => {
        const full = join(sessionDir, e.name);
        let mtime = 0;
        try {
          mtime = statSync(full).mtimeMs;
        } catch {
          /* unreadable — skip */
        }
        return { dir: full, mtime };
      })
      .sort((a, b) => a.mtime - b.mtime);

    const timestamps: string[] = [];
    for (const { dir } of reqDirs) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, "request.json"), "utf-8")) as RawRequest;
        if (typeof raw.timestamp === "string") timestamps.push(raw.timestamp);
      } catch {
        /* request.json missing or malformed — skip this request */
      }
    }
    return timestamps;
  } catch {
    return [];
  }
}

/**
 * Read and parse a session's state.json. Returns `null` when the file is
 * missing (in-memory session, or session created but never persisted).
 */
export function readStateJson(sessionDir: string): RawState | null {
  const path = join(sessionDir, "state.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as RawState;
  } catch {
    return null;
  }
}

/**
 * Read and return the first user prompt for this session — pulled from the
 * earliest `req_<id>/request.json`. Used for the chat-list preview.
 */
export function readFirstUserPrompt(sessionDir: string): string | null {
  if (!existsSync(sessionDir)) return null;
  try {
    const entries = readdirSync(sessionDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("req_"))
      .map((e) => {
        const full = join(sessionDir, e.name);
        let mtime = 0;
        try {
          mtime = statSync(full).mtimeMs;
        } catch {
          /* unreadable — skip */
        }
        return { dir: full, mtime };
      })
      .sort((a, b) => a.mtime - b.mtime);
    if (entries.length === 0) return null;
    const raw = JSON.parse(readFileSync(join(entries[0]!.dir, "request.json"), "utf-8")) as RawRequest;
    return typeof raw.prompt === "string" ? raw.prompt : null;
  } catch {
    return null;
  }
}
