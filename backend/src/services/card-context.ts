/** Request-scoped card discovery. Never adopts chats; only stored roots anchor cards.
 * One bounded metadata walk serves all targets (including bulk edits). Lifecycle
 * is evaluated only for returned members, under one response-wide byte budget.
 */
import type { Chat, JobRunListItem } from "shared";
import { CodexSessionProvider } from "../agents/adapters/codex/CodexSessionProvider.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { buildLineageIndex } from "./chat-lineage.js";
import { listChatsSnapshot } from "./chats-snapshot.js";
import { isCardEligible } from "./card-fields.js";
import { buildCardSummaries, ROLLUP_DEPS } from "./card-rollup.js";
import { createLifecycleBudget, nativeMetadata, readNativeLifecycle } from "./codex-native-agents.js";

export function createCardContext(stored = listChatsSnapshot()) {
  const storedById = new Map(stored.map((chat) => [chat.id, chat]));
  const bySession = new Map<string, Chat>();
  const ambiguous = new Set<string>();
  for (const chat of stored) {
    if (bySession.has(chat.session_id)) ambiguous.add(chat.session_id);
    bySession.set(chat.session_id, chat);
  }
  for (const id of ambiguous) bySession.delete(id);
  const nativeAliases = new Map<string, string>();
  const corpus = new Map(
    stored.map((chat) => [
      chat.id,
      {
        ...chat,
        metadata: JSON.stringify(nativeMetadata("", chat.session_id, parseChatMetadata(chat.metadata), false)),
      },
    ]),
  );
  for (const entry of new CodexSessionProvider().nativeDiscoveryEvidence()) {
    if (ambiguous.has(entry.threadId)) continue;
    const chat = bySession.get(entry.threadId);
    const existing = parseChatMetadata(chat?.metadata);
    if (existing.provider && existing.provider !== "codex") continue;
    // Filesystem-only roots are NOT cards, nor bridges to an unrelated card.
    if (!entry.meta.nativeAgent) continue;
    if (!chat && storedById.has(entry.threadId)) continue;
    // A parent session with multiple stored owners cannot establish parentage.
    if (ambiguous.has(entry.meta.nativeAgent.parentThreadId) && !existing.parentChatId && !existing.forkedFrom) continue;
    const parent = bySession.get(entry.meta.nativeAgent.parentThreadId);
    const parentProvider = parseChatMetadata(parent?.metadata).provider;
    if (parentProvider && parentProvider !== "codex" && !existing.parentChatId && !existing.forkedFrom) continue;
    if (chat && !storedById.has(entry.threadId)) nativeAliases.set(entry.threadId, chat.id);
    const metadata = nativeMetadata(entry.filePath, entry.threadId, existing, false, undefined, bySession, entry.meta);
    corpus.set(chat?.id ?? entry.threadId, {
      ...chat,
      id: chat?.id ?? entry.threadId,
      session_id: entry.threadId,
      folder: chat?.folder ?? entry.meta.cwd ?? "",
      metadata: JSON.stringify(metadata),
      session_log_path: entry.filePath,
      created_at: chat?.created_at ?? entry.stat.birthtime.toISOString(),
      updated_at: entry.stat.mtime.toISOString(),
    });
  }
  const index = buildLineageIndex([...corpus.values()]);
  const isNative = (chat?: Chat) => {
    const meta = parseChatMetadata(chat?.metadata);
    return meta.provider === "codex" && !!meta.nativeAgent;
  };
  // A stored native record with lost parent evidence is not promoted to a
  // standalone card. Ordinary stored orphans retain historical promotion.
  const roots = new Set(
    stored.filter((chat) => index.existingRootIdOf(chat.id) === chat.id && isCardEligible(chat) && !isNative(corpus.get(chat.id))).map((chat) => chat.id),
  );
  const chats = [...corpus.values()].filter((chat) => roots.has(index.existingRootIdOf(chat.id)));
  return {
    resolve(id: string): { rootChatId: string } | null {
      if (!id || /[/\\\0]/.test(id) || id === "." || id === "..") return null;
      id = nativeAliases.get(id) ?? id;
      if (!index.byId.has(id)) return null;
      const rootChatId = index.existingRootIdOf(id);
      return roots.has(rootChatId) ? { rootChatId } : null;
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
    summaries(runs: JobRunListItem[], includeHidden = false, rootId?: string | ReadonlySet<string>) {
      const budget = createLifecycleBudget();
      const rootIds = typeof rootId === "string" ? new Set([rootId]) : rootId;
      const selected = rootIds ? chats.filter((chat) => rootIds.has(index.existingRootIdOf(chat.id))) : chats;
      return buildCardSummaries(
        selected,
        runs,
        {
          ...ROLLUP_DEPS,
          nativeLifecycleOf: (chat) => (chat.session_log_path ? readNativeLifecycle(chat.session_log_path, Date.now(), budget) : "unknown"),
        },
        { includeHidden },
      );
    },
  };
}
