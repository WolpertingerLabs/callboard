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
import { isRetiredProvider, type AgentProviderKind } from "../agents/ports/AgentProvider.js";
import { isAbsolute } from "node:path";
import { chatViews, type ChatViewBinding } from "./chat-view.js";
import { createLiveBranchResolver, createRepoScope, type BranchSource, type RepoVerdict } from "./chat-repo-scope.js";
import { getParentChatId } from "./chat-lineage.js";

export class ChatQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** A date bound the caller can actually have meant. Parsed, not compared as text. */
const instant = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: "must be an ISO-8601 date or date-time" });

/**
 * A path the daemon can resolve the same way the caller meant it.
 *
 * A relative path would resolve against the **daemon's** working directory —
 * the global install, not the agent's worktree — and produce a confident empty
 * page either way. There is no spelling of "the agent's cwd" this process can
 * recover, so the only safe contract is to reject the ambiguity.
 */
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value), { message: "must be an absolute path (a relative one would resolve against the daemon's cwd, not yours)" });

/**
 * Every field carries its own `.describe()`, because the generated JSON Schema
 * is all an agent ever sees. `mcp-tool-registry.ts` mirrors these strings for
 * the browser's REST tool listing and `mcp-tool-registry.manifest.test.ts`
 * guards the two against drifting apart — but the registry is not in the
 * agent's path, and documentation that lives only there is documentation the
 * caller does not have.
 */
export const searchChatsSchema = {
  scope: z.enum(["all", "visible"]).optional().describe("all (default) searches every chat; visible restricts to the originating browser tab's live sidebar filters"),
  topLevelOnly: z.boolean().optional().describe("Only surviving lineage roots, excluding native provider children"),
  anyOf: z
    .array(z.enum(["pinned", "bookmarked", "open_card"]))
    .min(1)
    .max(3)
    .optional()
    .describe(
      "Nonempty OR over this chat's own pinned/bookmarked state and eligible open-card membership. Individual chat pins, not group or card pins. Matching rows report matchedReasons.",
    ),
  query: z
    .string()
    .max(2000)
    .optional()
    .describe("Case-insensitive substring over stored METADATA only — title, stored preview, folder text. Never reads a transcript; use grep for that."),
  folder: absolutePath
    .optional()
    .describe(
      "Exact working directory, absolute. Matches the chat's stored cwd or the browse projection of it. Does NOT expand to worktrees — use repo for that, and do not pass folder alongside rootChatId/parentChatId unless you mean to exclude relatives that ran elsewhere.",
    ),
  repo: absolutePath
    .optional()
    .describe(
      "Repo root, absolute; expands to the repo's worktrees. A worktree path is normalised up to its main checkout (reported as appliedFilters.repoRoot), so passing your own cwd works. Reaches removed worktrees when a workspace record names them or their directory was a direct sibling named <repo-name><.|-|_>...; a removed worktree elsewhere on disk (~/worktrees/foo) is NOT found. Read repoSource on each row for which rule admitted it.",
    ),
  branch: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      "Branch name. Matches metadata.lastBranch — the LAST branch the chat ran on, recorded by every engine, not every branch it ever touched — falling back to the directory's current branch when it still exists. Read branchSource on each row. Chats with neither are excluded and reported in warnings.",
    ),
  agentAlias: z.string().min(1).max(512).optional().describe("Exact alias of the agent that started the chat; rows report agentAlias"),
  triggered: z.boolean().optional().describe("true = automated (job/trigger) sessions, false = manual. Rows report triggered."),
  grep: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe(
      "Case-insensitive TRANSCRIPT content search. Requires at least one other filter — unscoped it opens the whole corpus (measured: 2,096 files / 1.15 GB / ~3.3s, versus 24 files / 613ms alongside anyOf:['open_card']). Semantics differ per engine, so read matchKind on each hit.",
    ),
  rootChatId: z.string().min(1).max(256).optional().describe("Chats in the tree rooted at this chat. GLOBAL — relatives that ran in other folders are included unless you also pass folder/repo."),
  parentChatId: z.string().min(1).max(256).optional().describe("Direct children of this chat. GLOBAL — children that ran in other folders are included unless you also pass folder/repo."),
  updatedAfter: instant.optional().describe("ISO-8601 date or date-time; only chats updated at or after this instant"),
  updatedBefore: instant.optional().describe("ISO-8601 date or date-time; only chats updated at or before this instant"),
  sort: z.enum(["updated", "created"]).optional().describe("Newest-first by update time (default) or creation time"),
  limit: z.number().int().min(1).max(100).optional().describe("Page size, 1-100, default 20"),
  offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().describe("Stable global offset, default 0; page with nextOffset"),
};

