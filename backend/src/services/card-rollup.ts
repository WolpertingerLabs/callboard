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
import type { Card, CardMemberChat, CardMemberRun, CardRollupState, CardSummary, Chat, JobRunListItem } from "shared";
import { sessionRegistry } from "./session-registry.js";
import { hasPendingRequest } from "./claude.js";

export interface RollupDeps {
  isSessionActive: (chatId: string, sessionId: string) => boolean;
  isWaiting: (chatId: string, sessionId: string) => boolean;
}

/** Production deps — same double-keyed lookups as chatStatus() in chat-lineage.ts. */
export const ROLLUP_DEPS: RollupDeps = {
  isSessionActive: (chatId, sessionId) => sessionRegistry.has(chatId) || sessionRegistry.has(sessionId),
  isWaiting: (chatId, sessionId) => hasPendingRequest(chatId) || hasPendingRequest(sessionId),
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

/** String-typed cardId or undefined — unassign merges `cardId: null`, so key presence is not membership. */
function metaCardId(meta: ChatMeta): string | undefined {
  return typeof meta.cardId === "string" && meta.cardId ? meta.cardId : undefined;
}

function toMemberChat(chat: Chat, meta: ChatMeta, deps: RollupDeps): CardMemberChat {
  const rawTitle = (typeof meta.title === "string" && meta.title) || (typeof meta.preview === "string" && meta.preview) || null;
  const title = typeof rawTitle === "string" ? rawTitle.replace(/\s+/g, " ").trim().slice(0, 120) : null;
  const status = deps.isSessionActive(chat.id, chat.session_id) ? "ongoing" : deps.isWaiting(chat.id, chat.session_id) ? "waiting" : "stopped";
  const lastReadAt = typeof meta.lastReadAt === "string" ? meta.lastReadAt : undefined;
  return {
    chatId: chat.id,
    title: title || null,
    folder: chat.folder,
    status,
    ...(typeof meta.chatStatus === "string" && meta.chatStatus && { chatStatus: meta.chatStatus }),
    ...(typeof meta.chatStatusEmoji === "string" && meta.chatStatusEmoji && { chatStatusEmoji: meta.chatStatusEmoji }),
    hasSummon: !!meta.summon,
    // Same rule as the sidebar (ChatListItem): never-read chats are not unread.
    unread: lastReadAt ? new Date(chat.updated_at) > new Date(lastReadAt) : false,
    isTriggered: meta.triggered === true,
    ...(typeof meta.provider === "string" && meta.provider && { provider: meta.provider }),
    ...(typeof meta.agentAlias === "string" && meta.agentAlias && { agentAlias: meta.agentAlias }),
    ...(typeof meta.jobRunId === "string" && meta.jobRunId && { jobRunId: meta.jobRunId }),
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

export function buildCardSummaries(cards: Card[], allChats: Chat[], allRuns: JobRunListItem[], deps: RollupDeps = ROLLUP_DEPS): CardSummary[] {
  const chatsByCard = new Map<string, CardMemberChat[]>();
  for (const chat of allChats) {
    const meta = parseMeta(chat);
    const cardId = metaCardId(meta);
    if (!cardId) continue;
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
