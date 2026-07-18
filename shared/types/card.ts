/**
 * Cards — durable ticket entities that group chats and job runs around a
 * topic for the /board manager view. Membership lives on the chat side
 * (metadata.cardId) and is discovered by scan; the card file stores only
 * identity and lifecycle, so deleted chats self-heal out of the group.
 */

export type CardLifecycle = "open" | "closed";

export interface Card {
  id: string;
  title: string;
  /** Markdown body describing the topic. */
  description: string;
  emoji: string;
  lifecycle: CardLifecycle;
  /** Set when lifecycle === "closed"; cleared on reopen. */
  closedAt?: string;
  pinned: boolean;
  /** Agent-settable narrative status (set_card_status tool), max 160 chars. */
  status?: string;
  statusEmoji?: string;
  createdAt: string;
  updatedAt: string;
}

/** Create payload — server-managed fields stripped. */
export interface CardPayload {
  title: string;
  description?: string;
  emoji?: string;
}

/** Partial update; null clears the nullable narrative-status fields. */
export interface CardPatch {
  title?: string;
  description?: string;
  emoji?: string;
  pinned?: boolean;
  status?: string | null;
  statusEmoji?: string | null;
  lifecycle?: CardLifecycle;
}

/**
 * Live rollup state, computed server-side from members. Precedence:
 * needs_you > job_running > active > idle.
 */
export type CardRollupState = "needs_you" | "job_running" | "active" | "idle";

/** Compact member-chat row for board tiles/drawer. */
export interface CardMemberChat {
  chatId: string;
  title: string | null;
  folder: string;
  status: "ongoing" | "waiting" | "stopped";
  chatStatus?: string;
  chatStatusEmoji?: string;
  hasSummon: boolean;
  unread: boolean;
  isTriggered: boolean;
  provider?: string;
  jobRunId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Compact member job-run row. */
export interface CardMemberRun {
  runId: string;
  jobId: string;
  jobName: string;
  title?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface CardSummary extends Card {
  rollup: CardRollupState;
  /** max(card.updatedAt, member chats' updated_at, member runs' updatedAt/endedAt). */
  lastActivityAt: string;
  chatCount: number;
  /** True when any member chat is unread. */
  unread: boolean;
  /** Sorted by updatedAt desc. */
  memberChats: CardMemberChat[];
  memberRuns: CardMemberRun[];
}

export interface CardListResponse {
  cards: CardSummary[];
}

export interface CardResponse {
  card: CardSummary;
}
