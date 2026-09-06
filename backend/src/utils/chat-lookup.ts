import { parseChatMetadata } from "./chat-metadata.js";
import { nativeMetadata, refreshNativeMetadata } from "../services/codex-native-agents.js";
import { statSync } from "fs";
import { chatFileService } from "../services/chat-file-service.js";
import { getGitInfo, resolveWorktreeToMainRepoCached } from "./git.js";
import { getSessionProviders } from "../agents/factory.js";
import { SessionRoutingError } from "../agents/ports/SessionProvider.js";
import { createLogger } from "./logger.js";

const log = createLogger("chat-lookup");
export { withSessionProvider } from "./session-provenance.js";
import { withSessionProvider, resolveSessionAcrossProviders, resolveSessionContext } from "./session-provenance.js";

/** Consume a findChat result without re-discovering (and overriding) its owner. */
export function readChatSessionMessages(chat: { metadata?: string | null; session_id?: string; _provider_resolution_error?: string }, sessionIds?: string[]) {
  if (chat._provider_resolution_error) throw new SessionRoutingError(chat._provider_resolution_error);
  const meta = parseChatMetadata(chat.metadata);
  const ids: string[] = sessionIds ?? (Array.isArray(meta.session_ids) ? [...meta.session_ids] : []);
  if (!sessionIds && chat.session_id && !ids.includes(chat.session_id)) ids.push(chat.session_id);
  const provider = getSessionProviders().find((p) => p.kind === (meta.provider ?? "claude-code"));
  if (!provider) return [];
  return meta.acpProviderId ? provider.parseSessionMessages(ids, { acpProviderId: meta.acpProviderId }) : provider.parseSessionMessages(ids);
}

/**
 * Look up a chat by ID, checking file storage first then falling back to filesystem.
 * Returns null if chat not found in either location. Does not throw errors.
 *
 * Used by both chats.ts and stream.ts routes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findChat(id: string, includeGitInfo: boolean = true): any | null {
  try {
    // Try file storage first
    let fileChat = null;
    try {
      fileChat = chatFileService.getChat(id);
    } catch (err) {
      log.error(`Error reading chat from file storage: ${err}`);
    }

    if (fileChat) {
      log.debug(`findChat — found in file storage: id=${id}`);
      let context;
      let resolved;
      let routingError: string | undefined;
      try {
        context = resolveSessionContext(fileChat.session_id, fileChat.metadata);
        resolved = context.provenance;
      } catch (err) {
        if (!(err instanceof SessionRoutingError)) throw err;
        routingError = err.message;
      }
      // Use original folder for git info (correct branch for worktrees)
      let gitInfo: { isGitRepo: boolean; branch?: string } = { isGitRepo: false };
      if (includeGitInfo) {
        try {
          gitInfo = getGitInfo(fileChat.folder);
        } catch {}
      }
      // Resolve worktree paths to main repo for display/grouping only
      const { mainRepoPath } = resolveWorktreeToMainRepoCached(fileChat.folder);
      return {
        ...fileChat,
        ...(routingError && { _provider_resolution_error: routingError }),
        metadata: refreshNativeMetadata(context?.current?.logPath ?? "", fileChat.session_id, context?.metadata ?? fileChat.metadata),
        // Keep original folder (may be a worktree) — logs are stored under this path
        folder: fileChat.folder,
        displayFolder: mainRepoPath,
        session_log_path: resolved?.logPath ?? null,
        ...(includeGitInfo && {
          is_git_repo: gitInfo.isGitRepo,
          git_branch: gitInfo.branch,
        }),
      };
    }

    // Try filesystem fallback: id might be a session ID with no file storage
    log.debug(`findChat — not in file storage, trying filesystem fallback: id=${id}`);
    const resolved = resolveSessionAcrossProviders(id);
    if (!resolved) return null;

    const st = statSync(resolved.logPath);
    // Use original folder for git info (correct branch for worktrees)
    let gitInfo: { isGitRepo: boolean; branch?: string } = { isGitRepo: false };
    if (includeGitInfo) {
      try {
        gitInfo = getGitInfo(resolved.folder);
      } catch {}
    }

    return {
      id,
      // Keep original folder (may be a worktree) — logs are stored under this path
      folder: resolved.folder,
      displayFolder: resolved.displayFolder,
      session_id: id,
      session_log_path: resolved.logPath,
      metadata: JSON.stringify(
        nativeMetadata(
          resolved.logPath,
          id,
          parseChatMetadata(withSessionProvider(JSON.stringify({ session_ids: [id] }), resolved.provider, resolved.acpProviderId)),
        ),
      ),
      created_at: st.birthtime.toISOString(),
      updated_at: st.mtime.toISOString(),
      ...(includeGitInfo && {
        is_git_repo: gitInfo.isGitRepo,
        git_branch: gitInfo.branch,
      }),
      _from_filesystem: true,
    };
  } catch (err) {
    log.error(`Error finding chat: ${err}`);
    return null;
  }
}

/**
 * Chat id of the step session spawned under a job execution key, or null if
 * that session never got as far as creating its chat record.
 *
 * Restart-only path for the job runner: a step chat is stamped with its
 * execution key at creation, so a run that died before persisting the chatId
 * can find its own session instead of abandoning it (or spawning a second
 * one). Scans chat records — acceptable on a recovery path, and never hit
 * during normal operation.
 */
export function findChatIdByJobExecutionKey(executionKey: string): string | null {
  for (const chat of chatFileService.getAllChats()) {
    try {
      const meta = JSON.parse(chat.metadata || "{}");
      if (meta.jobExecutionKey === executionKey) return chat.id;
    } catch {
      // Unparseable metadata — not the chat we are looking for.
    }
  }
  return null;
}

/**
 * Lightweight chat lookup for status checks — skips git info for performance.
 * Used by stream.ts for session status checks.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findChatForStatus(id: string): any | null {
  return findChat(id, false);
}
