/**
 * Is this chat archived — by any of the representations the archive actually
 * writes?
 *
 * There is no `metadata.archived` flag on a chat. Archive is:
 *
 *  - the lineage root's state, read through {@link rootIsArchived}: a card
 *    root closed or hidden (`metadata.card`), or a card-less root's
 *    `metadata.treeArchived` (chat-archive.ts);
 *  - a child archived on its own, or anything under one:
 *    `metadata.childArchived` on the chat or on an ancestor below the root
 *    (child-archive.ts).
 *
 * Both are exactly what `sendMessage` undoes when a message lands in the tree
 * (`reopenArchivedRoot`, `reopenArchivedChildChain`), which is why a delivery
 * the human did not ask for must check this first.
 *
 * A separate module because it reaches `chat-lineage.ts`, which imports
 * `claude.ts`: computer control gets it through an injected check
 * (`setChatArchivedCheck`) rather than an import, so its own modules never
 * close that cycle.
 */
import { chatFileService, type Chat } from "./chat-file-service.js";
import { getParentChatId, walkToRootId } from "./chat-lineage.js";
import { rootIsArchived } from "./chat-visibility.js";
import { isCardEligible } from "./card-fields.js";
import { isNativeRecord } from "./card-membership.js";
import { parseChatMetadataRecord } from "../utils/chat-metadata.js";

const MAX_ANCESTOR_WALK = 50;

export function isChatArchived(chatId: string, read: (id: string) => Chat | null = (id) => chatFileService.getChat(id)): boolean {
  const chat = read(chatId);
  if (!chat) return false;
  const visited = new Set<string>();
  let current: Chat | null = chat;
  for (let depth = 0; current && depth < MAX_ANCESTOR_WALK && !visited.has(current.id); depth++) {
    visited.add(current.id);
    const meta = parseChatMetadataRecord(current.metadata);
    const parentId = getParentChatId(meta);
    // A child's own archive; a root's is judged by rootIsArchived below.
    if (parentId && meta.childArchived === true) return true;
    if (!parentId) break;
    current = read(parentId);
  }
  const root = read(walkToRootId(chat.id, read));
  // The card verdict the sidebar uses (`createCardMembership().roots`): a
  // stored native Codex root is never a card, so it is judged by its
  // `treeArchived` flag, never by a stray `metadata.card`.
  return !!root && rootIsArchived(root, isCardEligible(root) && !isNativeRecord(root));
}
