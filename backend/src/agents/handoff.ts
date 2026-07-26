/**
 * Cross-harness handoff — project a chat's history into the neutral
 * user/assistant turns a *different* harness can be seeded with.
 *
 * Callboard pins `metadata.provider` for a chat's lifetime, so "switch this
 * conversation to Codex" is really "fork it into a new chat whose native
 * session already contains the old one's history". The read side is already
 * harness-neutral ({@link SessionProvider.parseSessionMessages} →
 * `ParsedMessage[]`), so a handoff needs one *writer* per target harness
 * ({@link SessionProvider.seedSession}) rather than one translator per
 * ordered pair — three implementations instead of nine.
 *
 * This module is the shared middle: it turns a `ParsedMessage[]` timeline
 * into {@link HandoffTurn}s that every writer can express natively.
 *
 * ## Why tool traffic is flattened to text
 *
 * `ParsedMessage` carries enough to replay tool calls structurally (name,
 * JSON input, result text, call id), but tool *names* don't survive the trip:
 * Claude's `Bash`/`Read` have no counterpart in Codex's `shell`/`apply_patch`
 * or OpenRouter's `bash`. Replaying them verbatim would seed the target with
 * function calls naming tools that aren't in its tool list — at best confusing
 * the model, at worst rejected by the API.
 *
 * So tool calls and their results are folded into the surrounding assistant
 * turn as bracketed, truncated text. The information survives; the pretense
 * that the new model personally ran those commands does not. That is the
 * honest framing anyway — the handoff preamble says so explicitly, because a
 * model that believes it ran `rm -rf` an hour ago behaves differently from one
 * told another agent did.
 *
 * @see plans/cross-harness-handoff.md
 */
import type { ParsedMessage } from "shared/types/index.js";
import type { AgentProviderKind } from "./ports/AgentProvider.js";

/**
 * One conversational turn in the seeded history. Deliberately minimal — the
 * intersection of what all three harnesses can express without inventing
 * provider-specific structure.
 */
export interface HandoffTurn {
  role: "user" | "assistant";
  text: string;
  /** ISO timestamp of the source message this turn came from, when known. */
  timestamp?: string;
}

/**
 * Per-blob cap on folded tool input/output text. Tool results are the one
 * unbounded input here — a single `Read` of a large file or a `find` across a
 * monorepo can run to hundreds of KB, and a handful of those would blow the
 * target's context before the new session sends its first token. The head of a
 * result is almost always the informative part (paths, first hits, error
 * lines), so a head-truncation with an explicit marker keeps the signal and
 * makes the loss visible to the model rather than silent.
 */
const MAX_TOOL_BLOB_CHARS = 2000;

/** Human-readable harness names for the preamble. */
const PROVIDER_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  openrouter: "OpenRouter",
  mock: "a mock harness",
};

export function providerLabel(kind: string): string {
  return PROVIDER_LABELS[kind] ?? kind;
}

/** Truncate a blob to {@link MAX_TOOL_BLOB_CHARS}, marking what was dropped. */
function truncateBlob(text: string): string {
  if (text.length <= MAX_TOOL_BLOB_CHARS) return text;
  const dropped = text.length - MAX_TOOL_BLOB_CHARS;
  return `${text.slice(0, MAX_TOOL_BLOB_CHARS)}\n… [${dropped} more characters truncated in handoff]`;
}

/**
 * Collapse whitespace-only content to empty so it can be dropped. Messages
 * whose entire content is whitespace produce turns that read as blank to the
 * model and, on some APIs, are rejected outright.
 */
function normalize(text: string): string {
  return typeof text === "string" ? text.trim() : "";
}

/**
 * Render one tool invocation as a text block for the assistant turn.
 * The tool's JSON input is emitted as-is (already a compact JSON string in
 * `ParsedMessage.content`) rather than pretty-printed — the model reads it
 * fine and it costs far fewer tokens.
 */
function renderToolUse(msg: ParsedMessage): string {
  const name = msg.toolName || "tool";
  const input = normalize(msg.content);
  return input ? `[tool: ${name}] ${truncateBlob(input)}` : `[tool: ${name}]`;
}

function renderToolResult(msg: ParsedMessage): string {
  const body = normalize(msg.content);
  if (!body) return "[tool result: (empty)]";
  return `[tool result] ${truncateBlob(body)}`;
}

