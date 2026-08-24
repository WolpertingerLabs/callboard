/**
 * Card rollup — aggregates member chats and job runs into per-card
 * summaries for the /board view.
 *
 * Membership is discovered by scan: chats via metadata.cardId, runs via
 * run.cardId. The card file stores nothing about members, so deleted
 * chats/runs self-heal out of the group.
 *
 * Pure over its inputs — session-registry lookups are injected so tests
 * can run without the registry (production deps in ROLLUP_DEPS).
 */
import type { Card, CardChatActivity, CardMemberChat, CardMemberRun, CardPendingKind, CardRollupState, CardSummary, Chat, JobRunListItem } from "shared";
import { metaCardId } from "./card-member-index.js";
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
 * `chats` may be every chat record or only the ones carrying a `cardId` — the
 * loop below skips the rest anyway, so the two are interchangeable and the
 * caller is free to hand over the cheaper set (see card-member-index.ts).
 */
export function buildCardSummaries(cards: Card[], chats: Chat[], allRuns: JobRunListItem[], deps: RollupDeps = ROLLUP_DEPS): CardSummary[] {
  const chatsByCard = new Map<string, CardMemberChat[]>();
  for (const chat of chats) {
    const meta = parseMeta(chat);
    const cardId = metaCardId(meta);
    if (!cardId) continue;
    // Membership comes off the file record, so this scan — unlike the sidebar,
    // which is driven by filesystem discovery — sees chats whose harness was
    // removed. Left in, they would count toward chatCount, could push a card to
    // "needs_you" or unread, and would open to an empty transcript: a board that
    // disagrees with the chat list about how many chats a card has. Discovery
    // has already dropped them everywhere else; drop them here too.
    if (isRetiredProvider(meta.provider)) continue;
    const members = chatsByCard.get(cardId) ?? [];
    members.push(toMemberChat(chat, meta, deps));
    chatsByCard.set(cardId, members);
  }

  const runsByCard = new Map<string, CardMemberRun[]>();
  for (const run of allRuns) {
    if (!run.cardId) continue;
    const members = runsByCard.get(run.cardId) ?? [];
    members.push(toMemberRun(run));
    runsByCard.set(run.cardId, members);
  }

  return cards.map((card) => {
    const memberChats = (chatsByCard.get(card.id) ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const memberRuns = (runsByCard.get(card.id) ?? []).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    let lastActivityAt = card.updatedAt;
    for (const chat of memberChats) if (chat.updatedAt > lastActivityAt) lastActivityAt = chat.updatedAt;
    for (const run of memberRuns) {
      const runActivity = run.endedAt && run.endedAt > run.updatedAt ? run.endedAt : run.updatedAt;
      if (runActivity > lastActivityAt) lastActivityAt = runActivity;
    }

    return {
      ...card,
      rollup: rollupState(memberChats, memberRuns),
      lastActivityAt,
      chatCount: memberChats.length,
      unread: memberChats.some((c) => c.unread),
      memberChats,
      memberRuns,
    };
  });
}
