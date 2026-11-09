/**
 * Archive and unarchive ONE child chat — the per-chat counterpart of the tree
 * archive in chat-archive.ts.
 *
 * Tree archive is a property of a lineage ROOT and reaches every chat under it.
 * This is narrower: a child chat (one with a parent pointer) put away on its
 * own, so it drops out of its parent's expanded tree in the sidebar while the
 * rest of the tree stays. Stored on the child's own record as
 * `metadata.childArchived: true` plus `childArchivedAt`, a pair deliberately
 * NOT named `treeArchived` — that flag means "the whole tree under this root",
 * and a reader that confused the two would hide a parent's siblings.
 *
 * `Chat.archived` (computed per list response from the ROOT) is untouched by
 * this flag: an archived child of an open card is still on an open card. The
 * sidebar reads `childArchived` separately and hides the child — and,
 * client-side, every chat under it — unless "Show archived" is on.
 *
 * Only meaningful on a chat that has a parent. A root has card-level archive
 * already, so the route refuses one, and a split-off clears the flag (see
 * chat-detach.ts) so a chat that becomes a root cannot carry a stale one.
 *
 * View-only, like the tree archive: `updated_at` is not bumped, or archiving a
 * child would float its tree to the top of the sidebar.
 */
import { chatFileService } from "./chat-file-service.js";
import { archivedAfter } from "./chat-archive.js";
import { getParentChatId } from "./chat-lineage.js";
import { parseChatMetadata } from "../utils/chat-metadata.js";

/** Defense cap against corrupt parent-pointer chains (mirrors chat-lineage). */
const MAX_ANCESTOR_WALK = 50;

/**
 * The metadata fields that archive (`true`) or unarchive (`false`) a child.
 * `undefined` drops the keys from the stored record — absent means "not
 * archived", the rule every other flag here follows.
 */
export function childArchiveFields(archived: boolean): { childArchived: true | undefined; childArchivedAt: string | undefined } {
  return archived ? { childArchived: true, childArchivedAt: new Date().toISOString() } : { childArchived: undefined, childArchivedAt: undefined };
}

/**
 * The reopen-on-message rule for archived children: clear the flag on
 * `chatId` and on every archived ancestor between it and its root. Returns
 * the ids it cleared.
 *
 * The tree archive's own rule (`reopenArchivedRoot`, and the card reopen in
 * `sendMessage`) brings a tree back when any chat in it gets a message. This is
 * the same promise one level down: a reply landing in an archived child — or
 * anywhere under one, since the sidebar hides an archived child's descendants
 * with it — would otherwise arrive in a chat the sidebar is withholding.
 *
 * `unlessArchivedAfter` is the job-step exception, exactly as for the tree:
 * an archive stamped after the run started is the user's "I'm done with this"
 * and a later step must not undo it.
 *
 * Best-effort per ancestor: a write that fails leaves that flag set and the
 * walk carries on.
 */
export function reopenArchivedChildChain(chatId: string, opts?: { unlessArchivedAfter?: string }): string[] {
  const cleared: string[] = [];
  const visited = new Set<string>();
  let currentId: string | undefined = chatId;
  for (let depth = 0; currentId && depth < MAX_ANCESTOR_WALK && !visited.has(currentId); depth++) {
    visited.add(currentId);
    const chat = chatFileService.getChat(currentId);
    if (!chat) break;
    const meta = parseChatMetadata(chat.metadata);
    const parentId = getParentChatId(meta);
    // A root never carries a live flag (detach clears it), and the root is
    // where the walk stops either way.
    if (!parentId) break;
    if (meta.childArchived === true) {
      const at = typeof meta.childArchivedAt === "string" ? meta.childArchivedAt : undefined;
      if (!archivedAfter(at, opts?.unlessArchivedAfter) && chatFileService.updateChatMetadata(chat.session_id || chat.id, childArchiveFields(false), { touch: false })) {
        cleared.push(chat.id);
      }
    }
    currentId = parentId;
  }
  return cleared;
}
