/**
 * Per-message compression — the harness-neutral half.
 *
 * "Compress earlier messages" summarises everything strictly before a message
 * X and keeps X onward verbatim; "compress later messages" keeps everything
 * through X verbatim and summarises what came after. Either way the result is a
 * NEW session (written by a {@link SessionProvider}) that a new chat resumes;
 * the original chat and its session are left untouched, so a compression is
 * undoable by going back to it.
 *
 * Two writers consume what is here:
 *
 *  - Claude Code's native writer (`ClaudeCodeSessionProvider.compressSession`)
 *    keeps the verbatim part as raw JSONL lines — real tool_use blocks,
 *    thinking signatures, ids — and only takes the summary text and its framing
 *    from this module.
 *  - Every other harness goes through {@link buildCompressedTurns}: the kept
 *    part is flattened with {@link flattenForHandoff} (tool calls become text,
 *    exactly as in a cross-harness handoff) and the summary is spliced in as a
 *    user turn, then the turns are written with `seedSession`. Lossy for the
 *    kept part's tool traffic; accepted for v1.
 *
 * The cutoff semantics mirror `truncateAtCutoff` and the Claude fork writer:
 * a message belongs to the "through X" side when its timestamp is at or
 * before the cutoff. Untimestamped messages ride with the message before them.
 */
import type { ParsedMessage } from "shared/types/index.js";
import { flattenForHandoff, type HandoffTurn } from "./handoff.js";

export type CompressDirection = "before" | "after";

export function isCompressDirection(value: unknown): value is CompressDirection {
  return value === "before" || value === "after";
}

/**
 * Split a parsed timeline at the cutoff. `through` is every message at or
 * before the cutoff (plus untimestamped followers), `later` the rest. Both are
 * empty when the cutoff does not parse.
 */
export function splitAtCutoff(messages: ParsedMessage[], cutoffTimestamp: string): { through: ParsedMessage[]; later: ParsedMessage[] } {
  const cutoffMs = new Date(cutoffTimestamp).getTime();
  if (isNaN(cutoffMs)) return { through: [], later: [] };
  let cutoffIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    const ts = messages[i]!.timestamp;
    if (!ts) continue;
    const ms = new Date(ts).getTime();
    if (!isNaN(ms) && ms <= cutoffMs) cutoffIdx = i;
  }
  if (cutoffIdx === -1) return { through: [], later: messages };
  let end = cutoffIdx + 1;
  while (end < messages.length && !messages[end]!.timestamp) end++;
  return { through: messages.slice(0, end), later: messages.slice(end) };
}

/**
 * Split for "compress earlier messages": `earlier` is everything strictly
 * before the cutoff, `kept` the cutoff message onward. Untimestamped messages
 * ride with the message before them, so a leading untimestamped run joins
 * `earlier`.
 */
export function splitBeforeCutoff(messages: ParsedMessage[], cutoffTimestamp: string): { earlier: ParsedMessage[]; kept: ParsedMessage[] } {
  const cutoffMs = new Date(cutoffTimestamp).getTime();
  if (isNaN(cutoffMs)) return { earlier: [], kept: [] };
  const start = messages.findIndex((m) => {
    if (!m.timestamp) return false;
    const ms = new Date(m.timestamp).getTime();
    return !isNaN(ms) && ms >= cutoffMs;
  });
  if (start === -1) return { earlier: messages, kept: [] };
  return { earlier: messages.slice(0, start), kept: messages.slice(start) };
}

/**
 * The span a compression summarises and the span it keeps, for either
 * direction. The summarised span is what the summary prompt is built from.
 */
export function compressionSpans(messages: ParsedMessage[], cutoffTimestamp: string, direction: CompressDirection): { summarised: ParsedMessage[]; kept: ParsedMessage[] } {
  if (direction === "before") {
    const { earlier, kept } = splitBeforeCutoff(messages, cutoffTimestamp);
    return { summarised: earlier, kept };
  }
  const { through, later } = splitAtCutoff(messages, cutoffTimestamp);
  return { summarised: later, kept: through };
}

/** Whether a span has anything a summary could be made of. */
export function hasConversation(messages: ParsedMessage[]): boolean {
  return messages.some((m) => !m.teamName && (m.type === "text" || m.type === "tool_use" || m.type === "tool_result") && m.content?.trim());
}

