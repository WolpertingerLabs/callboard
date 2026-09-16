import { collectContentMatches } from "./chat-content-search.js";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { Chat } from "shared";
import { filterChatRows, cardLifecycleFor, type ChatFilters } from "shared/types/chat-filters.js";
import { discoverChatCorpus } from "./chat-discovery.js";
import { createCardMembership } from "./card-membership.js";
import { listChatsSnapshot } from "./chats-snapshot.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { cardLifecycleOf, rawCardFields } from "./card-fields.js";
import { createTriggeredPredicate, cardIsArchived } from "./chat-visibility.js";
import { isIgnoredProjectFolder } from "../utils/paths.js";
import { isRetiredProvider } from "../agents/ports/AgentProvider.js";
import { chatViews, type ChatViewBinding } from "./chat-view.js";

export class ChatQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export const searchChatsSchema = {
  scope: z.enum(["all", "visible"]).optional(),
  topLevelOnly: z.boolean().optional(),
  anyOf: z
    .array(z.enum(["pinned", "bookmarked", "open_card"]))
    .min(1)
    .max(3)
    .optional(),
  query: z.string().max(2000).optional(),
  folder: z.string().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
};
export const searchChatsInput = z.object(searchChatsSchema).strict();
export type SearchChatsInput = z.infer<typeof searchChatsInput>;

let advancedWorkers = 0;
/** Same pure browser matcher, isolated from the event loop with a hard deadline. */
export async function matchAdvanced<T extends { folder: string; displayFolder?: string; updated_at: string }>(
  rows: T[],
  filters: ChatFilters,
): Promise<{ rows: T[]; warnings: string[] }> {
  if (!Object.values(filters).some((f) => f.active && f.value)) return { rows, warnings: [] };
  if (advancedWorkers >= 2) throw new ChatQueryError("CHAT_FILTER_BUSY", "Visible-filter workers busy; retry this query");
  advancedWorkers++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(
        `(async () => { const {parentPort, workerData} = await import("node:worker_threads"); parentPort.postMessage((${filterChatRows.toString()})(workerData.rows, workerData.filters)); })();`,
        { eval: true, workerData: { rows, filters }, resourceLimits: { maxOldGenerationSizeMb: 128 } },
      );
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new ChatQueryError("CHAT_FILTER_TIMEOUT", "Visible directory filter exceeded evaluation budget"));
      }, 1500);
      worker.once("message", (value) => {
        clearTimeout(timer);
        void worker.terminate();
        resolve(value);
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error("Visible filter worker terminated"));
      });
    });
  } finally {
    advancedWorkers--;
  }
}

