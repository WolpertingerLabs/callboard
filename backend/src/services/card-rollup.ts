/**
 * Card rollup — aggregates member chats and job runs into per-card
 * summaries for the /board view.
 *
 * In the cards-as-metadata model a card IS its lineage root chat.  The
 * rollup derives the card list from the chat corpus: every lineage root
 * that is not triggered and not a job-step chat is a card, with fields
 * read from `metadata.card` (absent means all defaults).  Membership is
 * discovered via the lineage tree — all chats whose `existingRootIdOf` resolves
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
import { statSync } from "fs";
import type { Card, CardChatActivity, CardMemberChat, CardMemberRun, CardPendingKind, CardRollupState, CardSummary, Chat, JobRunListItem } from "shared";
import { isMtimeSettled } from "../utils/mtime-freshness.js";
import { buildLineageIndex } from "./chat-lineage.js";
import { cardFieldsFromChat, isCardEligible } from "./card-fields.js";
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
 * Previews by session ID — hits AND misses.
 *
 * Caching only the hits is what made `GET /api/cards` a ~1.6 s freeze of the
 * whole daemon. Measured on an 8,322-record data dir: the rollup calls
 * `previewOf` 1,015 times (630 distinct sessions), of which only 171 resolve.
 * The other 459 name a session no provider can find — a chat whose harness
 * was removed, or whose log was deleted out from under its record — and each
 * of those costs a walk of all five providers, which for claude-code means an
 * `existsSync` per project directory. Uncached that is 823 ms of the 1,566 ms
 * rollup, re-paid on every request, and the board polls every 15 s per open
 * tab and refetches on every metadata change.
 *
 * A hit never goes stale (a session's first user message is immutable once
 * written), so the only question is how a *miss* is allowed to become a hit
 * again. Two shapes of miss, invalidated differently, because only one of
 * them has a file to stat:
 *
 *   - "empty": the log was found but holds no user message yet. Gated on the
 *     log's `(mtimeNs, size)` exactly the way chats-snapshot.ts gates its
 *     entries — one stat instead of a provider walk, and the first message
 *     written to that log invalidates the entry by moving both halves.
 *   - "unresolved": no provider resolves the session at all, so there is no
 *     path to stat and no file whose change could invalidate anything. Bounded
 *     by {@link UNRESOLVED_RECHECK_MS} instead: a log that appears later is
 *     picked up within one window rather than never, and the 459 dead lookups
 *     are paid once per window rather than once per request — and never all in
 *     one request, see {@link UNRESOLVED_RECHECK_BUDGET_PER_SEC}.
 *
 * Bounded by the chat corpus, like the snapshot's own index: keys are session
 * ids that appear in it, and nothing else is ever inserted.
 */
type PreviewEntry =
  | { kind: "hit"; preview: string }
  | { kind: "empty"; logPath: string; mtimeNs: bigint; size: bigint }
  | { kind: "unresolved"; checkedAt: number };

const previewCache = new Map<string, PreviewEntry>();

/**
 * How long a "this session resolves to no log at all" verdict stands before
 * the provider walk is repeated.
 *
 * Long enough that neither the board's 15 s poll nor a burst of metadata-driven
 * refetches re-pays the walk, and short enough that a session whose log shows
 * up late (a chat spawned against a provider that writes its log on first turn)
 * gets its preview without waiting for a daemon restart.
 */
export const UNRESOLVED_RECHECK_MS = 5 * 60_000;

/**
 * How many unresolved sessions may be re-walked per second, across all callers.
 *
 * The window above bounds how *often* the dead lookups are paid; this bounds
 * how many land in any one synchronous rollup, which is the thing the user
 * actually feels. Without it, 459 entries falling due together would put the
 * whole ~823 ms walk back into a single request — the freeze this cache exists
 * to remove, merely made periodic. At ~1.8 ms per walk on the measured corpus,
 * 25 is about 45 ms: invisible next to the ~38 ms warm rollup, while still
 * revisiting every entry of a 459-strong backlog inside a couple of polls.
 *
 * An entry passed over keeps its old `checkedAt`, so it stays due and is simply
 * picked up by the next request rather than skipped for a whole window.
 */
export const UNRESOLVED_RECHECK_BUDGET_PER_SEC = 25;

let recheckWindowStart = 0;
let recheckWindowUsed = 0;

/** Claim one of this second's unresolved re-walks, or decline. */
function claimRecheckBudget(now: number): boolean {
  if (now - recheckWindowStart >= 1_000) {
    recheckWindowStart = now;
    recheckWindowUsed = 0;
  }
  if (recheckWindowUsed >= UNRESOLVED_RECHECK_BUDGET_PER_SEC) return false;
  recheckWindowUsed++;
  return true;
}

