import { createCardMembership } from "./card-membership.js";
/** Request-scoped card discovery. Never adopts chats; only stored roots anchor cards.
 * One bounded metadata walk serves all targets (including bulk edits). Lifecycle
 * is evaluated only for returned members, under one response-wide byte budget.
 */
import type { CardLifecycle, Chat, JobRunListItem } from "shared";
import { listChatsSnapshot } from "./chats-snapshot.js";
import { buildCardBoard, buildCardSummaries, ROLLUP_DEPS, type RollupDeps } from "./card-rollup.js";
import { createLifecycleBudget, readNativeLifecycle } from "./codex-native-agents.js";

export function createCardContext(stored = listChatsSnapshot()) {
  const { corpus, index, roots, chats, nativeAliases, isNative, nativeDiscoveryIncomplete, storedById } = createCardMembership(stored);
  return {
    /**
     * True when the native discovery pass behind this context ran out of
     * metadata budget: filesystem-only native children older than what it
     * reached are absent from these cards until a later pass reads them.
     */
    nativeDiscoveryIncomplete: nativeDiscoveryIncomplete,
    resolve(id: string): { rootChatId: string } | null {
      if (!id || /[/\\\0]/.test(id) || id === "." || id === "..") return null;
      id = nativeAliases.get(id) ?? id;
      if (!index.byId.has(id)) return null;
      const rootChatId = index.existingRootIdOf(id);
      return roots.has(rootChatId) ? { rootChatId } : null;
    },
    /**
     * Like {@link resolve}, but for ANY lineage tree rather than card trees
     * only: the root a chat id belongs to, and whether that root is a card.
     * What the chat-level archive needs, since a triggered or job-step tree
     * can be archived without being a card. `stored` is the root's own record,
     * absent for a root discovery inferred but nothing ever persisted.
     */
    resolveLineageRoot(id: string): { rootChatId: string; isCard: boolean; stored?: Chat } | null {
      if (!id || /[/\\\0]/.test(id) || id === "." || id === "..") return null;
      id = nativeAliases.get(id) ?? id;
      if (!index.byId.has(id)) return null;
      const rootChatId = index.existingRootIdOf(id);
      return { rootChatId, isCard: roots.has(rootChatId), stored: storedById.get(rootChatId) };
    },
    isNativeTarget(id: string): boolean {
      const chat = corpus.get(nativeAliases.get(id) ?? id);
      return isNative(chat);
    },
    /** Refresh only a successfully edited stored root, without repeating discovery. */
    replaceRoot(chat: Chat) {
      if (!roots.has(chat.id)) return;
      const position = chats.findIndex((item) => item.id === chat.id);
      chats[position] = chat;
    },
    summaries(runs: JobRunListItem[], includeHidden = false, rootId?: string | ReadonlySet<string>, lifecycle?: CardLifecycle) {
      const rootIds = typeof rootId === "string" ? new Set([rootId]) : rootId;
      const selected = rootIds ? chats.filter((chat) => rootIds.has(index.existingRootIdOf(chat.id))) : chats;
      return buildCardSummaries(selected, runs, budgetedDeps(), { includeHidden, lifecycle });
    },
    /** The whole board, with the archive optionally windowed — see {@link buildCardBoard}. */
    board(runs: JobRunListItem[], includeHidden = false, window: { closedLimit?: number; closedSince?: number } = {}) {
      return buildCardBoard(chats, runs, budgetedDeps(), { includeHidden, ...window });
    },
  };
}

/** Rollup deps whose native-lifecycle reads share one response-wide byte budget. */
function budgetedDeps(): RollupDeps {
  const budget = createLifecycleBudget();
  return {
    ...ROLLUP_DEPS,
    nativeLifecycleOf: (chat) => (chat.session_log_path ? readNativeLifecycle(chat.session_log_path, Date.now(), budget, chat.session_id) : "unknown"),
  };
}
