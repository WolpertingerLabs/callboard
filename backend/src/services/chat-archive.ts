/**
 * Archive and unarchive a lineage tree — the write half of
 * `rootIsArchived` in chat-visibility.ts.
 *
 * "Archived" is a property of a lineage ROOT, and of the whole tree under it,
 * stored one of two ways:
 *
 *  - the root is a card → `metadata.card.lifecycle` (and `hidden`), written by
 *    `patchCardFields` exactly as the board does;
 *  - the root is not a card (a triggered chat, a job step, a stored native
 *    Codex root) → `metadata.archived: true` plus `archivedAt`, on the root's
 *    own record. Never `metadata.card.*`: card-migration and the
 *    stranded-card-field cleanup both treat a card object on a non-card record
 *    as debris to repair.
 *
 * Both writes are view-only (`touch: false`). Archiving is a label on a
 * conversation, not activity in it, and bumping `updated_at` would resurface
 * the tree at the top of the sidebar as a side effect of putting it away.
 *
 * Both kinds unpin the tree's chats on the transition into archived, through
 * the same `unpinArchivedCardChats` the card path uses — that function walks
 * lineage, not cards, so it serves a card-less root unchanged — and both honour
 * the `unpinChatsOnArchive` setting. See card-archive-unpin.ts for why.
 */
import { patchCardFields } from "./card-fields.js";
import { unpinArchivedCardChats, type PinnedMemberLookup } from "./card-archive-unpin.js";
import { chatFileService } from "./chat-file-service.js";
import { archivedFlagOf } from "./chat-visibility.js";

export class ChatArchiveWriteError extends Error {}

export interface SetRootArchivedOptions {
  /** Whether the root is a card — `createCardMembership().roots.has(root)`. */
  isCard: boolean;
  /** Shared across a batch; see `createPinnedMemberLookup`. */
  pinnedMembers?: PinnedMemberLookup;
  /**
   * The key to write the root's record under, when the caller has it — its
   * `session_id`. A write keyed by chat id falls through to a directory scan
   * for records whose two ids differ; see `indexPinnedByRoot`. Defaults to the
   * chat id, which always resolves, just more slowly.
   */
  writeKey?: string;
}

/**
 * Archive (`archived: true`) or unarchive one lineage root, picking the
 * representation from `isCard`. Returns false when the root has no record.
 * Throws when the record exists but the write did not persist.
 *
 * `rootChatId` must be a CHAT id: the pinned-member lookup is keyed by lineage,
 * which names chat ids (the same constraint `patchCardFields` documents).
 *
 * Unarchiving a card clears `hidden` as well as reopening it. The sidebar
 * counts a hidden card as archived (see `cardIsArchived`), so an unarchive
 * that only reopened the lifecycle would leave the row dimmed and offering
 * "Unarchive" again — a gesture that cannot reach the state it names.
 */
export function setRootArchived(rootChatId: string, archived: boolean, opts: SetRootArchivedOptions): boolean {
  if (opts.isCard) {
    const card = patchCardFields(rootChatId, archived ? { lifecycle: "closed" } : { lifecycle: "open", hidden: false }, { pinnedMembers: opts.pinnedMembers });
    return card !== null;
  }

  const key = opts.writeKey ?? rootChatId;
  const chat = chatFileService.getChat(key);
  if (!chat) return false;
  // Transition-only, like `closedAt` on a card: re-archiving an archived tree
  // writes nothing, so `archivedAt` keeps describing when it was put away.
  if (archivedFlagOf(chat) === archived) return true;
  // `undefined` drops the key from the stringified record — absent means "not
  // archived", the same absent-means-default rule card fields follow.
  const fields = archived ? { archived: true, archivedAt: new Date().toISOString() } : { archived: undefined, archivedAt: undefined };
  if (!chatFileService.updateChatMetadata(key, fields, { touch: false })) {
    throw new ChatArchiveWriteError(`Failed to persist the archived flag on chat "${rootChatId}"`);
  }
  // After the write, as for cards: an archive that failed to persist must not
  // have taken anyone's pins with it. Never throws.
  if (archived) unpinArchivedCardChats(rootChatId, opts.pinnedMembers);
  return true;
}

/**
 * The reopen-on-message rule for card-less trees: clear the archived flag on
 * `rootChatId` if it carries one. Returns true when it did.
 *
 * The card half lives beside it in `sendMessage` (claude.ts), which reopens a
 * closed card when any chat in its tree receives a message. Without this half,
 * a reply landing in an archived triggered tree — a Discord thread continued, a
 * job step re-run — would arrive in a chat the sidebar is withholding.
 */
export function reopenArchivedRoot(rootChatId: string): boolean {
  const chat = chatFileService.getChat(rootChatId);
  if (!chat || !archivedFlagOf(chat)) return false;
  return setRootArchived(chat.id, false, { isCard: false, writeKey: chat.session_id || chat.id });
}
