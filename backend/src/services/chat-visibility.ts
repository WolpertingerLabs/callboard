import { parseChatMetadata, parseChatMetadataRecord } from "../utils/chat-metadata.js";
import { hasParkedApprovals } from "./job-approval-signal.js";
import { getRun, latestRunChatId } from "./job-store.js";
import { cardLifecycleOf, rawCardFields } from "./card-fields.js";
export function createTriggeredPredicate(isParkedRow?: (chat: { id: string }, meta: ReturnType<typeof parseChatMetadata>) => boolean) {
  const parked = hasParkedApprovals();
  const cache = new Map<string, ReturnType<typeof getRun>>();
  // `meta`, when given, must be the parse of `chat.metadata` — a caller that
  // built the string from an object passes that object instead of having it
  // parsed back. Never pass this predicate straight to Array#filter with it:
  // the index would arrive as `meta`.
  return (chat: { id: string; metadata?: string | null }, meta: ReturnType<typeof parseChatMetadata> = parseChatMetadata(chat.metadata)) => {
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

/**
 * The card-less half of "archived": a flag on the lineage root's own metadata.
 *
 * A root that is not a card — `isCardEligible` refuses triggered and job-step
 * roots, and a stored native Codex root is never promoted — has no
 * `metadata.card` to close, and must not grow one: card-migration and the
 * stranded-card-field cleanup in routes/cards.ts both read `metadata.card` on a
 * non-card record as debris. So such a root carries `metadata.treeArchived:
 * true` (plus `treeArchivedAt`) instead. Read only through
 * {@link rootIsArchived}, which is what decides which representation a given
 * root uses.
 *
 * Deliberately NOT `archived`/`archivedAt`: both names were already taken on
 * chat metadata. `metadata.archived === true` makes computer-use refuse the
 * chat ("Chat is unavailable", computer-use.ts), so reusing it would revoke
 * computer control mid-session on any chat in an archived tree; and
 * `archivedAt` is the marker workspace-service writes on every chat of an
 * archived WORKSPACE, which an unarchive here would delete.
 */
export function archivedFlagOf(chat: { metadata?: string | null }): boolean {
  return parseChatMetadataRecord(chat.metadata).treeArchived === true;
}

/**
 * Whether a lineage root — and so its whole tree — is archived.
 *
 * "Archived" is a property of the root, stored one of two ways, and this is
 * the one place that picks between them: a card root by its card state (closed
 * or hidden — see {@link cardIsArchived}), any other root by
 * {@link archivedFlagOf}. `isCard` is the caller's verdict because the caller
 * already has the authoritative one — `createCardMembership().roots`, which
 * folds in the native-Codex exclusion that `isCardEligible` alone does not —
 * and a second derivation here could disagree with it.
 *
 * Never consults the other representation: a stale flag left on a card root, or
 * a stray `metadata.card` on a non-card root, is ignored rather than allowed to
 * archive a tree nothing in the UI can unarchive.
 */
export function rootIsArchived(root: { metadata?: string | null }, isCard: boolean): boolean {
  return metaIsArchived(parseChatMetadataRecord(root.metadata), isCard);
}

/**
 * {@link rootIsArchived} over metadata the caller has already parsed — the
 * same two rules, read off the object: a card is archived when `card` is
 * closed or hidden ({@link cardIsArchived}), a non-card root when it carries
 * the flag ({@link archivedFlagOf}).
 */
export function metaIsArchived(meta: Record<string, unknown>, isCard: boolean): boolean {
  if (!isCard) return meta.treeArchived === true;
  const card = meta.card;
  if (!card || typeof card !== "object" || Array.isArray(card)) return false;
  const fields = card as { lifecycle?: unknown; hidden?: unknown };
  return fields.hidden === true || fields.lifecycle === "closed";
}

/**
 * The ids of every archived lineage root among `stored`, by either
 * representation. A record is a root when `existingRootIdOf` answers its own id
 * — the same promotion rule the card rollup uses, so a descendant orphaned by a
 * deleted root is judged by its own record.
 */
export function archivedRootIdsOf<T extends { id: string; metadata?: string | null }>(
  stored: Iterable<T>,
  existingRootIdOf: (chatId: string) => string,
  isCardRoot: (chatId: string) => boolean,
  // Metadata the caller already parsed, when it has it — the list route's
  // first pass does, and reparsing every root on the polled hot path would
  // be a second parse for an answer already in hand.
  parsedMetaOf?: (chat: T) => Record<string, unknown> | undefined,
): Set<string> {
  const archived = new Set<string>();
  for (const chat of stored) {
    if (existingRootIdOf(chat.id) !== chat.id) continue;
    const meta = parsedMetaOf?.(chat) ?? parseChatMetadataRecord(chat.metadata);
    if (metaIsArchived(meta, isCardRoot(chat.id))) archived.add(chat.id);
  }
  return archived;
}
