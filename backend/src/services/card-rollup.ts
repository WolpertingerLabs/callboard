/**
 * Card rollup — aggregates member chats and job runs into per-card
 * summaries for the /board view.
 *
 * In the cards-as-metadata model a card IS its lineage root chat.  The
 * rollup derives the card list from the chat corpus: every lineage root
 * that is not triggered and not a job-step chat is a card, with fields
 * read from `metadata.card` (absent means all defaults).  Membership is
 * discovered via the lineage tree — all chats whose `rootKeyOf` resolves
 * to the same root are on the same card, and runs carry `rootChatId` to
 * say which root they belong to.
 *
 * Pure over its inputs — the chats and runs are passed in (a stat-gated
 * snapshot in production; see chats-snapshot.ts) and card fields are
 * read off those same records.  Nothing here reaches back into
 * chatFileService or the job store: a rollup is one consistent
 * point-in-time, and mixing a second store read would let a card's fields
 * disagree with the membership grouped underneath it.  Session-registry
 * lookups are injected the same way so tests can run without the registry
 * (production deps in ROLLUP_DEPS).
 */
import type { Card, CardChatActivity, CardMemberChat, CardMemberRun, CardPendingKind, CardRollupState, CardSummary, Chat, JobRunListItem } from "shared";
import { buildLineageIndex } from "./chat-lineage.js";
import { cardFieldsFromChat, isCardRoot } from "./card-fields.js";
import { sessionRegistry } from "./session-registry.js";
import { getPendingRequest } from "./claude.js";
import { getSessionProviders } from "../agents/factory.js";
import { isRetiredProvider } from "../agents/ports/AgentProvider.js";
import { listActivities } from "./chat-activity.js";
import { listPendingForParent } from "./session-callbacks.js";

export interface RollupDeps {
  isSessionActive: (chatId: string, sessionId: string) => boolean;
  /** The kind of input a chat is blocked on, or undefined when not waiting. */
  pendingKindOf: (chatId: string, sessionId: string) => CardPendingKind | undefined;
  /**
   * The long-running tool call a chat is inside, or undefined. Double-keyed
   * like the lookups above: an activity may have been opened under either id.
   */
  activityOf: (chatId: string, sessionId: string) => CardChatActivity | undefined;
  /** Outstanding onComplete callbacks this chat is the parent of. */
  awaitingChildrenOf: (chatId: string) => number;
  /**
   * First-user-message preview for a chat whose metadata carries no title —
   * the same fallback the sidebar shows, so untitled chats never render as
   * "Untitled chat" on the board. Null when the session log can't be found
   * or has no user message yet.
   */
  previewOf: (sessionId: string) => string | null;
}

const PENDING_KIND_BY_EVENT: Record<string, CardPendingKind> = {
  permission_request: "permission",
  user_question: "question",
  plan_review: "plan",
};

/**
 * Previews by session ID. A session's first user message is immutable once
 * written, so hits never go stale; misses (log not found / no user message
 * yet) are not cached so they can resolve on a later rollup.
 */
const previewCache = new Map<string, string>();

/** Production deps — same double-keyed lookups as chatStatus() in chat-lineage.ts. */
export const ROLLUP_DEPS: RollupDeps = {
  isSessionActive: (chatId, sessionId) => sessionRegistry.has(chatId) || sessionRegistry.has(sessionId),
  pendingKindOf: (chatId, sessionId) => {
    const pending = getPendingRequest(chatId) ?? getPendingRequest(sessionId);
    return pending ? PENDING_KIND_BY_EVENT[pending.eventType] : undefined;
  },
  activityOf: (chatId, sessionId) => {
    const open = listActivities(chatId).concat(listActivities(sessionId));
    const first = open[0];
    if (!first) return undefined;
    return {
      kind: first.kind,
      label: first.label,
      ...(first.expiresAt !== undefined && { expiresAt: first.expiresAt }),
      ...(first.condition && { condition: first.condition.text }),
    };
  },
  awaitingChildrenOf: (chatId) => listPendingForParent(chatId).length,
  previewOf: (sessionId) => {
    const cached = previewCache.get(sessionId);
    if (cached !== undefined) return cached;
    for (const provider of getSessionProviders()) {
      const resolved = provider.resolveSession(sessionId);
      if (!resolved) continue;
      const preview = provider.getSessionPreview(resolved.logPath);
      if (preview) previewCache.set(sessionId, preview);
      return preview;
    }
    return null;
  },
};

/** Run statuses that count as "the job is still going" for the rollup. */
const RUN_ACTIVE_STATUSES: ReadonlySet<string> = new Set(["running", "sleeping", "waiting_child", "waiting_event"]);

type ChatMeta = Record<string, unknown>;

function parseMeta(chat: Chat): ChatMeta {
  try {
    return JSON.parse(chat.metadata || "{}");
  } catch {
    return {};
  }
}

