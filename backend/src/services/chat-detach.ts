import { chatFileService } from "./chat-file-service.js";
import { buildLineageIndex, getParentChatId } from "./chat-lineage.js";
import { isNativeRecord } from "./card-membership.js";
import { spaceOfChat } from "./space-service.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("chat-detach");

/**
 * Split a child chat off its parentage tree so it becomes a root of its own —
 * its own sidebar row and its own board card.
 *
 * Parentage is otherwise stamped only at creation (see chat-lineage.ts), so
 * this is the one place that rewrites it, and it only ever REMOVES links: it
 * cannot form a cycle any more than creation can.
 *
 * What is cleared on the detached chat:
 *   - `parentChatId` and its legacy alias `forkedFrom` — the parent pointer.
 *   - `rootChatId` — a stamp naming the old root would otherwise tie the chat
 *     straight back into that tree (walkToRootId honours a terminal stamp).
 *   - `chatRole` and `forkedAt` — both describe the relationship to the
 *     parent ("subagent", "fork", the message it branched off), which no
 *     longer exists. Clearing `forkedAt` is also what takes the inline fork
 *     marker out of the parent's thread.
 *
 * What is written:
 *   - `spaceId` — the space the tree lived in. A child has no stamp of its own
 *     that anything reads (the root's wins), so without it the new root would
 *     fall to the default space and vanish from the space the user was in.
 *   - `detachedFrom` — the old parent's id and when, as a breadcrumb. Nothing
 *     reads it; it is there so the split can be understood after the fact.
 *
 * Descendants of the detached chat follow it: their stamped `rootChatId`
 * named the old root, and while their parent pointers already resolve to the
 * new root, a stale stamp is what the fallback paths (deleted intermediate
 * parent, client-side grouping of a partial page) key on. They are re-stamped
 * to the detached chat.
 *
 * Every write is quiet (`touch: false`) — reorganising the sidebar is not
 * activity, and must not resurface the chat as unread.
 */

export type DetachResult =
  | { ok: true; chatId: string; previousParentChatId: string; restampedDescendants: number }
  | { ok: false; status: 400 | 409 | 500; error: string };

/**
 * Detach `chat` — a read-model record as `findChat` returns it, so a native
 * Codex child's inferred parent (never stored) is visible to the checks.
 */
export function detachChatFromParent(chat: { id: string; metadata?: string | null; _from_filesystem?: boolean }): DetachResult {
  // A native Codex subagent's parent comes from its rollout on every read;
  // clearing a stored pointer would be re-inferred on the next one.
  if (isNativeRecord(chat)) {
    return {
      ok: false,
      status: 409,
      error: "This is a native Codex subagent — its parent is read from the Codex session itself, so it cannot be split off",
    };
  }
  const meta = parseChatMetadata(chat.metadata);
  const parentId = getParentChatId(meta);
  if (!parentId) return { ok: false, status: 400, error: "This chat has no parent — it is already a standalone chat" };
  // Only native children carry a parent without a stored record, and those
  // were refused above; anything else here has nothing to rewrite.
  if (chat._from_filesystem) return { ok: false, status: 400, error: "This chat has no stored record to update" };

  // Resolved BEFORE the write, while the chat still resolves to its old root.
  const spaceId = spaceOfChat(chat.id);

  const ok = chatFileService.updateChatMetadata(
    chat.id,
    {
      // Undefined values drop out of the JSON the store writes.
      parentChatId: undefined,
      forkedFrom: undefined,
      rootChatId: undefined,
      chatRole: undefined,
      forkedAt: undefined,
      spaceId,
      detachedFrom: { parentChatId: parentId, at: new Date().toISOString() },
    },
    { touch: false },
  );
  if (!ok) return { ok: false, status: 500, error: "Could not update this chat's record, so it is still a child of its parent" };

  let restampedDescendants = 0;
  const snapshot = chatFileService.getAllChats();
  const index = buildLineageIndex(snapshot);
  const stack = [...(index.childrenByParent.get(chat.id) ?? [])];
  const visited = new Set<string>([chat.id]);
  while (stack.length) {
    const child = stack.pop()!;
    if (visited.has(child.id)) continue;
    visited.add(child.id);
    stack.push(...(index.childrenByParent.get(child.id) ?? []));
    const stamped = parseChatMetadata(child.metadata).rootChatId;
    if (stamped === chat.id) continue;
    if (chatFileService.updateChatMetadataForRecord(child, { rootChatId: chat.id }, { touch: false })) restampedDescendants++;
    else log.warn(`detach ${chat.id}: could not re-stamp rootChatId on descendant ${child.id}`);
  }

  log.info(`Detached chat ${chat.id} from parent ${parentId} (${restampedDescendants} descendant(s) re-stamped)`);
  return { ok: true, chatId: chat.id, previousParentChatId: parentId, restampedDescendants };
}
