import { SessionRoutingError } from "../agents/ports/SessionProvider.js";
import { resolveSessionContext } from "../utils/session-provenance.js";
/** Read-only exec-owned Codex threads. No process control is available in the exec SDK. */
import { basename, relative, resolve, sep, isAbsolute } from "node:path";
import { closeSync, openSync, readSync, statSync, realpathSync } from "node:fs";
import { CodexSessionProvider } from "../agents/adapters/codex/CodexSessionProvider.js";
import { readCodexSessionMeta, extractThreadIdFromFilename } from "../agents/adapters/codex/sessionParser.js";
import { sessionRegistry } from "./session-registry.js";
import { chatFileService, type Chat } from "./chat-file-service.js";

export type NativeLifecycle = "active" | "complete" | "unknown" | "error" | "interrupted";
export const NATIVE_CONTROL_NOTE =
  "Native Codex child: read-only in Callboard. Ask its parent Codex thread to send instructions, interrupt, or close it. The exec transport cannot independently control this child; direct resume could race its owner. Inherited Callboard MCP tools are bound to the owning root, not this child; do not use them to set child-local title, status, or completion.";

function parseMetadata(raw?: string | null): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export interface NativeOwnershipExpectation {
  sessionId: string;
  provider?: unknown;
}

export function nativeAgentForChat(chatId: string, allowOwnedCancellation = false, expected?: NativeOwnershipExpectation) {
  const stored = chatFileService.getChat(chatId);
  const explicit = parseMetadata(stored?.metadata);
  const sessionId = stored?.session_id ?? chatId;
  if (expected && sessionId !== expected.sessionId) throw new Error("Chat primary identity changed during ownership validation.");
  if (expected?.provider === "codex" && explicit.provider != null && explicit.provider !== "codex")
    throw new Error("Chat provider changed during ownership validation.");
  if (explicit.provider != null && explicit.provider !== "codex") return null;
  // A vanished log must not erase already-validated Codex provenance. Pin only
  // routing, never the prior log: current identity/evidence is resolved afresh.
  const routingMetadata = expected?.provider === "codex" && explicit.provider == null ? JSON.stringify({ ...explicit, provider: "codex" }) : stored?.metadata;
  const owned = sessionRegistry.get(chatId);
  const ownedRoot = allowOwnedCancellation && owned?.type === "web" && !!owned.abortController && !explicit.nativeAgent;
  let context;
  try {
    context = resolveSessionContext(sessionId, routingMetadata);
  } catch (error) {
    // Ambiguous historical routing cannot take away an actual owned controller.
    // Still inspect positive current native evidence before allowing cancellation.
    if (!(error instanceof SessionRoutingError) || !ownedRoot) throw error;
    context = { current: new CodexSessionProvider().resolveSession(sessionId), metadata: stored?.metadata };
  }
  const meta = parseMetadata(context.metadata);
  if (meta.provider != null && meta.provider !== "codex") return null;
  // Never use historical provenance as the current identity or lifecycle.
  const resolved = context.current;
  const fallback = { parentThreadId: "unverified parent (inspect the owning Codex thread)", sessionId, logPath: resolved?.logPath ?? "" };
  // A server-created web controller proves control of this execution, NOT that
  // a disk thread is safe to resume. Positive native evidence still wins.
  // Persisted native ownership survives missing logs. Incomplete metadata cannot
  // establish root ownership either, including filesystem-only threads.
  if (meta.nativeAgent && meta.provider === "codex" && !resolved) return fallback;
  if (!resolved) return !ownedRoot && meta.provider === "codex" ? fallback : null;
  const session = readCodexSessionMeta(resolved.logPath);
  // A header this process cannot read (permissions, a torn first line) is a
  // parser gap, not evidence that a parent owns the thread. Refusing control
  // on it locks the user out of an ordinary root; only persisted native
  // ownership or a positive header may do that. Deletion stays fail-closed
  // separately, in the provider.
  if (!session) return meta.nativeAgent && meta.provider === "codex" ? fallback : null;
  if (session.id !== sessionId) return ownedRoot && !session.isNativeThread ? null : fallback;
  if (!session.isNativeThread) return meta.nativeAgent && meta.provider === "codex" ? fallback : null;
  return { parentThreadId: "unverified parent (inspect the owning Codex thread)", ...session.nativeAgent, sessionId, logPath: resolved.logPath };
}