function toMemberChat(chat: Chat, meta: ChatMeta, deps: RollupDeps): CardMemberChat {
  // metadata.preview is only stamped by the chats route at response time, so
  // raw file-storage records won't have it — previewOf reads the session log.
  const rawTitle =
    (typeof meta.title === "string" && meta.title) || (typeof meta.preview === "string" && meta.preview) || deps.previewOf(chat.session_id) || null;
  const title = typeof rawTitle === "string" ? rawTitle.replace(/\s+/g, " ").trim().slice(0, 120) : null;
  // A pending request outranks "ongoing": the session may still be
  // registered while it sits blocked on user input, and blocked-on-you is
  // the state the board must surface.
  const pendingKind = deps.pendingKindOf(chat.id, chat.session_id);
  const status = pendingKind ? "waiting" : deps.isSessionActive(chat.id, chat.session_id) ? "ongoing" : "stopped";
  const lastReadAt = typeof meta.lastReadAt === "string" ? meta.lastReadAt : undefined;
  const activity = deps.activityOf(chat.id, chat.session_id);
  const awaitingChildren = deps.awaitingChildrenOf(chat.id);
  return {
    chatId: chat.id,
    title: title || null,
    folder: chat.folder,
    status,
    ...(pendingKind && { pendingKind }),
    ...(typeof meta.chatStatus === "string" && meta.chatStatus && { chatStatus: meta.chatStatus }),
    ...(typeof meta.chatStatusEmoji === "string" && meta.chatStatusEmoji && { chatStatusEmoji: meta.chatStatusEmoji }),
    hasSummon: !!meta.summon,
    // Same rule as the sidebar (ChatListItem): never-read chats are not unread.
    unread: lastReadAt ? new Date(chat.updated_at) > new Date(lastReadAt) : false,
    isTriggered: meta.triggered === true,
    ...(typeof meta.provider === "string" && meta.provider && { provider: meta.provider }),
    ...(typeof meta.agentAlias === "string" && meta.agentAlias && { agentAlias: meta.agentAlias }),
    ...(typeof meta.jobRunId === "string" && meta.jobRunId && { jobRunId: meta.jobRunId }),
    ...(activity && { activity }),
    ...(awaitingChildren > 0 && { awaitingChildren }),
    createdAt: chat.created_at,
    updatedAt: chat.updated_at,
  };
}

function toMemberRun(run: JobRunListItem): CardMemberRun {
  return {
    runId: run.runId,
    jobId: run.jobId,
    jobName: run.jobName,
    ...(run.title && { title: run.title }),
    status: run.status,
    // Already computed upstream and previously dropped here, which is why a
    // sleeping or event-waiting run could only ever show a raw status string.
    ...(run.nextWakeAt && { nextWakeAt: run.nextWakeAt }),
    ...(run.currentStepName && { currentStepName: run.currentStepName }),
    ...(run.currentStepType && { currentStepType: run.currentStepType }),
    ...(run.activeChildRunId && { activeChildRunId: run.activeChildRunId }),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.endedAt && { endedAt: run.endedAt }),
  };
}

function rollupState(chats: CardMemberChat[], runs: CardMemberRun[]): CardRollupState {
  if (chats.some((c) => c.status === "waiting" || c.hasSummon) || runs.some((r) => r.status === "waiting_approval")) {
    return "needs_you";
  }
  if (runs.some((r) => RUN_ACTIVE_STATUSES.has(r.status))) return "job_running";
  if (chats.some((c) => c.status === "ongoing")) return "active";
  return "idle";
}

/**
 * Build card summaries from a snapshot of chats and runs.
 *
 * Cards are derived, not passed in: every lineage root that passes
 * `isCardRoot` becomes a card, its fields projected from the SAME snapshot
 * record (`cardFieldsFromChat`) — never a second store read.  Chats are
 * grouped by `rootKeyOf`; runs by `run.rootChatId`.  Hidden cards
 * (`metadata.card.hidden === true`) are omitted from the board view.
 */
export function buildCardSummaries(chats: Chat[], allRuns: JobRunListItem[], deps: RollupDeps = ROLLUP_DEPS): CardSummary[] {
  const { rootKeyOf } = buildLineageIndex(chats);

  // Find every lineage root that qualifies as a card, with its projected
  // fields. Hidden cards are opted out of the board (replacement for the
  // old createCard: false).
  const cardsByRoot = new Map<string, Card>();
  for (const chat of chats) {
    if (rootKeyOf(chat.id) !== chat.id) continue;
    if (!isCardRoot(chat)) continue;
    const card = cardFieldsFromChat(chat);
    if (card.hidden) continue;
    cardsByRoot.set(chat.id, card);
  }

  // Group chats by root.
  const chatsByRoot = new Map<string, CardMemberChat[]>();
  for (const chat of chats) {
    const rootId = rootKeyOf(chat.id);
    if (!cardsByRoot.has(rootId)) continue;
    const meta = parseMeta(chat);
    if (isRetiredProvider(meta.provider)) continue;
    const members = chatsByRoot.get(rootId) ?? [];
    members.push(toMemberChat(chat, meta, deps));
    chatsByRoot.set(rootId, members);
  }

  // Group runs by their lineage root.
  const runsByRoot = new Map<string, CardMemberRun[]>();
  for (const run of allRuns) {
    const rootId = run.rootChatId;
    if (!rootId || !cardsByRoot.has(rootId)) continue;
    const members = runsByRoot.get(rootId) ?? [];
    members.push(toMemberRun(run));
    runsByRoot.set(rootId, members);
  }

  const summaries: CardSummary[] = [];
  for (const [rootId, card] of cardsByRoot) {
    const memberChats = (chatsByRoot.get(rootId) ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const memberRuns = (runsByRoot.get(rootId) ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    // Card-data edits (updatedAt) count as activity too — a card whose chats
    // are quiet but was just retitled should not sink to the bottom of the
    // board's recency ordering.
    let lastActivityAt = card.updatedAt;
    for (const chat of memberChats) {
      if (chat.updatedAt > lastActivityAt) lastActivityAt = chat.updatedAt;
    }
    for (const run of memberRuns) {
      const runActivity = run.endedAt && run.endedAt > run.updatedAt ? run.endedAt : run.updatedAt;
      if (runActivity > lastActivityAt) lastActivityAt = runActivity;
    }

    summaries.push({
      ...card,
      rollup: rollupState(memberChats, memberRuns),
      lastActivityAt,
      chatCount: memberChats.length,
      unread: memberChats.some((c) => c.unread),
      memberChats,
      memberRuns,
    });
  }

  return summaries.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}
