/**
 * Cards — durable ticket entities that group chats and job runs around a
 * topic for the /board manager view. Membership lives on the chat side
 * (metadata.cardId) and is discovered by scan; the card file stores only
 * identity and lifecycle, so deleted chats self-heal out of the group.
 */

export type CardLifecycle = "open" | "closed";

/**
 * Max length of {@link Card.category}. Lives here so the store, the routes,
 * the MCP tool schema, and every frontend input enforce one number.
 */
export const CARD_CATEGORY_MAX = 64;

export interface Card {
  id: string;
  title: string;
  /** Markdown body describing the topic. */
  description: string;
  emoji: string;
  lifecycle: CardLifecycle;
  /**
   * Optional free-form grouping label ({@link CARD_CATEGORY_MAX} chars max) —
   * open cards on the board are grouped under it. Absent when uncategorized.
   */
  category?: string;
  /** Set when lifecycle === "closed"; cleared on reopen. */
  closedAt?: string;
  pinned: boolean;
  /** Agent-settable narrative status (set_card_status tool), max 160 chars. */
  status?: string;
  statusEmoji?: string;
  /**
   * Arbitrary key→value cross-references to external systems (PR URLs, ticket
   * ids, conversation links). Absent — never `{}` — when the card has no
   * entries, including on cards written before this field existed; read it as
   * `card.metadata ?? {}`.
   */
  metadata?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** Create payload — server-managed fields stripped. */
export interface CardPayload {
  title: string;
  description?: string;
  emoji?: string;
  category?: string;
}

/** Partial update; null clears the nullable narrative-status fields. */
export interface CardPatch {
  title?: string;
  description?: string;
  emoji?: string;
  pinned?: boolean;
  status?: string | null;
  statusEmoji?: string | null;
  /** null (or blank) clears the category. */
  category?: string | null;
  lifecycle?: CardLifecycle;
  /**
   * Per-key merge, not whole-object replace: each key present is set to its
   * value, a `null` value deletes that key, and keys absent from the patch are
   * left untouched — so a stale client can't wipe entries another writer just
   * added.
   */
  metadata?: Record<string, string | null>;
}

/**
 * Live rollup state, computed server-side from members. Precedence:
 * needs_you > job_running > active > idle.
 */
export type CardRollupState = "needs_you" | "job_running" | "active" | "idle";

/**
 * What a waiting chat is blocked on — a tool-use approval, a question the
 * agent asked the user, or a plan awaiting review.
 */
export type CardPendingKind = "permission" | "question" | "plan";

/** Compact member-chat row for board tiles/drawer. */
export interface CardMemberChat {
  chatId: string;
  title: string | null;
  folder: string;
  status: "ongoing" | "waiting" | "stopped";
  /** Set when status === "waiting": the kind of input the chat is blocked on. */
  pendingKind?: CardPendingKind;
  chatStatus?: string;
  chatStatusEmoji?: string;
  hasSummon: boolean;
  unread: boolean;
  isTriggered: boolean;
  provider?: string;
  /** Configured agent running this chat — new chats on the card inherit its context. */
  agentAlias?: string;
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
