/**
 * Rerun: send a user prompt again from the point just before it, in the
 * chat's place. The new chat's history is everything strictly BEFORE the
 * prompt; the prompt itself is then sent to it as a fresh turn. The original is
 * kept as a `"superseded"` child exactly as continue-from keeps it (see
 * chat-supersede.ts) — it is the branch where the prompt was answered the
 * first time.
 *
 * Picked on an assistant message, the prompt is the one that message answers:
 * the nearest user turn before it. Tool results are not user turns (they are
 * `type: "tool_result"` in the parsed transcript), and neither are a team
 * member's messages. The walk stops at the first user turn it meets and at a
 * compact boundary: a reply to a slash command or to a compaction summary
 * answers that, not an earlier prompt, so it is refused rather than mapped to
 * a prompt from before.
 *
 * Pure: messages in, a plan out. The route writes the session and starts the
 * run.
 */
import { findReplyPrompt, isRerunPrompt, isUserTurn, type ParsedMessage } from "shared/types/index.js";

export { isRerunPrompt };

export interface RerunPlan {
  /** Timestamp of the user turn being sent again (every block of it shares it). */
  promptAt: string;
  /** The prompt's text: every text block of that user turn, in order. */
  text: string;
  /** Images attached to the prompt, across its blocks. */
  imageIds: string[];
  /**
   * The cutoff N's history keeps through: one millisecond before the prompt,
   * so the forked history is everything strictly before it (the providers'
   * cutoffs are "at or before", in ms). Also what stars, children and
   * callbacks are measured against — N holds exactly this much.
   */
  keepThrough: string;
  /** False when nothing precedes the prompt — the opening prompt starts a fresh session instead of forking one. */
  hasHistory: boolean;
  /**
   * The supersede point X recorded on the original (`forkedAt`): the
   * timestamp of the last message N keeps that can carry the inline "original
   * continues" marker (markers match by exact timestamp string). `keepThrough`
   * when no kept message can.
   */
  markerAt: string;
}

export type RerunPlanResult = ({ ok: true } & RerunPlan) | { ok: false; error: string };

function ms(ts: string | undefined): number {
  return ts ? new Date(ts).getTime() : NaN;
}

/**
 * Resolve what a rerun picked at `timestamp` sends, and where it forks.
 * `role` narrows the pick when a user and an assistant message share the
 * timestamp; omitted, a user prompt at that timestamp wins.
 */
export function planRerun(messages: readonly ParsedMessage[], timestamp: string, role?: "user" | "assistant"): RerunPlanResult {
  const pickedMs = ms(timestamp);
  if (isNaN(pickedMs)) return { ok: false, error: "timestamp is required" };

  const at: number[] = [];
  messages.forEach((m, i) => {
    if (ms(m.timestamp) === pickedMs && (!role || m.role === role) && m.type === "text") at.push(i);
  });
  if (at.length === 0) return { ok: false, error: "No message at that timestamp" };

  let promptIndex = at.find((i) => isRerunPrompt(messages[i]!)) ?? -1;
  if (promptIndex === -1) {
    if (at.some((i) => isUserTurn(messages[i]!))) return { ok: false, error: "That message cannot be rerun" };
    // An assistant message: the prompt it answers is the nearest user turn
    // before it — which must itself be rerunnable (shared with the UI).
    const found = findReplyPrompt(messages, at[0]!);
    if ("error" in found) return { ok: false, error: found.error };
    promptIndex = found.index;
  }

  const promptAt = messages[promptIndex]!.timestamp!;
  const promptMs = ms(promptAt);
  // One user turn with several content blocks parses as several messages at
  // one timestamp, its images on the last of them.
  const blocks = messages.filter((m) => isUserTurn(m) && ms(m.timestamp) === promptMs);
  const text = blocks
    .map((m) => m.content)
    .filter((c) => c.trim())
    .join("\n\n");
  const imageIds = [...new Set(blocks.flatMap((m) => m.imageIds ?? []))];

  // Everything strictly before the prompt, by ms. A message stamped in the
  // same millisecond as the prompt is treated as part of it (dropped from the
  // kept history) — the providers' cutoffs work in ms too, so nothing finer
  // could be honoured, and an engine writing a reply in the prompt's own
  // millisecond does not happen in practice.
  const keepThrough = new Date(promptMs - 1).toISOString();
  const kept = messages.filter((m) => ms(m.timestamp) < promptMs);
  let markerAt = keepThrough;
  for (let i = kept.length - 1; i >= 0; i--) {
    const m = kept[i]!;
    if (m.type === "text" && !m.teamName && m.timestamp) {
      markerAt = m.timestamp;
      break;
    }
  }
  return { ok: true, promptAt, text, imageIds, keepThrough, hasHistory: kept.length > 0, markerAt };
}
