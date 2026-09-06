import { parseChatMetadata } from "./chat-metadata.js";

interface StoredChatContext {
  id: string;
  session_id: string;
  folder: string;
  metadata?: string | null;
}

/** Capture a value, not a cached Chat reference that metadata writes may mutate. */
export function chatContextFingerprint(chat: StoredChatContext | null | undefined): string {
  if (!chat) return "null";
  const meta = parseChatMetadata(chat.metadata);
  return JSON.stringify({
    id: chat.id,
    session_id: chat.session_id,
    folder: chat.folder,
    provider: meta.provider,
    acpProviderId: meta.acpProviderId,
    model: meta.model,
    effort: meta.effort,
    session_ids: meta.session_ids,
    lastBranch: meta.lastBranch,
  });
}

export class ChatContextChangedError extends Error {
  constructor() {
    super("Chat context changed while validating this message. Retry using the current session and settings.");
  }
}

/** Unrelated fields (title, bookmarks, etc.) deliberately do not invalidate preflight. */
export function assertChatContextUnchanged(expected: string, fresh: StoredChatContext | null | undefined): void {
  if (chatContextFingerprint(fresh) !== expected) throw new ChatContextChangedError();
}