/** Cancellation only: never grants permission to resume, delete or archive. */
export function assertNativeAgentStoppable(chatId: string): void {
  const native = nativeAgentForChat(chatId, true);
  if (native) throw new Error(`${NATIVE_CONTROL_NOTE} Parent thread: ${native.parentThreadId}`);
}

export function assertNativeAgentControllable(chatId: string, expected?: NativeOwnershipExpectation): void {
  const native = nativeAgentForChat(chatId, false, expected);
  if (native) throw new Error(`${NATIVE_CONTROL_NOTE} Parent thread: ${native.parentThreadId}`);
}

interface LifecycleEvidence {
  status: NativeLifecycle;
  timestamp: number;
  key: string;
}
const lifecycleCache = new Map<string, LifecycleEvidence>();
function currentLifecycle(evidence: LifecycleEvidence, now: number): NativeLifecycle {
  if (evidence.status === "active" && (!Number.isFinite(evidence.timestamp) || now - evidence.timestamp > 30_000 || evidence.timestamp > now + 1000))
    return "unknown";
  return evidence.status;
}

/** Bounded replay; the ordinal, NOT timestamps, separates copied fork history. */
export interface LifecycleBudget {
  remainingBytes: number;
}
export const createLifecycleBudget = (): LifecycleBudget => ({ remainingBytes: 8 * 1024 * 1024 });

