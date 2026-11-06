/**
 * Rerun: send a user prompt again from the point just before it, in the
 * chat's place. The new chat's history is everything strictly BEFORE the
 * prompt; the prompt itself is then sent to it as a fresh turn. The original is
 * kept as a `"superseded"` child exactly as continue-from keeps it (see
 * chat-supersede.ts) — it is the branch where the prompt was answered the
 * first time.
 *
 * Picked on an assistant message, the prompt is the one that message answers:
 * the nearest user turn before it. Tool results are not user turns — they are
 * `type: "tool_result"` in the parsed transcript — and neither are a team
 * member's messages.
 *
 * Pure: messages in, a plan out. The route writes the session and starts the
 * run.
 */
import type { ParsedMessage } from "shared/types/index.js";

/** A user turn a rerun can send again. */
export function isRerunPrompt(message: ParsedMessage): boolean {
  if (message.role !== "user" || message.type !== "text" || message.teamName || !message.timestamp) return false;
  return message.content.trim().length > 0 || (message.imageIds?.length ?? 0) > 0;
}

export interface RerunPlan {
  /** The user turn being sent again. */
  prompt: ParsedMessage;
  /**
   * The session-write cutoff: one millisecond before the prompt, so the forked
   * history is everything strictly before it (the providers' cutoffs are
   * "at or before", in ms). Null when nothing precedes the prompt — a rerun of
   * the opening message starts a fresh session instead of forking one.
   */
  forkCutoff: string | null;
  /**
   * The supersede point X: the timestamp of the last message the new chat
   * keeps, verbatim, so the inline "original continues" marker lands under it
   * (markers match by exact timestamp string). One ms before the prompt when
   * nothing kept carries a marker slot.
   */
  supersedeAt: string;
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
    if (role === "user") return { ok: false, error: "That message cannot be rerun" };
    // An assistant message: the prompt it answers is the nearest user turn
    // before it.
    for (let i = at[0]! - 1; i >= 0; i--) {
      if (isRerunPrompt(messages[i]!)) {
        promptIndex = i;
        break;
      }
    }
    if (promptIndex === -1) return { ok: false, error: "No user message before this one to rerun" };
  }

  const prompt = messages[promptIndex]!;
  const promptMs = ms(prompt.timestamp);
  const before = new Date(promptMs - 1).toISOString();
  const kept = messages.filter((m) => ms(m.timestamp) < promptMs);
  if (kept.length === 0) return { ok: true, prompt, forkCutoff: null, supersedeAt: before };

  let supersedeAt = before;
  for (let i = kept.length - 1; i >= 0; i--) {
    const m = kept[i]!;
    if (m.type === "text" && !m.teamName && m.timestamp) {
      supersedeAt = m.timestamp;
      break;
    }
  }
  return { ok: true, prompt, forkCutoff: before, supersedeAt };
}
