import { parseChatMetadata } from "../utils/chat-metadata.js";
import { hasParkedApprovals } from "./job-approval-signal.js";
import { getRun, latestRunChatId } from "./job-store.js";
import { cardLifecycleOf, rawCardFields } from "./card-fields.js";
export function createTriggeredPredicate(isParkedRow?: (chat: { id: string }, meta: ReturnType<typeof parseChatMetadata>) => boolean) {
  const parked = hasParkedApprovals();
  const cache = new Map<string, ReturnType<typeof getRun>>();
  return (chat: { id: string; metadata?: string | null }) => {
    const meta = parseChatMetadata(chat.metadata);
    if (meta.nativeAgent) return false;
    if (meta.triggered !== true) return true;
    if (!parked || typeof meta.jobRunId !== "string") return false;
    if (isParkedRow) return isParkedRow(chat, meta);
    if (!cache.has(meta.jobRunId)) cache.set(meta.jobRunId, getRun(meta.jobRunId));
    const run = cache.get(meta.jobRunId);
    return !!run && run.status === "waiting_approval" && latestRunChatId(run) === chat.id;
  };
}
export function cardIsArchived(chat: { metadata?: string | null }) {
  return rawCardFields(chat).hidden === true || cardLifecycleOf(chat) !== "open";
}