export function readNativeLifecycle(logPath: string, now = Date.now(), budget?: LifecycleBudget, expectedSessionId?: string): NativeLifecycle {
  let fd: number | undefined;
  try {
    const versionOf = (stat: import("node:fs").BigIntStats) => `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
    const stat = statSync(logPath, { bigint: true });
    const key = versionOf(stat);
    const meta = readCodexSessionMeta(logPath, budget);
    if (!meta?.nativeAgent || meta.historyStartOrdinal === undefined) return "unknown";
    // Check before cache hits too: a stored path is not proof of thread identity.
    if (expectedSessionId && (meta.id !== expectedSessionId || extractThreadIdFromFilename(basename(logPath)) !== expectedSessionId)) return "unknown";
    // Bind the verified metadata, cached evidence and replay to one file version.
    if (versionOf(statSync(logPath, { bigint: true })) !== key) return "unknown";
    const cached = lifecycleCache.get(logPath);
    if (cached?.key === key) return currentLifecycle(cached, now);
    const size = Number(stat.size);
    if (size > 4 * 1024 * 1024) return "unknown"; // Never read an arbitrarily large log for status.
    if (budget && size + 1 > budget.remainingBytes) return "unknown";
    if (budget) budget.remainingBytes -= size + 1;
    fd = openSync(logPath, "r");
    const buf = Buffer.alloc(size + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n !== size) return "unknown"; // A growing/replaced file isn't a stable replay.
    const lines = buf.toString("utf8", 0, n).split("\n");
    let status: NativeLifecycle = "unknown";
    let timestamp = 0;
    for (const raw of lines.slice(meta.historyStartOrdinal)) {
      if (!raw.trim()) continue;
      let line;
      try {
        line = JSON.parse(raw);
      } catch {
        status = "unknown";
        continue;
      }
      if (line.type !== "event_msg") continue;
      const event = line.payload?.type;
      if (event === "task_started") status = "active";
      else if (event === "task_complete") status = "complete";
      else if (event === "turn_aborted") status = "interrupted";
      else if (event === "error") status = "error";
      else if (status === "error" && (event === "token_count" || event === "item_completed")) status = "active";
      if (status === "active") timestamp = Date.parse(line.timestamp);
    }
    if (versionOf(statSync(logPath, { bigint: true })) !== key) return "unknown";
    const evidence = { key, status, timestamp };
    if (lifecycleCache.size >= 1024) lifecycleCache.delete(lifecycleCache.keys().next().value!);
    lifecycleCache.set(logPath, evidence);
    // Re-evaluate freshness even on cache hits; a restart/stale file proves no liveness.
    return currentLifecycle(evidence, now);
  } catch {
    return "unknown";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Additive, transient metadata: explicit Callboard parentage/title always win. */
export function nativeMetadata(
  logPath: string,
  sessionId: string,
  existing: Record<string, unknown> = {},
  includeLifecycle = true,
  budget?: LifecycleBudget,
  parentChats?: ReadonlyMap<string, Chat>,
  verifiedMeta?: ReturnType<typeof readCodexSessionMeta>,
) {
  // Persisted lifecycle is a snapshot, never current evidence.
  if (existing.provider === "codex" && existing.nativeAgent && typeof existing.nativeAgent === "object")
    existing = { ...existing, nativeAgent: { ...existing.nativeAgent, lifecycle: "unknown", management: "read-only", controlNote: NATIVE_CONTROL_NOTE } };
  if (extractThreadIdFromFilename(basename(logPath)) !== sessionId || (existing.provider && existing.provider !== "codex")) return existing;
  const meta = verifiedMeta ?? readCodexSessionMeta(logPath);
  if (meta?.id !== sessionId || !meta.nativeAgent) return existing;
  const native = meta.nativeAgent;
  const priorNative = existing.nativeAgent as Record<string, unknown> | undefined;
  const inferredParent = !existing.forkedFrom && (!existing.parentChatId || priorNative?.inferredParentChatId === existing.parentChatId);
  const parentChatId = inferredParent
    ? ((parentChats ? parentChats.get(native.parentThreadId) : chatFileService.getChatBySessionId(native.parentThreadId))?.id ?? native.parentThreadId)
    : native.parentThreadId;
  return {
    provider: "codex",
    title: native.nickname || native.agentPath,
    ...existing,
    ...(inferredParent ? { parentChatId, chatRole: existing.chatRole || native.role || "subagent" } : {}),
    nativeAgent: {
      ...native,
      ...(inferredParent ? { inferredParentChatId: parentChatId } : {}),
      management: "read-only",
      controlNote: NATIVE_CONTROL_NOTE,
      lifecycle: includeLifecycle ? readNativeLifecycle(logPath, Date.now(), budget) : "unknown",
      evidence: "bounded rollout replay; active means recent activity, not process liveness",
    },
  };
}

/** Refresh response-only evidence, including legacy/missing-rollout records. */
export function refreshNativeMetadata(logPath: string, sessionId: string, raw?: string | null, budget?: LifecycleBudget): string {
  const existing = parseMetadata(raw);
  const enriched = nativeMetadata(logPath, sessionId, existing, true, budget);
  return enriched === existing ? (raw ?? "{}") : JSON.stringify(enriched);
}

/** One discovery pass, never recursive per child; no writes to stored records.
 *
 * Synthetic (no stored record) entries are admitted only for native
 * descendants and the filesystem-only parent threads that anchor them. Every
 * other rollout without a record is an ordinary Codex CLI session, and those
 * are no more a Callboard chat than a Claude CLI session without a record is.
 */
export function withNativeCodexChats(stored: Chat[]): Chat[] {
  const bySession = new Map(stored.map((chat) => [chat.session_id, chat]));
  const result = new Map(stored.map((chat) => [chat.id, { ...chat, metadata: refreshNativeMetadata("", chat.session_id, chat.metadata) }]));
  const sessions = new CodexSessionProvider().discoverSessions({ limit: 10_000, offset: 0 }).sessions;
  const discovered: { entry: (typeof sessions)[number]; chat: Chat | undefined; metadata: Record<string, unknown> }[] = [];
  /** Parent thread ids named by a discovered native child — the roots worth keeping without a record. */
  const anchors = new Set<string>();
  for (const entry of sessions) {
    const chat = bySession.get(entry.sessionId);
    const existing = parseMetadata(chat?.metadata);
    if (existing.provider && existing.provider !== "codex") continue;
    const metadata = nativeMetadata(entry.filePath, entry.sessionId, existing, false, undefined, bySession);
    const native = metadata.nativeAgent as { parentThreadId?: string } | undefined;
    if (typeof native?.parentThreadId === "string") anchors.add(native.parentThreadId);
    // Include roots as well so filesystem-only parent threads can anchor trees.
    const parentId = typeof metadata.parentChatId === "string" ? metadata.parentChatId : undefined;
    if (parentId && bySession.has(parentId) && !existing.parentChatId && !existing.forkedFrom) metadata.parentChatId = bySession.get(parentId)!.id;
    discovered.push({ entry, chat, metadata });
  }
  for (const { entry, chat, metadata } of discovered) {
    if (!chat && !metadata.nativeAgent && !anchors.has(entry.sessionId)) continue;
    result.set(chat?.id ?? entry.sessionId, {
      ...chat,
      id: chat?.id ?? entry.sessionId,
      session_id: entry.sessionId,
      folder: entry.folder,
      metadata: JSON.stringify({ provider: "codex", ...metadata }),
      session_log_path: entry.filePath,
      created_at: chat?.created_at ?? entry.createdAt.toISOString(),
      updated_at: entry.updatedAt.toISOString(),
    });
  }
  return [...result.values()];
}

/** Destructive operations need release evidence, not recent activity or registry absence.
 * Exec has no verified native-child ownership-release signal, so release is
 * inferred only from the child's own rollout: its last child-local event is
 * terminal (`task_complete` / `turn_aborted`) and nothing that could hand it
 * another turn — its parent — is live. Unknown/partial discovery is a refusal.
 */
export function nativeWorkspaceEvidence() {
  return { stored: chatFileService.getAllChats(), evidence: new CodexSessionProvider().ownershipEvidence() };
}

interface NativeReleaseIndex {
  records: { id: string; folder: string; parent: string | undefined; native: boolean }[];
  /** Rollouts whose header could not be read or does not verify against the filename. */
  unverifiable: string[];
  logPathById: Map<string, string>;
  chatIdBySession: Map<string, string>;
  /** Lineage edges, parent → children; stored id ↔ session id edges included. */
  children: Map<string, string[]>;
}

/**
 * Everything the blocker evaluation derives from a snapshot but not from the
 * workspace. A listing evaluates every workspace against one snapshot, and
 * parsing 9,000 stored records per workspace was most of its cost.
 */
const releaseIndexes = new WeakMap<object, NativeReleaseIndex>();
function nativeReleaseIndex(snapshot: ReturnType<typeof nativeWorkspaceEvidence>): NativeReleaseIndex {
  const cached = releaseIndexes.get(snapshot);
  if (cached) return cached;
  const { stored, evidence } = snapshot;
  const records: NativeReleaseIndex["records"] = stored.map((chat) => {
    const meta = parseMetadata(chat.metadata);
    return {
      id: chat.session_id,
      folder: chat.folder,
      parent: (meta.parentChatId as string | undefined) ?? (meta.nativeAgent as { parentThreadId?: string } | undefined)?.parentThreadId,
      native: !!meta.nativeAgent,
    };
  });
  const chatIdBySession = new Map<string, string>();
  for (const chat of stored) chatIdBySession.set(chat.session_id, chat.id);
  // A rollout whose header cannot be read or verified says nothing about any
  // workspace. It blocks only the workspace its stored lineage ties it to;
  // blocking every workspace on it would turn one unreadable file anywhere
  // under $CODEX_HOME into a machine-wide lockout.
  const unverifiable: string[] = [];
  const logPathById = new Map<string, string>();
  for (const session of evidence.sessions) {
    if (!session.meta || session.meta.id !== session.threadId) {
      unverifiable.push(session.threadId);
      continue;
    }
    logPathById.set(session.threadId, session.filePath);
    records.push({
      id: session.threadId,
      folder: session.meta.cwd ?? "",
      parent: session.meta.nativeAgent?.parentThreadId,
      native: !!session.meta.isNativeThread,
    });
  }
  // Descendants may work in a different directory; explicit workspace lineage
  // is still relevant. A visited set makes corrupt cycles finite.
  const children = new Map<string, string[]>();
  const addEdge = (parent: string, child: string) => {
    const group = children.get(parent) ?? [];
    group.push(child);
    children.set(parent, group);
  };
  for (const record of records) if (typeof record.parent === "string") addEdge(record.parent, record.id);
  for (const chat of stored)
    if (chat.id !== chat.session_id) {
      addEdge(chat.id, chat.session_id);
      addEdge(chat.session_id, chat.id);
    }
  const index = { records, unverifiable, logPathById, chatIdBySession, children };
  releaseIndexes.set(snapshot, index);
  return index;
}

export function nativeWorkspaceReleaseBlockers(workspaceId: string, cwd: string, snapshot = nativeWorkspaceEvidence()): string[] {
  const { stored, evidence } = snapshot;
  const { records, unverifiable, logPathById, chatIdBySession, children } = nativeReleaseIndex(snapshot);
  const blockers: string[] = evidence.complete ? [] : ["Codex discovery was incomplete; native ownership release cannot be established"];
  const linked = new Set(stored.filter((chat) => chat.workspaceId === workspaceId).flatMap((chat) => [chat.id, chat.session_id]));
  const queue = [...linked];
  for (let i = 0; i < queue.length; i++)
    for (const child of children.get(queue[i]) ?? [])
      if (!linked.has(child)) {
        linked.add(child);
        queue.push(child);
      }
  for (const id of unverifiable) if (linked.has(id)) blockers.push(`Cannot establish native ownership or cwd for Codex thread ${id}`);
  const parentLive = (parent: string | undefined): boolean => {
    if (!parent) return false;
    if (sessionRegistry.get(chatIdBySession.get(parent) ?? parent)) return true;
    // A parent that is itself a native child is live while its own replay says so.
    const parentLog = logPathById.get(parent);
    return !!parentLog && readNativeLifecycle(parentLog) === "active";
  };
  for (const record of records) {
    if (!record.native) continue;
    if (!linked.has(record.id) && !sameOrNestedDirectory(record.folder, cwd)) continue;
    const logPath = logPathById.get(record.id);
    const lifecycle = logPath ? readNativeLifecycle(logPath, Date.now(), undefined, record.id) : "unknown";
    if ((lifecycle === "complete" || lifecycle === "interrupted") && !parentLive(record.parent)) continue;
    blockers.push(
      `Native Codex thread ${record.id}: exec cannot establish ownership release; ask its owning parent to close it and reconcile its native session evidence before removing this workspace`,
    );
  }
  return [...new Set(blockers)];
}

function sameOrNestedDirectory(folder: string, cwd: string): boolean {
  if (!folder) return true; // Unknown cwd cannot establish safe release.
  const canonical = (path: string) => {
    try {
      return realpathSync.native(path);
    } catch {
      return resolve(path);
    }
  };
  const relativePath = relative(canonical(cwd), canonical(folder));
  return relativePath === "" || (!relativePath.startsWith(".." + sep) && relativePath !== ".." && !isAbsolute(relativePath));
}
