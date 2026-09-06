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
  const ownersBySession = new Map<string, Chat[]>();
  for (const chat of stored) {
    const owners = ownersBySession.get(chat.session_id) ?? [];
    owners.push(chat);
    ownersBySession.set(chat.session_id, owners);
  }
  const bySession = new Map([...ownersBySession].flatMap(([id, owners]) => (owners.length === 1 ? [[id, owners[0]] as const] : [])));
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
  const verifiedParents = new Map<string, string>();
  const syntheticParents = new Map<string, string>();

  // Classification does not depend on whether an inferred parent edge is usable.
  // Even ambiguous stored owners retain positive native evidence; they cannot
  // silently become ordinary standalone cards when edge resolution fails.
  for (const entry of new CodexSessionProvider().nativeDiscoveryEvidence()) {
    if (!entry.meta.nativeAgent) continue;
    const owners = ownersBySession.get(entry.threadId) ?? [];
    if (!owners.length && storedById.has(entry.threadId)) continue; // Different namespaces, same spelling.
    const compatible = owners.filter((chat) => {
      const provider = parseChatMetadata(chat.metadata).provider;
      return !provider || provider === "codex";
    });
    const targets: (Chat | undefined)[] = owners.length ? compatible : [undefined];
    for (const chat of targets) {
      const id = chat?.id ?? entry.threadId;
      const metadata = nativeMetadata(entry.filePath, entry.threadId, parseChatMetadata(chat?.metadata), false, undefined, bySession, entry.meta);
      corpus.set(id, {
        ...chat,
        id,
        session_id: entry.threadId,
        folder: chat?.folder ?? entry.meta.cwd ?? "",
        metadata: JSON.stringify(metadata),
        session_log_path: entry.filePath,
        created_at: chat?.created_at ?? entry.stat.birthtime.toISOString(),
        updated_at: entry.stat.mtime.toISOString(),
      });
      verifiedParents.set(id, entry.meta.nativeAgent.parentThreadId);
      if (!chat) syntheticParents.set(entry.threadId, id);
      else if (owners.length === 1 && !storedById.has(entry.threadId)) nativeAliases.set(entry.threadId, id);
    }
  }

  // Resolve native SESSION parent IDs only through their own namespace. Never
  // hand a raw unresolved session ID to the CHAT lineage index. A synthetic
  // parent is usable only if it was independently verified in the pass above.
  for (const [id, chat] of corpus) {
    const meta = parseChatMetadata(chat.metadata);
    if (meta.provider !== "codex" || !meta.nativeAgent) continue;
    const prior = parseChatMetadata(storedById.get(id)?.metadata);
    const explicitParent = typeof prior.parentChatId === "string" && !!prior.parentChatId && prior.nativeAgent?.inferredParentChatId !== prior.parentChatId;
    const explicitFork = typeof prior.forkedFrom === "string" && !!prior.forkedFrom;
    if (explicitParent) continue;
    delete meta.parentChatId; // Includes legacy persisted inferred pointers.
    if (!explicitFork) {
      delete meta.rootChatId; // A stamp cannot bypass rejected inferred ancestry.
      const parentSession = verifiedParents.get(id);
      const owners = parentSession ? ownersBySession.get(parentSession) : undefined;
      const owner = owners?.length === 1 ? owners[0] : undefined;
      const provider = parseChatMetadata(owner?.metadata).provider;
      const parentId = owner && (!provider || provider === "codex") ? owner.id : !owners && parentSession ? syntheticParents.get(parentSession) : undefined;
      if (parentId) {
        meta.parentChatId = parentId;
        meta.nativeAgent = { ...meta.nativeAgent, inferredParentChatId: parentId };
      }
    }
    corpus.set(id, { ...chat, metadata: JSON.stringify(meta) });
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
          nativeLifecycleOf: (chat) => (chat.session_log_path ? readNativeLifecycle(chat.session_log_path, Date.now(), budget, chat.session_id) : "unknown"),
        },
        { includeHidden },
      );
    },
  };
}
