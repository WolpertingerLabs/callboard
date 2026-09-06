/** Read-only exec-owned Codex threads. No process control is available in the exec SDK. */
import { basename } from "node:path";
import { closeSync, openSync, readSync } from "node:fs";
import { CodexSessionProvider } from "../agents/adapters/codex/CodexSessionProvider.js";
import { readCodexSessionMeta, extractThreadIdFromFilename } from "../agents/adapters/codex/sessionParser.js";
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

export function nativeAgentForChat(chatId: string) {
  const stored = chatFileService.getChat(chatId);
  const meta = parseMetadata(stored?.metadata);
  if (meta.provider && meta.provider !== "codex") return null;
  const sessionId = stored?.session_id ?? chatId;
  const resolved = new CodexSessionProvider().resolveSession(sessionId);
  if (!resolved) return null;
  const session = readCodexSessionMeta(resolved.logPath);
  if (session?.id !== sessionId || !session.isNativeThread) return null;
  return { parentThreadId: "unverified parent (inspect the owning Codex thread)", ...session.nativeAgent, sessionId, logPath: resolved.logPath };
}

export function assertNativeAgentControllable(chatId: string): void {
  const native = nativeAgentForChat(chatId);
  if (native) throw new Error(`${NATIVE_CONTROL_NOTE} Parent thread: ${native.parentThreadId}`);
  const stored = chatFileService.getChat(chatId);
  const metadata = parseMetadata(stored?.metadata);
  if (metadata.nativeAgent && metadata.provider === "codex") throw new Error(NATIVE_CONTROL_NOTE);
  if (metadata.provider === "codex") {
    const resolved = new CodexSessionProvider().resolveSession(stored!.session_id);
    const meta = resolved && readCodexSessionMeta(resolved.logPath);
    if (!meta || meta.id !== stored!.session_id)
      throw new Error("Cannot verify Codex thread ownership from its rollout; refusing direct resume. Inspect the owning Codex thread first.");
  }
}

/** Bounded replay; the ordinal, NOT timestamps, separates copied fork history. */
export function readNativeLifecycle(logPath: string, now = Date.now()): NativeLifecycle {
  const meta = readCodexSessionMeta(logPath);
  if (!meta?.nativeAgent || meta.historyStartOrdinal === undefined) return "unknown";
  let fd: number | undefined;
  try {
    fd = openSync(logPath, "r");
    const buf = Buffer.alloc(4 * 1024 * 1024 + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n === buf.length) return "unknown"; // Never report a terminal state from a truncated prefix.
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
      if (status === "active") timestamp = Date.parse(line.timestamp);
    }
    // Recent local activity is evidence of activity, not proof a process survived a restart.
    if (status === "active" && (!Number.isFinite(timestamp) || now - timestamp > 30_000 || timestamp > now + 1000)) return "unknown";
    return status;
  } catch {
    return "unknown";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Additive, transient metadata: explicit Callboard parentage/title always win. */
export function nativeMetadata(logPath: string, sessionId: string, existing: Record<string, unknown> = {}) {
  if (extractThreadIdFromFilename(basename(logPath)) !== sessionId || (existing.provider && existing.provider !== "codex")) return existing;
  const meta = readCodexSessionMeta(logPath);
  if (meta?.id !== sessionId || !meta.nativeAgent) return existing;
  const native = meta.nativeAgent;
  return {
    provider: "codex",
    title: native.nickname || native.agentPath,
    ...(!existing.parentChatId && !existing.forkedFrom ? { parentChatId: native.parentThreadId, chatRole: native.role || "subagent" } : {}),
    ...existing,
    nativeAgent: {
      ...native,
      management: "read-only",
      controlNote: NATIVE_CONTROL_NOTE,
      lifecycle: readNativeLifecycle(logPath),
      evidence: "bounded rollout replay; active means recent activity, not process liveness",
    },
  };
}

/** One discovery pass, never recursive per child; no writes to stored records. */
export function withNativeCodexChats(stored: Chat[]): Chat[] {
  const bySession = new Map(stored.map((chat) => [chat.session_id, chat]));
  const result = new Map(stored.map((chat) => [chat.id, chat]));
  for (const entry of new CodexSessionProvider().discoverSessions({ limit: 10_000, offset: 0 }).sessions) {
    const chat = bySession.get(entry.sessionId);
    const existing = parseMetadata(chat?.metadata);
    if (existing.provider && existing.provider !== "codex") continue;
    const metadata = nativeMetadata(entry.filePath, entry.sessionId, existing);
    // Include roots as well so filesystem-only parent threads can anchor trees.
    const parentId = typeof metadata.parentChatId === "string" ? metadata.parentChatId : undefined;
    if (parentId && bySession.has(parentId) && !existing.parentChatId && !existing.forkedFrom) metadata.parentChatId = bySession.get(parentId)!.id;
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