/**
 * What a `grep` hit against each engine actually proves.
 *
 * `grep` means different things per engine and the row has to say which, or a
 * Codex hit on a first prompt reads as a transcript hit. The readers behind
 * these are the same ones each adapter's `searchSessions` greps with and the
 * ones `chat-content-worker.ts` dispatches over, so this map describes the
 * engines, not this query path. It is keyed by {@link AgentProviderKind} so a
 * new engine is a compile error here rather than a silent `"transcript"`.
 *
 * `claude-code` and `pi` are deliberately *not* the same value. claude-code
 * greps the raw session JSONL — tool calls, tool results, file contents, all of
 * it. pi goes through `deriveSearchText`, which is conversational text and
 * summaries with no tool traffic. An agent hunting for a file path or a shell
 * command finds claude-code chats and no pi chats, and the honest reading of
 * that is "pi was searched less deeply", not "no pi session touched it".
 *
 * Codex native children are the exception handled at the call site: their
 * "first prompt" is the agent's nickname or path, which is metadata.
 */
export type MatchKind = "transcript" | "messages" | "first-prompt" | "metadata" | "unknown";
const MATCH_KIND: Record<AgentProviderKind, MatchKind> = {
  "claude-code": "transcript",
  pi: "messages",
  codex: "first-prompt",
  cline: "first-prompt",
  acp: "first-prompt",
  mock: "unknown",
};

/**
 * Filters that make `grep` affordable. `scope`/`sort`/paging are not here: they
 * change what a page looks like, not how many transcripts get opened.
 *
 * `find_chats` never needed this guard because its `folder` was **required**,
 * so it could not be called corpus-wide. `search_chats` can, and a corpus-wide
 * grep is reachable in one short argument list — which is exactly the shape an
 * agent produces on a first attempt.
 */
