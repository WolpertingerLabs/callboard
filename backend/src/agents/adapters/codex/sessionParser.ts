/**
 * Codex session parser — reads a Codex CLI "rollout" file and projects it into
 * callboard's neutral {@link ParsedMessage} shape.
 *
 * **One file == one thread.** The Codex CLI writes a single JSONL "rollout" per
 * thread at
 *
 *     $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO-with-dashes>-<thread_id>.jsonl
 *
 * and a resumed turn APPENDS to that same file (spike §5 — no fork/copy). The
 * trailing UUID in the filename is the `thread_id`, identical to the id from the
 * `thread.started` event and the value passed to `resumeThread`. callboard uses
 * that thread_id as the session id.
 *
 * The rollout is a distinct, undocumented format from the SDK event stream — do
 * NOT reuse `messageAdapter` here. Each line is a `{ type, payload, timestamp? }`
 * record. The line `type`s we read:
 *
 *  - `session_meta` (line 1) — `payload:{ id, timestamp, cwd, cli_version,
 *    base_instructions:{text} }`. Source of the session id, working folder, and
 *    the `cli_version` we version-gate on (spike risk #4 — format may drift).
 *  - `response_item` — the durable transcript. `payload.type`:
 *    - `"message"` (`role: "user"|"assistant"|"developer"|"system"`,
 *      `content:[{type:"input_text"|"output_text", text}]`) → text.
 *      The **first two messages are synthetic** (a `developer`
 *      "<permissions instructions>" and a `user` "<environment_context>") and are
 *      filtered out — the real user prompt is the next `user` message.
 *    - `"function_call"` / `"custom_tool_call"` → `tool_use`
 *      (`commandExecution`/`fileChange`/`mcpToolCall` all serialize through these
 *      Responses-API item shapes in the rollout).
 *    - `"function_call_output"` / `"custom_tool_call_output"` → `tool_result`.
 *    - `"reasoning"` → `thinking`.
 *
 * Unknown line/item types are skipped silently — the rollout schema is
 * forward-compatible with additions, and so are we.
 *
 * @see plans/codex-adapter-job.md (Step 9 session-provider)
 * @see plans/codex-spike-findings.md §5 (rollout format)
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedMessage } from "shared/types/index.js";
import { getAgentSettings } from "../../../services/agent-settings.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("codex-session-parser");

/**
 * The Codex CLI version this parser was written against (spike §1). The rollout
 * format is undocumented and version-dependent; when a rollout's
 * `session_meta.cli_version` differs we log once so a future format drift is
 * diagnosable rather than silently mis-parsed (spike risk #4).
 */
export const EXPECTED_CODEX_CLI_VERSION = "0.139.0";

/** Synthetic lead messages the Codex CLI injects ahead of the real transcript. */
const SYNTHETIC_MESSAGE_PREFIXES = ["<permissions", "<environment_context", "<user_instructions"];

let warnedVersionDrift = false;

// ── Home / sessions-root resolution ─────────────────────────────────

/**
 * Resolve `$CODEX_HOME` the same way the write side does (`getApiEnvOverrides`
 * injects `CODEX_HOME` into the Codex subprocess env). Keeping the read side in
 * lockstep means callboard lists exactly the sessions the CLI wrote.
 *
 * Resolution order (first match wins):
 *   1. `getAgentSettings().codexHome` if set
 *   2. `$CODEX_HOME` env if set
 *   3. `<os.homedir()>/.codex` (the CLI default)
 */
export function resolveCodexHome(): string {
  const fromSettings = getAgentSettings().codexHome?.trim();
  if (fromSettings) return fromSettings;
  const env = process.env.CODEX_HOME?.trim();
  if (env) return env;
  return join(homedir(), ".codex");
}

/** The dated-tree root the rollout files live under: `$CODEX_HOME/sessions`. */
export function resolveCodexSessionsRoot(): string {
  return join(resolveCodexHome(), "sessions");
}

// ── Filename / thread-id helpers ────────────────────────────────────

/**
 * Match a rollout filename and pull out the trailing `thread_id` UUID. The
 * filename embeds BOTH an ISO timestamp (with `:` rewritten to `-`) and the
 * thread UUID, so a naive split on `-` is ambiguous — anchor on the canonical
 * 8-4-4-4-12 hex UUID at the end instead.
 *
 *   rollout-2026-06-14T17-03-58-019ec7f2-cd5d-7823-b2d1-6683c42bfe32.jsonl
 *                                └──────────────── thread_id ───────────┘
 */
const ROLLOUT_FILENAME_RE =
  /^rollout-.*-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

export function extractThreadIdFromFilename(filename: string): string | null {
  const m = ROLLOUT_FILENAME_RE.exec(filename);
  return m ? m[1]! : null;
}

// ── Raw line shapes (only the fields we read) ───────────────────────

interface RolloutLine {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

interface SessionMeta {
  id?: string;
  cwd?: string;
  timestamp?: string;
  cliVersion?: string;
}

/**
 * Read + parse a rollout file into `{ type, payload }` line records, dropping
 * blank/malformed lines. Returns `[]` for a missing/unreadable file.
 */
function readRolloutLines(filePath: string): RolloutLine[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const lines: RolloutLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed) as RolloutLine);
    } catch {
      /* skip a torn / partially-written line */
    }
  }
  return lines;
}

/**
 * Read just the `session_meta` (first matching line) of a rollout. Used by the
 * provider for discovery (folder, sort timestamp) and id resolution without
 * parsing the whole transcript.
 */
