import type { CardSummary, CardPendingKind } from "../../api";

/** Card-face wording for what a waiting chat is blocked on. */
export const PENDING_LABELS: Record<CardPendingKind, string> = {
  permission: "Approval needed",
  question: "Question for you",
  plan: "Plan review",
};

/** Short chip wording for member rows in the drawer. */
export const PENDING_CHIPS: Record<CardPendingKind, string> = {
  permission: "approval",
  question: "question",
  plan: "plan",
};

/**
 * The specific reason a needs_you card wants attention, replacing the
 * generic label: blocked chats first (with a +N overflow), then a job
 * approval gate, then a summon.
 */
export function needsYouLabel(card: CardSummary): string {
  const waiting = card.memberChats.filter((c) => c.pendingKind);
  if (waiting.length > 0) {
    const label = PENDING_LABELS[waiting[0].pendingKind!];
    return waiting.length > 1 ? `${label} +${waiting.length - 1}` : label;
  }
  if (card.memberRuns.some((r) => r.status === "waiting_approval")) return "Job approval";
  if (card.memberChats.some((c) => c.hasSummon)) return "Summoned";
  return "Needs you";
}
