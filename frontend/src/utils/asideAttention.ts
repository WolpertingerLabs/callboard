/**
 * What asides folded out of sight need from the user, summed for the one
 * place that stands for them: the aside count on their parent's sidebar row
 * or tree node, and the chat header's asides button.
 *
 * Asides are not rows of their own, so these signals would otherwise have
 * nowhere to show. The parent's ROW still rolls up unread output, summons and
 * waiting jobs (ChatTreeList `buildRows`); the count says which of them are
 * the asides', and adds what the row cannot — a live session (the row's own
 * status stays the parent's) and a prompt waiting on an answer.
 */
import type { Chat, ChatTreeNode } from "../api";
import { chatMeta } from "./chatMeta";

export interface AsideAttention {
  running: number;
  /** Blocked on a permission prompt or question with no live run (tree status `waiting`). */
  waiting: number;
  unread: number;
  summoned: number;
}

export const NO_ATTENTION: AsideAttention = Object.freeze({ running: 0, waiting: 0, unread: 0, summoned: 0 });

const after = (a: string | undefined, b: string | undefined) => !!a && !!b && new Date(a).getTime() > new Date(b).getTime();

/** One aside's signals, as booleans. */
export interface AsideSignals {
  running: boolean;
  waiting: boolean;
  unread: boolean;
  summoned: boolean;
}

/** From a tree node (the chat page's aside list, an expanded sidebar tree). `running` from the live registry where the caller has it. */
export function nodeSignals(node: Pick<ChatTreeNode, "status" | "updatedAt" | "lastReadAt" | "summon">, running?: boolean): AsideSignals {
  return {
    running: running ?? node.status === "ongoing",
    waiting: node.status === "waiting",
    unread: after(node.updatedAt, node.lastReadAt),
    summoned: !!node.summon,
  };
}

/** From a chat-list record (a sidebar row's folded asides). The list has no waiting state. */
export function chatSignals(chat: Chat, running: boolean): AsideSignals {
  const meta = chatMeta(chat);
  return { running, waiting: false, unread: after(chat.updated_at, meta.lastReadAt), summoned: !!meta.summon };
}

export function sumAttention(signals: readonly AsideSignals[]): AsideAttention {
  if (signals.length === 0) return NO_ATTENTION;
  const sum = { running: 0, waiting: 0, unread: 0, summoned: 0 };
  for (const s of signals) {
    if (s.running) sum.running++;
    if (s.waiting) sum.waiting++;
    if (s.unread) sum.unread++;
    if (s.summoned) sum.summoned++;
  }
  return sum;
}

/** `, 1 running, 1 waiting` — appended to a count's accessible name. Empty for none. */
export function attentionSuffix(a: AsideAttention): string {
  const parts = [
    a.summoned && `${a.summoned} calling for you`,
    a.waiting && `${a.waiting} waiting for an answer`,
    a.unread && `${a.unread} unread`,
    a.running && `${a.running} running`,
  ].filter(Boolean);
  return parts.length ? `, ${parts.join(", ")}` : "";
}

/** The one dot a count carries: the most pressing signal, or none. */
export function attentionDot(a: AsideAttention): "summoned" | "waiting" | "unread" | "running" | null {
  if (a.summoned) return "summoned";
  if (a.waiting) return "waiting";
  if (a.unread) return "unread";
  if (a.running) return "running";
  return null;
}