export function readCodexSessionMeta(filePath: string): SessionMeta | null {
  for (const line of readRolloutLines(filePath)) {
    if (line.type !== "session_meta") continue;
    const p = line.payload ?? {};
    const meta: SessionMeta = {};
    if (typeof p.id === "string") meta.id = p.id;
    if (typeof p.cwd === "string") meta.cwd = p.cwd;
    if (typeof p.timestamp === "string") meta.timestamp = p.timestamp;
    if (typeof p.cli_version === "string") meta.cliVersion = p.cli_version;
    checkCliVersion(meta.cliVersion);
    return meta;
  }
  return null;
}

/** Warn once if a rollout was written by a Codex CLI version we don't target. */
function checkCliVersion(cliVersion: string | undefined): void {
  if (warnedVersionDrift || !cliVersion || cliVersion === EXPECTED_CODEX_CLI_VERSION) return;
  warnedVersionDrift = true;
  log.warn(
    `Codex rollout cli_version=${cliVersion} differs from the version this parser targets ` +
      `(${EXPECTED_CODEX_CLI_VERSION}); session parsing may be lossy if the rollout format drifted.`,
  );
}

// ── Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a Codex rollout file into ParsedMessage[]. The provider calls this for
 * each session id in a (possibly resumed) chat. Thin by design — the rollout
 * format is undocumented (spike §5), so we translate only the well-understood
 * line/item types and skip the rest.
 */
export function parseCodexRollout(filePath: string): ParsedMessage[] {
  const lines = readRolloutLines(filePath);
  const messages: ParsedMessage[] = [];
  // Version-gate off the meta line even when a caller skips readCodexSessionMeta.
  const meta = lines.find((l) => l.type === "session_meta");
  if (meta) checkCliVersion(typeof meta.payload?.cli_version === "string" ? meta.payload.cli_version : undefined);

  for (const line of lines) {
    if (line.type !== "response_item") continue;
    const parsed = translateResponseItem(line.payload, line.timestamp);
    if (parsed) messages.push(parsed);
  }
  return messages;
}

/**
 * Translate one `response_item` payload into a ParsedMessage, or `null` to drop
 * it (synthetic lead messages, empty content, unhandled item types).
 */
function translateResponseItem(
  payload: Record<string, unknown> | undefined,
  timestamp: string | undefined,
): ParsedMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const itemType = typeof payload.type === "string" ? payload.type : undefined;
  const ts = typeof timestamp === "string" ? timestamp : undefined;

  switch (itemType) {
    case "message":
      return translateMessage(payload, ts);

    // Assistant tool invocation. `function_call` carries JSON `arguments`;
    // `custom_tool_call` (the apply-patch / freeform tools) carries `input`.
    case "function_call":
    case "custom_tool_call": {
      const name = typeof payload.name === "string" ? payload.name : "<unknown>";
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const content =
        typeof payload.arguments === "string"
          ? payload.arguments
          : typeof payload.input === "string"
            ? payload.input
            : extractText(payload.arguments ?? payload.input);
      return {
        role: "assistant",
        type: "tool_use",
        toolName: name,
        content,
        ...(callId && { toolUseId: callId }),
        ...(ts && { timestamp: ts }),
      };
    }

    // Tool result — surfaced as user-role for parity with Claude's
    // tool_use → tool_result pairing.
    case "function_call_output":
    case "custom_tool_call_output": {
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      const content = extractText(payload.output);
      return {
        role: "user",
        type: "tool_result",
        content,
        ...(callId && { toolUseId: callId }),
        ...(ts && { timestamp: ts }),
      };
    }

    case "reasoning": {
      const content = extractText(payload.summary ?? payload.content);
      if (!content) return null;
      return { role: "assistant", type: "thinking", content, ...(ts && { timestamp: ts }) };
    }

    default:
      return null;
  }
}

/** Translate a `payload.type === "message"` item, filtering synthetic leads. */
function translateMessage(
  payload: Record<string, unknown>,
  ts: string | undefined,
): ParsedMessage | null {
  const role = typeof payload.role === "string" ? payload.role : undefined;
  const content = extractText(payload.content);
  if (!content) return null;

  // Drop the CLI's synthetic lead messages (permissions instructions /
  // environment context / injected user instructions) — they aren't part of
  // the user-visible conversation. Detected by their angle-bracket tag prefix
  // so the filter is position-independent and survives reordering.
  const head = content.trimStart().toLowerCase();
  if (SYNTHETIC_MESSAGE_PREFIXES.some((p) => head.startsWith(p))) return null;

  const mappedRole: ParsedMessage["role"] =
    role === "assistant" ? "assistant" : role === "user" ? "user" : "system";

  return { role: mappedRole, type: "text", content, ...(ts && { timestamp: ts }) };
}

/**
 * Best-effort extraction of displayable text from the content shapes the rollout
 * uses: a plain string, an array of `{ type, text }` content blocks, or an
 * object with `.text`. Mirrors the OR parser's `extractTextContent`.
 */
export function extractText(content: unknown): string {
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
        return "";
      })
      .filter((s) => s.length > 0)
      .join("\n");
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
  }
  try {
    const json = JSON.stringify(content);
    return json === undefined ? String(content) : json;
  } catch {
    return String(content);
  }
}

/**
 * Read the first real user prompt out of a rollout — the chat-list preview.
 * Skips the synthetic lead messages the same way {@link parseCodexRollout}
 * does, returning the first genuine `user` message's text.
 */
export function readFirstUserPrompt(filePath: string): string | null {
  for (const line of readRolloutLines(filePath)) {
    if (line.type !== "response_item") continue;
    const p = line.payload;
    if (!p || p.type !== "message" || p.role !== "user") continue;
    const content = extractText(p.content);
    if (!content) continue;
    const head = content.trimStart().toLowerCase();
    if (SYNTHETIC_MESSAGE_PREFIXES.some((pre) => head.startsWith(pre))) continue;
    return content;
  }
  return null;
}