export async function searchChats(input: SearchChatsInput, binding?: ChatViewBinding) {
  const args = searchChatsInput.parse(input);
  const scope = args.scope ?? "all";
  const view = scope === "visible" ? chatViews.read(binding) : undefined;
  if (view && !view.available) throw new ChatQueryError("CHAT_VIEW_UNAVAILABLE", `CHAT_VIEW_UNAVAILABLE: ${view.reason}`);
  const asOf = new Date().toISOString();
  const stored = listChatsSnapshot();
  const membership = createCardMembership(stored);
  const discovery = discoverChatCorpus();
  const warnings = [...discovery.warnings];
  if (membership.nativeDiscoveryIncomplete) warnings.push("Native lineage discovery incomplete");
  const owners = new Map<string, Chat[]>();
  for (const chat of stored) {
    const meta = parseChatMetadata(chat.metadata);
    for (const sid of new Set([chat.session_id, ...(Array.isArray(meta.session_ids) ? meta.session_ids : [])])) {
      if (typeof sid !== "string") continue;
      const list = owners.get(sid) ?? [];
      list.push(chat);
      owners.set(sid, list);
    }
  }
  const discoveryBySession = new Map<string, typeof discovery.sessions>();
  for (const session of discovery.sessions) {
    const list = discoveryBySession.get(session.sessionId) ?? [];
    list.push(session);
    discoveryBySession.set(session.sessionId, list);
  }
  const routing = new Map<string, { provider: string; vendor?: string }>();
  const rejectedIds = new Set<string>();
  for (const chat of stored) {
    const meta = parseChatMetadata(chat.metadata);
    const current = (discoveryBySession.get(chat.session_id) ?? []).filter(
      (s) => (!meta.provider || meta.provider === s.providerKind) && (!meta.acpProviderId || meta.acpProviderId === s.acpProviderId),
    );
    const aliases = Array.isArray(meta.session_ids) ? meta.session_ids : [];
    const evidence = current.length ? current : aliases.flatMap((sid) => (typeof sid === "string" ? (discoveryBySession.get(sid) ?? []) : []));
    const namespaces = new Map(
      evidence
        .filter((s) => !meta.provider || meta.provider === s.providerKind)
        .map((s) => [JSON.stringify([s.providerKind, s.acpProviderId]), { provider: s.providerKind, vendor: s.acpProviderId }]),
    );
    if (typeof meta.provider === "string" && (meta.provider !== "acp" || typeof meta.acpProviderId === "string")) {
      routing.set(chat.id, { provider: meta.provider, ...(typeof meta.acpProviderId === "string" && { vendor: meta.acpProviderId }) });
    } else if (namespaces.size === 1) routing.set(chat.id, namespaces.values().next().value!);
    else if (evidence.length) {
      rejectedIds.add(chat.id);
      warnings.push(`Ambiguous provider ownership for ${chat.id}`);
    }
  }
  const rows = new Map<string, Chat & { displayFolder?: string }>();
  const identities = new Map<string, Set<string>>();
  for (const session of discovery.sessions) {
    const knownOwners = owners.get(session.sessionId) ?? [];
    const candidates = knownOwners.filter((chat) => {
      const owner = routing.get(chat.id);
      return owner?.provider === session.providerKind && owner.vendor === session.acpProviderId;
    });
    if (candidates.length > 1) {
      for (const chat of candidates) {
        rejectedIds.add(chat.id);
        rows.delete(chat.id);
      }
      warnings.push(`Ambiguous stored owners for ${session.providerKind} session ${session.sessionId}`);
      continue;
    }
    const storedChat = candidates[0];
    if (!storedChat && knownOwners.length) {
      // Historical cross-engine aliases belong to the logical chat, never a new
      // standalone row. Preserve content matches without guessing current routing.
      if (knownOwners.length === 1 && knownOwners[0].session_id !== session.sessionId) {
        const owner = knownOwners[0];
        const keys = identities.get(owner.id) ?? new Set<string>();
        keys.add(JSON.stringify([session.providerKind, session.sessionId]));
        identities.set(owner.id, keys);
      } else {
        for (const chat of knownOwners) {
          rejectedIds.add(chat.id);
          rows.delete(chat.id);
        }
        warnings.push(`Session ownership does not match stored routing for ${session.sessionId}`);
      }
      continue;
    }
    const id = storedChat?.id ?? session.sessionId;
    if (rejectedIds.has(id)) continue;
    const enriched = membership.corpus.get(id);
    if (!storedChat && enriched && enriched.session_id !== session.sessionId) {
      warnings.push(`Chat/session identity collision: ${id}`);
      continue;
    }
    const meta = parseChatMetadata((storedChat ? (enriched ?? storedChat) : enriched)?.metadata);
    if (meta.provider && meta.provider !== session.providerKind) {
      warnings.push(`Provider identity collision: ${id}`);
      continue;
    }
    const previous = rows.get(id);
    if (previous) {
      const prior = parseChatMetadata(previous.metadata);
      if (prior.provider !== session.providerKind || prior.acpProviderId !== session.acpProviderId) {
        rows.delete(id);
        rejectedIds.add(id);
        warnings.push(`Ambiguous discovered identity: ${id}`);
        continue;
      }
    }
    const keys = identities.get(id) ?? new Set<string>();
    keys.add(JSON.stringify([session.providerKind, session.sessionId]));
    keys.add(JSON.stringify([session.providerKind, id]));
    identities.set(id, keys);
    if (previous) continue; // discovery is globally newest first; resumed aliases emit one chat
    rows.set(id, {
      ...storedChat,
      id,
      session_id: session.sessionId,
      folder: session.folder,
      displayFolder: session.displayFolder,
      session_log_path: session.filePath,
      created_at: session.createdAt.toISOString(),
      updated_at: session.updatedAt.toISOString(),
      metadata: JSON.stringify({ ...meta, provider: session.providerKind, ...(session.acpProviderId && { acpProviderId: session.acpProviderId }) }),
    });
  }
  // Stored-only pins and tree relatives are the sidebar's appendables, not every stale record.
  const touchedRoots = new Set([...rows.keys()].map((id) => membership.index.rootKeyOf(id)));
  for (const chat of stored) {
    if (rejectedIds.has(chat.id) || rows.has(chat.id) || isIgnoredProjectFolder(chat.folder) || isRetiredProvider(parseChatMetadata(chat.metadata).provider))
      continue;
    const meta = parseChatMetadata(chat.metadata);
    const related =
      (membership.index.parentIdOf(chat.id) || membership.index.childrenByParent.has(chat.id)) && touchedRoots.has(membership.index.rootKeyOf(chat.id));
    if (meta.pinned === true || related) rows.set(chat.id, membership.corpus.get(chat.id) ?? chat);
  }
  const survivesTriggered = createTriggeredPredicate();
  let candidates = [...rows.values()].filter((chat) => {
    if (isIgnoredProjectFolder(chat.folder)) return false;
    const rootId = membership.index.existingRootIdOf(chat.id);
    const root = membership.roots.has(rootId) ? membership.storedById.get(rootId) : undefined;
    const meta = parseChatMetadata(chat.metadata);
    if (args.topLevelOnly && (rootId !== chat.id || !!meta.nativeAgent)) return false;
    if (args.folder !== undefined && chat.folder !== args.folder) return false;
    if (view?.available) {
      if (view.options.bookmarked && meta.bookmarked !== true) return false;
      if (!view.options.showTriggered && !survivesTriggered(chat)) return false;
      if (cardLifecycleFor({ showArchived: view.options.showArchived, searching: !!view.submittedSearch }) !== "all" && root && cardIsArchived(root))
        return false;
    }
    const reasons = [
      ...(meta.pinned === true ? ["pinned"] : []),
      ...(meta.bookmarked === true ? ["bookmarked"] : []),
      ...(root && !isIgnoredProjectFolder(root.folder) && !cardIsArchived(root) ? ["open_card"] : []),
    ];
    if (args.anyOf && !args.anyOf.some((reason) => reasons.includes(reason))) return false;
    const query = args.query?.trim().toLowerCase();
    return (
      !query || [meta.title, meta.preview, chat.folder, chat.displayFolder].some((value) => typeof value === "string" && value.toLowerCase().includes(query))
    );
  });
  if (view?.available) {
    const advanced = await matchAdvanced(candidates, view.filters);
    candidates = advanced.rows;
    warnings.push(...advanced.warnings);
    if (view.submittedSearch) {
      const content = await collectContentMatches(view.submittedSearch, discovery.sessions, stored);
      warnings.push(...content.warnings);
      candidates = candidates.filter((chat) => [...(identities.get(chat.id) ?? [])].some((key) => content.keys.has(key)));
    }
  }
  candidates.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const offset = args.offset ?? 0,
    limit = args.limit ?? 20;
  const page = candidates.slice(offset, offset + limit);
  // Ignored invalid regexes preserve the browser's documented skip semantics, not partial discovery.
  const partial = warnings.some((w) => !w.startsWith("Ignored invalid "));
  const moreKnown = offset + limit < candidates.length;
  return {
    chats: page.map((chat) => {
      const meta = parseChatMetadata(chat.metadata);
      const rootChatId = membership.index.existingRootIdOf(chat.id);
      const root = membership.roots.has(rootChatId) ? membership.storedById.get(rootChatId) : undefined;
      const card =
        root && !isIgnoredProjectFolder(root.folder)
          ? { chatId: root.id, lifecycle: cardLifecycleOf(root), hidden: rawCardFields(root).hidden === true }
          : null;
      const reasons = [
        ...(meta.pinned === true ? ["pinned"] : []),
        ...(meta.bookmarked === true ? ["bookmarked"] : []),
        ...(card && card.lifecycle === "open" && !card.hidden ? ["open_card"] : []),
      ];
      return {
        chatId: chat.id,
        sessionId: chat.session_id,
        provider: meta.provider ?? null,
        acpProviderId: meta.acpProviderId,
        title: typeof (meta.title ?? meta.preview) === "string" ? String(meta.title ?? meta.preview).slice(0, 300) : null,
        folder: chat.folder,
        displayFolder: chat.displayFolder ?? chat.folder,
        createdAt: chat.created_at,
        updatedAt: chat.updated_at,
        parentChatId: membership.index.parentIdOf(chat.id) ?? null,
        rootChatId,
        pinned: meta.pinned === true,
        bookmarked: meta.bookmarked === true,
        card,
        ...(meta.nativeAgent && { readOnly: true, management: "native_provider", nativeParentSessionId: meta.nativeAgent.parentThreadId }),
        ...(args.anyOf && { matchedReasons: reasons.filter((reason) => args.anyOf!.includes(reason as NonNullable<SearchChatsInput["anyOf"]>[number])) }),
      };
    }),
    total: partial ? null : candidates.length,
    observedMatches: candidates.length,
    hasMore: moreKnown ? true : partial ? null : false,
    nextOffset: moreKnown ? offset + limit : null,
    asOf,
    partial,
    warnings: [...new Set(warnings)],
    appliedFilters: {
      ...args,
      scope,
      topLevelOnly: args.topLevelOnly ?? false,
      limit,
      offset,
      ...(view?.available && {
        view,
        contentSearchSemantics:
          "Provider-specific: Claude uses case-insensitive basic grep; Codex uses first prompt or native nickname; Cline/ACP use first-message previews; Pi uses derived message text. Not a full-text index.",
      }),
    },
  };
}