/**
 * Project a parsed timeline into handoff turns.
 *
 * Dropped wholesale:
 *  - `thinking` — reasoning traces carry provider-specific signatures /
 *    encrypted payloads that cannot be re-attributed to a different model, and
 *    replaying another model's reasoning as if it were your own is worse than
 *    not having it.
 *  - `system` — compact boundaries, `_sessionId` markers and other callboard
 *    plumbing, meaningless outside the source harness.
 *  - subagent messages (`teamName` set) — nested detail inlined for display
 *    only; splicing them into a linear transcript misrepresents who said what.
 *
 * Consecutive same-role turns are merged, since the seeded history is
 * replayed as a real message sequence and some APIs reject (or silently
 * coalesce) adjacent same-role messages.
 */
export function flattenForHandoff(messages: ParsedMessage[]): HandoffTurn[] {
  const turns: HandoffTurn[] = [];

  const push = (role: "user" | "assistant", text: string, timestamp?: string) => {
    const body = normalize(text);
    if (!body) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.text = `${last.text}\n\n${body}`;
      return;
    }
    turns.push({ role, text: body, ...(timestamp && { timestamp }) });
  };

  for (const msg of messages) {
    if (msg.teamName) continue;

    switch (msg.type) {
      case "text":
        // System-role text (rare) rides along as user context — it is
        // conversation content, just not attributable to either party.
        push(msg.role === "assistant" ? "assistant" : "user", msg.content, msg.timestamp);
        break;

      case "tool_use":
        push("assistant", renderToolUse(msg), msg.timestamp);
        break;

      case "tool_result":
        // Tool results are folded into the ASSISTANT side even though the
        // parsers give them `role: "user"` (a Claude-shaped convention where
        // results ride on a user-role message). Keeping them adjacent to the
        // call that produced them preserves the read order of the transcript;
        // attributing them to the user would fabricate user turns that never
        // happened and split the assistant's reasoning across roles.
        push("assistant", renderToolResult(msg), msg.timestamp);
        break;

      default:
        break; // thinking, system
    }
  }

  return turns;
}

/**
 * The note prepended to a seeded session, as a user turn.
 *
 * States the provenance plainly. The target model needs to know three things
 * the transcript alone won't tell it: that a different harness produced this
 * history, that the tool traffic is a summary rather than its own tool calls,
 * and that the tool results are point-in-time (the working tree has since
 * moved on, possibly a lot).
 */
export function buildHandoffPreamble(from: AgentProviderKind, to: AgentProviderKind): string {
  return [
    `<conversation_handoff from="${providerLabel(from)}" to="${providerLabel(to)}">`,
    `The conversation below took place with a different agent harness (${providerLabel(from)}).`,
    `It is carried over as context so you can continue it.`,
    ``,
    `Two things to keep in mind:`,
    `- Tool calls and their results appear as bracketed text summaries. You did not run them, and long outputs were truncated.`,
    `- Those results describe the state of the world at the time they ran. Re-check anything you intend to rely on.`,
    ``,
    `Pick up the conversation from where it leaves off.`,
    `</conversation_handoff>`,
  ].join("\n");
}

/** The assistant acknowledgement that closes the preamble exchange. */
export function buildHandoffAck(from: AgentProviderKind): string {
  return `Understood — I have the prior conversation from ${providerLabel(from)} as context and will continue from there, re-verifying anything I depend on.`;
}

/**
 * Build the complete turn list to seed a target harness with: the preamble
 * exchange followed by the carried history.
 *
 * Returns an empty array when there is nothing to carry — callers treat that
 * as "nothing to fork" rather than seeding a session containing only a
 * preamble that references a conversation the model cannot see.
 */
export function buildHandoffTurns(messages: ParsedMessage[], from: AgentProviderKind, to: AgentProviderKind): HandoffTurn[] {
  const carried = flattenForHandoff(messages);
  if (carried.length === 0) return [];
  return [{ role: "user", text: buildHandoffPreamble(from, to) }, { role: "assistant", text: buildHandoffAck(from) }, ...carried];
}

/**
 * Truncate a parsed timeline at a fork point: everything up to and including
 * the last message timestamped at or before `cutoffTimestamp`.
 *
 * Mirrors the positional cutoff `ClaudeCodeSessionProvider.forkSession` applies
 * to raw JSONL lines — untimestamped messages ride along with their neighbours
 * rather than being dropped, so a tool result that happens to lack a timestamp
 * still follows the call it belongs to. Returns `[]` when nothing qualifies.
 */
export function truncateAtCutoff(messages: ParsedMessage[], cutoffTimestamp: string): ParsedMessage[] {
  const cutoffMs = new Date(cutoffTimestamp).getTime();
  if (isNaN(cutoffMs)) return [];

  let cutoffIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const ts = messages[i]!.timestamp;
    if (!ts) continue;
    const ms = new Date(ts).getTime();
    if (!isNaN(ms) && ms <= cutoffMs) cutoffIdx = i;
  }
  if (cutoffIdx === -1) return [];
  return messages.slice(0, cutoffIdx + 1);
}