/**
 * The user-turn text a summary is carried in.
 *
 * Marked plainly as a user-made compression in both directions, because the
 * model must not mistake a summary for something the user typed, and — for
 * "after" — must not resume as if the summarised work had not happened.
 */
export function compressionSummaryText(direction: CompressDirection, summary: string): string {
  const body = summary.trim();
  if (direction === "before") {
    return [
      "[Summary of the earlier conversation, compressed by the user]",
      "This session continues an earlier conversation. The user compressed the part before this point into the summary below; the messages after it are verbatim.",
      "",
      body,
    ].join("\n");
  }
  return [
    "[Summary of the later conversation, compressed by the user]",
    "The conversation continued past the previous message. The user compressed that later part into the summary below. Treat it as what happened; the working tree may reflect it.",
    "",
    body,
  ].join("\n");
}

/** The assistant acknowledgement that keeps roles alternating after a summary turn. */
export function compressionAckText(direction: CompressDirection): string {
  return direction === "before"
    ? "Understood — I have the summary of the earlier conversation and will continue from the messages that follow."
    : "Understood — I have the summary of what happened after that point and will continue from there.";
}

/**
 * The extra note the neutral path adds: its kept span was flattened, so tool
 * calls in it are text the model did not produce as tool calls.
 */
const FLATTENED_NOTE = "Tool calls in this session appear as bracketed text summaries rather than real tool calls, and long outputs were truncated.";

/** Merge adjacent same-role turns, as flattenForHandoff does within one list. */
function mergeAdjacent(turns: HandoffTurn[]): HandoffTurn[] {
  const out: HandoffTurn[] = [];
  for (const turn of turns) {
    const last = out[out.length - 1];
    if (last && last.role === turn.role) {
      last.text = [last.text, turn.text].filter(Boolean).join("\n\n");
      if (turn.images?.length) last.images = [...(last.images ?? []), ...turn.images];
      continue;
    }
    out.push({ ...turn });
  }
  return out;
}

/** Last timestamp in a list of messages, or undefined. */
function lastTimestamp(messages: ParsedMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.timestamp) return messages[i]!.timestamp;
  return undefined;
}

/** `ts` plus `ms` milliseconds, as ISO — or now when `ts` does not parse. */
export function isoPlus(ts: string | undefined, ms: number): string {
  const base = ts ? new Date(ts).getTime() : NaN;
  return new Date(isNaN(base) ? Date.now() : base + ms).toISOString();
}

/**
 * Turns for a compressed session on a harness without a native writer.
 * Returns [] when the kept span flattens to nothing.
 */
export function buildCompressedTurns(messages: ParsedMessage[], opts: { cutoffTimestamp: string; direction: CompressDirection; summary: string }): HandoffTurn[] {
  const { summarised, kept } = compressionSpans(messages, opts.cutoffTimestamp, opts.direction);
  const keptTurns = flattenForHandoff(kept).turns;
  if (keptTurns.length === 0) return [];
  const summaryText = `${compressionSummaryText(opts.direction, opts.summary)}\n\n${FLATTENED_NOTE}`;
  if (opts.direction === "before") {
    // Stamped with the last summarised message's time, so the summary sorts
    // before everything kept and never collides with a kept message's star key.
    const at = lastTimestamp(summarised) ?? isoPlus(kept.find((m) => m.timestamp)?.timestamp, -1);
    return mergeAdjacent([
      { role: "user", text: summaryText, timestamp: at },
      { role: "assistant", text: compressionAckText("before"), timestamp: at },
      ...keptTurns,
    ]);
  }
  const after = lastTimestamp(kept);
  return mergeAdjacent([
    ...keptTurns,
    { role: "user", text: summaryText, timestamp: isoPlus(after, 1) },
    { role: "assistant", text: compressionAckText("after"), timestamp: isoPlus(after, 2) },
  ]);
}

/**
 * Plain-text transcript of a span for the summary prompt, one block per turn.
 * Reuses the handoff projection, so tool traffic is folded to truncated text
 * the same way a handoff carries it.
 */
export function transcriptBlocksForSummary(messages: ParsedMessage[]): string[] {
  // Images are noted, not loaded: the summary prompt is text, and resolving
  // them would read every image's bytes off disk for nothing.
  const textOnly = messages.map((m) =>
    m.imageIds?.length ? { ...m, imageIds: undefined, content: `${m.content ?? ""}\n[${m.imageIds.length} image(s) attached]` } : m,
  );
  return flattenForHandoff(textOnly).turns.map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`);
}
