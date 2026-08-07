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
/** `mm:ss` until `epochMs`, or null once it has passed. */
function countdown(epochMs: number | undefined, now: number): string | null {
  if (epochMs === undefined) return null;
  const remaining = epochMs - now;
  if (remaining <= 0) return null;
  const total = Math.ceil(remaining / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * The specific reason a live card is busy, replacing the generic "Active" /
 * "Job running". Same idea as {@link needsYouLabel}: the rollup state says
 * *that* something is happening, this says *what*, which is the difference
 * between a board you scan and a board you have to click through.
 *
 * Precedence follows how long the user would otherwise wait to find out:
 * a chat counting down against a deadline, then one polling a condition,
 * then a job that has told us when it next wakes.
 */
export function activeLabel(card: CardSummary, now: number = Date.now()): string {
  const waiting = card.memberChats.find((c) => c.activity?.expiresAt !== undefined);
  const remaining = countdown(waiting?.activity?.expiresAt, now);
  if (waiting && remaining) {
    return waiting.activity?.condition ? `Polling — ${remaining}` : `Waiting ${remaining}`;
  }

  const delegating = card.memberChats.find((c) => c.activity?.kind === "await_agent" || c.activity?.kind === "await_chat");
  if (delegating?.activity) return `Awaiting ${delegating.activity.label}`;

  const polling = card.memberChats.find((c) => c.activity?.condition);
  if (polling?.activity?.condition) return "Polling";

  const sleeping = card.memberRuns.find((r) => r.nextWakeAt && (r.status === "sleeping" || r.status === "waiting_event"));
  const wake = countdown(sleeping?.nextWakeAt ? Date.parse(sleeping.nextWakeAt) : undefined, now);
  if (sleeping && wake) return `Job — next check ${wake}`;

  if (card.memberRuns.some((r) => r.status === "waiting_child")) return "Job — waiting on sub-job";

  const awaiting = card.memberChats.reduce((sum, c) => sum + (c.awaitingChildren ?? 0), 0);
  if (awaiting > 0) return `Awaiting ${awaiting} chat${awaiting === 1 ? "" : "s"}`;

  return card.rollup === "job_running" ? "Job running" : "Active";
}

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
