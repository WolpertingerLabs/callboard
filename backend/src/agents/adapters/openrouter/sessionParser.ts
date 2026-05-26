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
 * Read an OR session directory and project it into ParsedMessage[]. This is
 * the function the SessionProvider should call — `parseOpenRouterState`
 * below is the lower-level primitive that ignores request.json files and
 * is kept for tests + post-compaction sessions where state.messages becomes
 * self-contained.
 */
export function readOpenRouterSession(sessionDir: string): ParsedMessage[] {
  if (!existsSync(sessionDir)) return [];
  const state = readStateJson(sessionDir);
  const requests = readRequestEntries(sessionDir);

  // Sessions without persisted requests (rare — perhaps post-compaction or
  // recovered from a backup) fall back to the state-only parser. Sessions
  // without state.json (e.g. construction-time error) are equally rare and
  // also fall back gracefully — readStateJson returns null and we just emit
  // the user prompts.
  if (requests.length === 0) {
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
      for (const item of turn) {
        const parsed = translateItem(item, () => undefined);
        if (parsed) result.push(...parsed);
      }
    }
  }
  return result;
}

function isAssistantMessage(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const obj = item as { type?: unknown; role?: unknown };
  return obj.type === "message" && obj.role === "assistant";
}

/** Walk `req_<id>/request.json` files in chronological order; return each prompt + timestamp. */
function readRequestEntries(sessionDir: string): Array<{ prompt: string; timestamp?: string }> {
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
      return { dir: full, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime);

  const result: Array<{ prompt: string; timestamp?: string }> = [];
  for (const { dir } of reqDirs) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, "request.json"), "utf-8")) as RawRequest;
      if (typeof raw.prompt === "string") {
        result.push({
          prompt: raw.prompt,
          ...(typeof raw.timestamp === "string" && { timestamp: raw.timestamp }),
        });
      }
    } catch {
      /* request.json missing or malformed — skip this request */
    }
  }
  return result;
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