/**
 * Resolve a session's preview through the cache above. Returns null for both
 * shapes of miss; the caller cannot tell them apart and does not need to.
 */
function cachedPreviewOf(sessionId: string, now: number = Date.now()): string | null {
  const cached = previewCache.get(sessionId);
  if (cached) {
    if (cached.kind === "hit") return cached.preview;
    if (cached.kind === "unresolved") {
      if (now - cached.checkedAt < UNRESOLVED_RECHECK_MS) return null;
      if (!claimRecheckBudget(now)) return null;
    } else {
      try {
        const stats = statSync(cached.logPath, { bigint: true });
        if (stats.mtimeNs === cached.mtimeNs && stats.size === cached.size) return null;
      } catch {
        // Log deleted since: fall through to the walk, which will land on
        // "unresolved" and stop stat-ing a path that no longer exists.
      }
    }
  }

  for (const provider of getSessionProviders()) {
    const resolved = provider.resolveSession(sessionId);
    if (!resolved) continue;
    const preview = provider.getSessionPreview(resolved.logPath);
    if (preview) {
      previewCache.set(sessionId, { kind: "hit", preview });
      return preview;
    }
    // Same caching rule as chats-snapshot.ts: an entry whose mtime tick has
    // not closed yet is not cacheable, because a later write could still land
    // inside it and present an unchanged (mtimeNs, size). Statting AFTER the
    // read would let a slow read talk us into trusting a stale timestamp, so
    // a stat failure here simply declines to cache.
    try {
      const stats = statSync(resolved.logPath, { bigint: true });
      if (isMtimeSettled(stats.mtimeNs, now)) {
        previewCache.set(sessionId, { kind: "empty", logPath: resolved.logPath, mtimeNs: stats.mtimeNs, size: stats.size });
      } else {
        previewCache.delete(sessionId);
      }
    } catch {
      previewCache.delete(sessionId);
    }
    return null;
  }

  previewCache.set(sessionId, { kind: "unresolved", checkedAt: now });
  return null;
}

/** Drop every cached preview verdict. For tests; production never needs it. */
export function resetPreviewCache(): void {
  previewCache.clear();
  recheckWindowStart = 0;
  recheckWindowUsed = 0;
}

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
  previewOf: (sessionId) => cachedPreviewOf(sessionId),
};

/** Run statuses that count as "the job is still going" for the rollup. */
const RUN_ACTIVE_STATUSES: ReadonlySet<string> = new Set(["running", "sleeping", "waiting_child", "waiting_event"]);

type ChatMeta = Record<string, unknown>;

function parseMeta(chat: Chat): ChatMeta {
  try {
    const parsed: unknown = JSON.parse(chat.metadata || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ChatMeta) : {};
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
 * `isCardEligible` becomes a card, its fields projected from the SAME snapshot
 * record (`cardFieldsFromChat`) — never a second store read. Chats are grouped
 * by their highest existing root; runs by `run.rootChatId` (falling back to a
 * surviving latest chat after root deletion). Hidden cards
 * (`metadata.card.hidden === true`) are omitted from the board view.
 */
export function buildCardSummaries(
  chats: Chat[],
  allRuns: JobRunListItem[],
  deps: RollupDeps = ROLLUP_DEPS,
  opts: { includeHidden?: boolean } = {},
): CardSummary[] {
  const { existingRootIdOf } = buildLineageIndex(chats);

  // Find every lineage root that qualifies as a card, with its projected
  // fields. Hidden cards are opted out of the board (replacement for the
  // old createCard: false).
  const cardsByRoot = new Map<string, Card>();
  for (const chat of chats) {
    if (existingRootIdOf(chat.id) !== chat.id) continue;
    if (!isCardEligible(chat)) continue;
    // Raw file records do not carry metadata.preview. Use the same immutable
    // first-user-message fallback as the member row so a CLI-created or
    // otherwise untitled root does not produce an "Untitled" card face.
    const card = cardFieldsFromChat(chat, () => deps.previewOf(chat.session_id));
    if (card.hidden && !opts.includeHidden) continue;
    cardsByRoot.set(chat.id, card);
  }

  // Group chats by root.
  const chatsByRoot = new Map<string, CardMemberChat[]>();
  for (const chat of chats) {
    const rootId = existingRootIdOf(chat.id);
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
    // A deleted root promotes the run's latest surviving step chat along with
    // the rest of that tree. Old runs retain their historical rootChatId, so
    // fall back through latestChatId when that root no longer names a card.
    const rootId =
      (run.rootChatId && cardsByRoot.has(run.rootChatId) ? run.rootChatId : undefined) ??
      (run.latestChatId ? existingRootIdOf(run.latestChatId) : undefined);
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
