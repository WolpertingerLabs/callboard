/**
 * Cards — the board-facing projection of a lineage tree.
 *
 * A card IS its root chat. Its identity is the root chat's id; its data is a
 * nested `card` object on that chat's metadata blob (see
 * backend/src/services/card-fields.ts for the shape, defaults, and limits).
 * There is no standalone card entity, nothing to create, and nothing to
 * delete — a card exists because a top-level prompt exists and disappears
 * when that chat is deleted. Membership is never stored: member chats are
 * every chat in the root's parentage tree, member runs are job runs carrying
 * `rootChatId` = the root's id.
 *
 * An absent `metadata.card` object means all defaults (open, unpinned, title
 * = chat title) — the object only materialises when someone edits a field.
 */

export type CardLifecycle = "open" | "closed";

/**
 * Max length of {@link Card.category}. Lives here so the store, the routes,
 * the MCP tool schema, and every frontend input enforce one number.
 */
export const CARD_CATEGORY_MAX = 64;

export interface Card {
  /** Root chat id — the identity of the card. */
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
  /**
   * Board opt-out (replaces the old `createCard: false` stream flag). Hidden
   * cards are omitted from GET /api/cards; absent means visible. Absent —
   * never `false` — is the default.
   */
  hidden?: boolean;
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
  /**
   * Card-data timestamp: when the nested `metadata.card` fields were last
   * changed. Defaults to the chat's created_at when no edit has happened.
   * Deliberately NOT the chat's updated_at — amending a card is a view-only
   * write and must not resurface the chat as unread or reorder the sidebar.
   */
  createdAt: string;
  updatedAt: string;
}

/**
 * Partial update against the root chat's `metadata.card`. null clears the
 * nullable narrative-status fields. Applied by card-fields.ts — REST
 * (PATCH /api/cards/:id) and the MCP setters share that one implementation.
 */
export interface CardPatch {
  title?: string;
  description?: string;
  emoji?: string;
  pinned?: boolean;
  status?: string | null;
  statusEmoji?: string | null;
  /** null (or blank) clears the category. */
  category?: string | null;
  /** Toggle the board opt-out (replaces createCard: false). */
  hidden?: boolean | null;
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
  /**
   * What this chat is blocked on right now, when it is blocked on a
   * long-running tool call. Absent when nothing is in flight — an `ongoing`
   * chat is usually just working, not waiting.
   */
  activity?: CardChatActivity;
  /**
   * Outstanding `onComplete` callbacks this chat is the parent of. Absent
   * (never 0) when it is awaiting nothing. A chat can be `stopped` and still
   * have a non-zero count: it finished its turn and is waiting to be woken by
   * a child, which is exactly the state that used to read as simply done.
   */
  awaitingChildren?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The board's compact view of an in-flight activity — enough to label a tile
 * and drive a countdown, without the fields only the chat view uses.
 */
export interface CardChatActivity {
  kind: string;
  label: string;
  /** Epoch ms; the tile derives its countdown from this. */
  expiresAt?: number;
  /** The condition being polled, when this is a `wait(require_condition)`. */
  condition?: string;
}

/** Compact member job-run row. */
export interface CardMemberRun {
  runId: string;
  jobId: string;
  jobName: string;
  title?: string;
  status: string;
  /**
   * ISO timestamp of the next timer wake (poll interval, retry, timeout).
   * Carried through from `JobRunListItem` so a `sleeping` run can say *when*
   * it wakes rather than only that it is asleep.
   */
  nextWakeAt?: string;
  /** Display name of the current step, so a waiting run can say what it is on. */
  currentStepName?: string;
  currentStepType?: string;
  /** Child run the active "job" step is waiting on, when status is waiting_child. */
  activeChildRunId?: string;
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
