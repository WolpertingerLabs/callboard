/**
 * OpenRouter session parser — reads an OR session's on-disk state and
 * projects it into callboard's neutral {@link ParsedMessage} shape.
 *
 * Source of truth is `<logsRoot>/<sessionId>/state.json`, which the OR
 * library writes via `createFileStateAccessor`. It carries the full
 * `ConversationState.messages` array (every user / assistant / tool call /
 * tool result the run produced). Per-request `request.json` files supply
 * timestamps the in-memory state doesn't track.
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
    const ts = nextTimestamp();
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
      .join("");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
  }
  try {
    return JSON.stringify(content);
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