const GREP_NARROWING_FILTERS = [
  "folder",
  "repo",
  "anyOf",
  "query",
  "branch",
  "agentAlias",
  "triggered",
  "rootChatId",
  "parentChatId",
  "updatedAfter",
  "updatedBefore",
  "topLevelOnly",
] as const;
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
  // Refused rather than silently expensive. An unscoped grep opens every
  // transcript in the corpus, and the caller who typed `{ grep: "..." }` has no
  // way to know that from the result — it looks like any other page.
  if (args.grep !== undefined && scope !== "visible" && !GREP_NARROWING_FILTERS.some((key) => args[key] !== undefined)) {
    throw new ChatQueryError(
      "GREP_UNSCOPED",
      `grep opens every candidate transcript, so it needs a narrowing filter alongside it: ${GREP_NARROWING_FILTERS.join(", ")}, or scope:"visible". ` +
        `Unscoped that is 2,096 files and ~3.3s on a corpus this size; anyOf:["open_card"] makes it 24 files and 613ms.`,
    );
  }
  const asOf = new Date().toISOString();
  const stored = listChatsSnapshot();
  const membership = createCardMembership(stored);
  const discovery = discoverChatCorpus();
  const warnings = [...discovery.warnings];
  warnings.push(...membership.nativeDiscoveryWarnings);
  if (membership.nativeDiscoveryIncomplete) warnings.push("Native lineage discovery incomplete; unverified Codex chats and dependent lineage omitted");
  // A budget miss is unknown lineage, not proof of an ordinary root. Retain
  // the captured evidence boundary even if later discovery warms the cache.
  const unsafeNativeSession = (sid: string) =>
    membership.rejectedNativeSessions.has(sid) || (membership.nativeDiscoveryIncomplete && !membership.verifiedNativeSessions.has(sid));
  const unsafeNative = (chat: Chat) => {
    const canonical = membership.storedById.get(chat.id);
    const meta = parseChatMetadata(chat.metadata);
    const canonicalProvider = parseChatMetadata(canonical?.metadata).provider;
    const route = routing.get(chat.id);
    const sid = canonical?.session_id ?? chat.session_id;
    // Historical logs can project browse data, but cannot prove ownership of
    // the CURRENT identity. Only explicit routing or current discovery can
    // disambiguate a non-Codex owner from same-ID rejected Codex inventory.
    const discoveredNonCodex =
      !canonical &&
      meta.provider &&
      meta.provider !== "codex" &&
      (discoveryBySession.get(sid) ?? []).some((session) => session.providerKind === meta.provider && session.acpProviderId === meta.acpProviderId);
    const provenNonCodex =
      (typeof canonicalProvider === "string" && canonicalProvider !== "codex") ||
      discoveredNonCodex ||
      (route && route.provider !== "codex" && primaryEvidence.has(chat.id));
    if (provenNonCodex && !meta.nativeAgent) return false;
    const scopedRisk = membership.rejectedNativeSessions.has(sid) || membership.deferredNativeSessions.has(sid);
    const provider = canonicalProvider ?? route?.provider ?? meta.provider;
    return scopedRisk || ((provider === "codex" || !!meta.nativeAgent) && unsafeNativeSession(sid));
  };
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
  const primaryEvidence = new Set(
    stored
      .filter((chat) => {
        const route = routing.get(chat.id);
        return (discoveryBySession.get(chat.session_id) ?? []).some(
          (session) => session.providerKind === route?.provider && session.acpProviderId === route?.vendor,
        );
      })
      .map((chat) => chat.id),
  );
  const rows = new Map<string, Chat & { displayFolder?: string }>();
  const identities = new Map<string, Set<string>>();
  for (const session of discovery.sessions) {
    if (session.providerKind === "codex" && unsafeNativeSession(session.sessionId)) continue;
    const knownOwners = owners.get(session.sessionId) ?? [];
    const candidates = knownOwners.filter((chat) => {
      const owner = routing.get(chat.id);
      return owner?.provider === session.providerKind && owner.vendor === session.acpProviderId;
    });
    if (candidates.length > 1) {
      for (const chat of candidates) {
        // An ambiguous historical alias is not evidence against an
        // independently owned current session.
        if (chat.session_id === session.sessionId) {
          rejectedIds.add(chat.id);
          rows.delete(chat.id);
        }
      }
      warnings.push(`Ambiguous stored owners for ${session.providerKind} session ${session.sessionId}`);
      continue;
    }
    const storedChat = candidates[0];
    if (!storedChat && knownOwners.length) {
      // Historical cross-engine aliases belong to the logical chat, never a new
      // standalone row. Preserve content matches without guessing current routing.
      if (
        knownOwners.length === 1 &&
        knownOwners[0].session_id !== session.sessionId &&
        routing.has(knownOwners[0].id) &&
        (session.providerKind !== "acp" || routing.get(knownOwners[0].id)?.vendor === session.acpProviderId)
      ) {
        const owner = knownOwners[0];
        const keys = identities.get(owner.id) ?? new Set<string>();
        keys.add(JSON.stringify([session.providerKind, session.acpProviderId ?? null, session.sessionId]));
        identities.set(owner.id, keys);
        if (!rows.has(owner.id) && !rejectedIds.has(owner.id) && !unsafeNative(owner)) {
          const route = routing.get(owner.id)!;
          const logical = membership.corpus.get(owner.id) ?? owner;
          rows.set(owner.id, {
            ...logical,
            // Lineage enrichment may use a historical native-parent anchor.
            // Execution identity always belongs to the canonical stored owner.
            session_id: owner.session_id,
            // Browse projection follows newest discovery, independently of
            // the logical chat's current provider/session execution identity.
            folder: session.folder,
            displayFolder: session.displayFolder,
            session_log_path: session.filePath,
            created_at: session.createdAt.toISOString(),
            updated_at: session.updatedAt.toISOString(),
            metadata: JSON.stringify({
              ...parseChatMetadata(logical.metadata),
              provider: route.provider,
              ...(route.vendor && { acpProviderId: route.vendor }),
            }),
          });
        }
      } else {
        // Unqualified history (or another namespace with the same raw ID)
        // cannot revoke independently discovered primary routing.
        for (const chat of knownOwners) {
          if (chat.session_id === session.sessionId && !primaryEvidence.has(chat.id)) {
            rejectedIds.add(chat.id);
            rows.delete(chat.id);
          }
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
    keys.add(JSON.stringify([session.providerKind, session.acpProviderId ?? null, session.sessionId]));
    identities.set(id, keys);
    // Discovery is globally newest-first. Execution identity already comes
    // from the stored record; an older current log must not replace the
    // selected alias's browse timestamp/folder or affect date filters/pages.
    if (previous) continue;
    rows.set(id, {
      ...storedChat,
      id,
      session_id: storedChat?.session_id ?? session.sessionId,
      folder: session.folder,
      displayFolder: session.displayFolder,
      session_log_path: session.filePath,
      created_at: session.createdAt.toISOString(),
      updated_at: session.updatedAt.toISOString(),
      metadata: JSON.stringify({ ...meta, provider: session.providerKind, ...(session.acpProviderId && { acpProviderId: session.acpProviderId }) }),
    });
  }
  // Stored-only pins and tree relatives are the sidebar's appendables, not every stale record.
  const survivesTriggered = createTriggeredPredicate();
  const baseAdmits = (chat: Chat) => {
    if (isIgnoredProjectFolder(chat.folder) || unsafeNative(chat)) return false;
    const rootKey = membership.index.existingRootIdOf(chat.id);
    const ancestor = rows.get(rootKey) ?? membership.corpus.get(rootKey);
    if (ancestor && unsafeNative(ancestor)) return false;
    if (!view?.available) return true;
    const meta = parseChatMetadata(chat.metadata);
    if (view.options.bookmarked && meta.bookmarked !== true) return false;
    if (!view.options.showTriggered && !survivesTriggered(chat)) return false;
    const rootId = membership.index.existingRootIdOf(chat.id);
    const root = membership.roots.has(rootId) ? membership.storedById.get(rootId) : undefined;
    return !(cardLifecycleFor({ showArchived: view.options.showArchived, searching: !!view.submittedSearch }) !== "all" && root && cardIsArchived(root));
  };
  const touchedRoots = new Set([...rows.values()].filter(baseAdmits).map((chat) => membership.index.rootKeyOf(chat.id)));
  for (const chat of stored) {
    if (rejectedIds.has(chat.id) || rows.has(chat.id) || isIgnoredProjectFolder(chat.folder) || isRetiredProvider(parseChatMetadata(chat.metadata).provider))
      continue;
    const meta = parseChatMetadata(chat.metadata);
    const related =
      (membership.index.parentIdOf(chat.id) || membership.index.childrenByParent.has(chat.id)) && touchedRoots.has(membership.index.rootKeyOf(chat.id));
    if (meta.pinned === true || related) rows.set(chat.id, { ...(membership.corpus.get(chat.id) ?? chat), session_id: chat.session_id });
  }
  // Every predicate below this line reads records and maps. The provenance a
  // row is stamped with is computed here too, so `repo`/`branch` never have to
  // be re-derived on the page. Filesystem work — a live branch read, a
  // transcript grep — happens only after these have narrowed the candidates.
  const repoScope = args.repo === undefined ? null : createRepoScope(args.repo);
  const liveBranchOf = createLiveBranchResolver();
  const provenance = new Map<string, { repoSource?: string; branch: string | null; branchSource: BranchSource }>();
  /** Records outlive their browse projection; prefer them for recorded fields. */
  const recordMetaOf = (id: string) => parseChatMetadata(membership.storedById.get(id)?.metadata);
  /** Every spelling of this chat's cwd — the record's is the one that is real. */
  const foldersOf = (chat: Chat & { displayFolder?: string }) => {
    const recorded = membership.storedById.get(chat.id)?.folder;
    return recorded && recorded !== chat.folder ? [recorded, chat.folder] : [chat.folder];
  };
  let branchUnevaluated = 0;
  let candidates = [...rows.values()].filter((chat) => {
    if (!baseAdmits(chat)) return false;
    const rootId = membership.index.existingRootIdOf(chat.id);
    const root = membership.roots.has(rootId) ? membership.storedById.get(rootId) : undefined;
    const meta = parseChatMetadata(chat.metadata);
    const record = recordMetaOf(chat.id);
    if (args.topLevelOnly && (rootId !== chat.id || !!meta.nativeAgent)) return false;
    // `chat.folder` is the browse projection, and for a chat whose directory no
    // longer exists that projection is the *lossy decode* of the project-dir
    // name — a path that never existed on disk (`/repo.branch` comes back as
    // `/repo/branch`). Reporting it is deliberate and unchanged; matching only
    // it meant the record's own cwd found nothing. Accept either.
    if (args.folder !== undefined && !foldersOf(chat).includes(args.folder)) return false;
    let repoSource: string | undefined;
    if (repoScope) {
      // The record's cwd first: it is the only spelling that survives the
      // directory, and the fabricated one would be classified against a path
      // that never existed. A *refusal* on it ends the question — only "nothing
      // could be asked" earns the second spelling a turn, or the projection
      // launders a neighbouring repo back in under the lexical rules.
      let verdict: RepoVerdict = null;
      for (const folder of foldersOf(chat)) {
        verdict = repoScope.classify(folder);
        if (verdict !== null) break;
      }
      if (verdict === null || verdict === "refused") return false;
      repoSource = verdict;
    }
    if (args.agentAlias !== undefined && (record.agentAlias ?? meta.agentAlias ?? null) !== args.agentAlias) return false;
    if (args.triggered !== undefined && (record.triggered === true || meta.triggered === true) !== args.triggered) return false;
    if (args.parentChatId !== undefined && (membership.index.parentIdOf(chat.id) ?? getParentChatId(record)) !== args.parentChatId) return false;
    if (
      args.rootChatId !== undefined &&
      chat.id !== args.rootChatId &&
      rootId !== args.rootChatId &&
      membership.index.rootKeyOf(chat.id) !== args.rootChatId &&
      record.rootChatId !== args.rootChatId
    )
      return false;
    if (args.updatedAfter !== undefined && Date.parse(chat.updated_at) < Date.parse(args.updatedAfter)) return false;
    if (args.updatedBefore !== undefined && Date.parse(chat.updated_at) > Date.parse(args.updatedBefore)) return false;
    // `metadata.lastBranch` is written by the generic message route, so every
    // engine records it — this filter is not claude-code-only the way
    // `find_chats`' was. The live worktree branch is the fallback, consulted
    // only when the record disagrees, and only for directories still on disk.
    const recorded = typeof record.lastBranch === "string" ? record.lastBranch : typeof meta.lastBranch === "string" ? meta.lastBranch : null;
    let branch = recorded;
    let branchSource: BranchSource = recorded === null ? "unknown" : "record";
    if (args.branch !== undefined && recorded !== args.branch) {
      const live = foldersOf(chat)
        .map(liveBranchOf)
        .find((value) => value !== null);
      if (live === args.branch) {
        branch = live;
        branchSource = "live-git";
      } else {
        // Nothing recorded a branch and nothing on disk can be asked. Dropping
        // it is not the same as proving it does not match, so it is counted and
        // reported rather than silently discarded.
        if (recorded === null && live == null) branchUnevaluated++;
        return false;
      }
    }
    provenance.set(chat.id, { ...(repoSource && { repoSource }), branch, branchSource });
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
  if (branchUnevaluated) {
    warnings.push(`${branchUnevaluated} chats recorded no branch and their directory is gone; the branch filter could not evaluate them`);
  }
  /**
   * Run one content search over the candidates, and account for the rows it
   * could not look at.
   *
   * A candidate with no entry in `identities` has no discoverable transcript —
   * the stored-only pinned and lineage rows appended above, or a row whose log
   * file is gone. The old code dropped those with no counter, no warning and a
   * confident `total`, which is the exact failure the `branch` path was changed
   * to stop doing. Same rule, both paths: not-looked-at is reported, and an
   * unknown is not allowed to masquerade as a miss.
   */
  const contentSearch = async (term: string, label: string) => {
    // Keep every qualified current/historical identity of surviving logical
    // candidates, not just the row selected for its browse projection.
    const keysByChat = new Map(candidates.map((chat) => [chat.id, [...(identities.get(chat.id) ?? [])]]));
    const eligibleKeys = new Set([...keysByChat.values()].flat());
    const selectedSessions = discovery.sessions.filter((session) =>
      eligibleKeys.has(JSON.stringify([session.providerKind, session.acpProviderId ?? null, session.sessionId])),
    );
    const content = selectedSessions.length ? await collectContentMatches(term, selectedSessions) : { keys: new Set<string>(), warnings: [] };
    // The shared pool reports saturation as a warning and an empty result set,
    // which reads from the outside exactly like "nothing matched". The sibling
    // worker pool (`matchAdvanced`) throws for the same condition; so does this
    // now, rather than handing back a successful-looking empty page.
    if (content.warnings.some((w) => w.includes("workers busy"))) {
      throw new ChatQueryError("CHAT_CONTENT_BUSY", `Content-search workers busy; ${label} was not run. Retry this query.`);
    }
    warnings.push(...content.warnings);
    let unsearchable = 0;
    const hits = new Map<string, string>();
    candidates = candidates.filter((chat) => {
      const keys = keysByChat.get(chat.id) ?? [];
      if (!keys.length) {
        unsearchable++;
        return false;
      }
      const hit = keys.find((key) => content.keys.has(key));
      if (hit === undefined) return false;
      hits.set(chat.id, hit);
      return true;
    });
    if (unsearchable) {
      warnings.push(`${unsearchable} chats have no readable transcript on disk; ${label} could not evaluate them`);
    }
    return hits;
  };
  if (view?.available) {
    const advanced = await matchAdvanced(candidates, view.filters);
    candidates = advanced.rows;
    warnings.push(...advanced.warnings);
    if (view.submittedSearch && candidates.length) await contentSearch(view.submittedSearch, "the sidebar's submitted search");
  }
  // Transcript search, explicitly opt-in and deliberately last. Every record
  // predicate above has already run, so this opens files for the survivors
  // only — scoped to an open card that is ~20 transcripts rather than the
  // corpus. Same per-engine readers each adapter's `searchSessions` greps with,
  // run under the shared worker's time, heap and per-file byte budgets.
  const matchKinds = new Map<string, MatchKind>();
  if (args.grep !== undefined) {
    const hits = await contentSearch(args.grep, "grep");
    for (const [chatId, hit] of hits) {
      const providerKind = String(JSON.parse(hit)[0]);
      const chat = rows.get(chatId);
      // A Codex native child's "first prompt" is the agent's nickname or path.
      // That is metadata, and saying so is the difference between a real hit
      // and one the caller would read as conversation.
      const native = !!parseChatMetadata(chat?.metadata).nativeAgent;
      matchKinds.set(
        chatId,
        providerKind === "codex" && native ? "metadata" : (MATCH_KIND[providerKind as AgentProviderKind] ?? "unknown"),
      );
    }
  }
  const sortKey = args.sort === "created" ? (chat: Chat) => Date.parse(chat.created_at) : (chat: Chat) => Date.parse(chat.updated_at);
  candidates.sort((a, b) => sortKey(b) - sortKey(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const offset = args.offset ?? 0,
    limit = args.limit ?? 20;
  const page = candidates.slice(offset, offset + limit);
  /**
   * Finish each returned row's branch provenance.
   *
   * `liveBranchOf` only ran during filtering, and only when `branch=` was
   * passed — so an unfiltered call reported `branchSource: "unknown"` for a
   * live worktree that git could have answered for immediately. That conflates
   * "nothing to go on" with "we never looked", which is the one thing the
   * stamps exist to prevent. Resolving here rather than in the filter keeps it
   * bounded to the page (at most 100 rows), and `nearestGitDir` makes each one
   * a stat walk rather than a subprocess.
   */
  const branchOf = (chat: Chat & { displayFolder?: string }) => {
    const settled = provenance.get(chat.id);
    if (settled?.branchSource === "live-git" || settled?.branchSource === "record") return settled;
    const live = foldersOf(chat)
      .map(liveBranchOf)
      .find((value) => value !== null);
    return live == null ? { branch: null, branchSource: "unknown" as BranchSource } : { branch: live, branchSource: "live-git" as BranchSource };
  };
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
        // Filterable fields are also reported, so a caller can check what the
        // filter did rather than trust it — the habit `find_chats` had to ask
        // for explicitly, because its filters quietly did nothing off
        // claude-code.
        agentAlias: (membership.storedById.get(chat.id) ? recordMetaOf(chat.id).agentAlias : meta.agentAlias) ?? null,
        triggered: recordMetaOf(chat.id).triggered === true || meta.triggered === true,
        // Provenance, not decoration: a row must never leave here implying it
        // was evaluated against something it was not. `branchSource: "record"`
        // is the chat's LAST recorded branch, which may be older than the
        // directory's current one and is not every branch the chat touched;
        // `"live-git"` is the directory now; `"unknown"` means neither exists.
        // `matchKind` says what a `grep` hit actually matched.
        ...branchOf(chat),
        ...(args.repo !== undefined && { repoSource: provenance.get(chat.id)?.repoSource ?? null }),
        ...(matchKinds.has(chat.id) && { matchKind: matchKinds.get(chat.id) }),
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
      // The repo actually searched. `repo` is normalised up to the main
      // checkout, so a caller who passed their own worktree can see that the
      // scope widened rather than wonder why sibling worktrees appeared.
      ...(repoScope && { repoRoot: repoScope.repoRoot, ...(repoScope.normalisedFrom && { repoNormalisedFrom: repoScope.normalisedFrom }) }),
      ...(view?.available && { view }),
      ...((view?.available || args.grep !== undefined) && {
        contentSearchSemantics:
          "Provider-specific and not a full-text index. claude-code greps the raw session JSONL, tool calls and results included (matchKind 'transcript'); " +
          "Pi searches derived conversational text only, no tool traffic (matchKind 'messages'); Codex matches the first user prompt, or a native child's nickname/path (matchKind 'first-prompt'/'metadata'); " +
          "Cline/ACP match first-message previews (matchKind 'first-prompt'). Read matchKind on each row before concluding a chat did not mention something.",
      }),
    },
  };
}
