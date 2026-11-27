/**
 * Card field read/write — cards are metadata nested on the root chat that
 * created them (`metadata.card`).  There is no standalone card entity; this
 * module is the single place that knows the shape, defaults, and limits of
 * that nested object.
 *
 * Design rationale:
 *   - A card IS its root chat.  The card's identity is the chat id; the card's
 *     data is a sub-object inside the chat's metadata blob.
 *   - Absent `metadata.card` means "all defaults" (open lifecycle, title from
 *     chat, no description, no category, etc.).  No write happens at chat
 *     creation — the object materialises lazily the first time someone edits.
 *   - Writes are view-only: they do NOT bump `chat.updated_at`, so amending a
 *     card does not resurface the chat as unread or reorder the sidebar.
 *     `chatFileService.updateChatMetadata(..., { touch: false })` provides
 *     this.
 *   - The card carries its own `updatedAt` so consumers can tell when card
 *     fields were last changed, independent of chat activity.
 *   - All limits (title length, metadata entry count, etc.) are enforced here
 *     so REST routes and MCP tools share one implementation.
 *
 * Purity split: the *read* half (`cardFieldsFromChat`, `isCardEligible`,
 * `cardLifecycleOf`) is pure over a chat record — the card rollup works over
 * an injected snapshot of chats and must never reach back into
 * chatFileService, or its results could mix two points-in-time (see
 * card-rollup.ts and chats-snapshot.ts).  Only the *write* half
 * (`patchCardFields`) touches the file service.
 *
 * That split still holds for the functions, but no longer for the *module*:
 * `patchCardFields` imports card-archive-unpin.ts, which reaches chat-lineage
 * and from there claude.js, so importing this file at all now boots the agent
 * stack (a bare `import` prints `[session-completion] Session completion
 * handler initialized`) and closes an import cycle back to here. Both are
 * argued, with the evidence, in card-archive-unpin.ts's header. A caller that
 * only wants the pure readers pays for the whole graph.
 */

import type { Card, CardLifecycle, CardPatch } from "shared";
import { CARD_CATEGORY_MAX } from "shared";
import { unpinArchivedCardChats, type PinnedMemberLookup } from "./card-archive-unpin.js";
import { chatFileService, type Chat } from "./chat-file-service.js";
import { parseChatMetadataRecord } from "../utils/chat-metadata.js";

export const CARD_TITLE_MAX = 200;
export const CARD_STATUS_MAX = 160;
const CARD_METADATA_KEY_MAX = 64;
export const CARD_METADATA_VALUE_MAX = 2048;
const CARD_METADATA_MAX_ENTRIES = 50;

export class CardFieldError extends Error {}
class CardFieldWriteError extends Error {}

/**
 * The raw nested shape on `metadata.card`. Everything optional: absent means
 * default. Internal — the wire/projected shape is {@link Card} in shared.
 */
export interface CardFields {
  title?: string;
  description?: string;
  emoji?: string;
  lifecycle?: CardLifecycle;
  pinned?: boolean;
  category?: string;
  status?: string;
  statusEmoji?: string;
  metadata?: Record<string, string>;
  closedAt?: string;
  updatedAt?: string;
  hidden?: boolean;
}

/** A chat record (or a snapshot row shaped like one). */
export type ChatLike = Pick<Chat, "id" | "created_at" | "metadata">;

function parseMeta(chat: { metadata?: string | null }): Record<string, unknown> {
  return parseChatMetadataRecord(chat.metadata);
}

/** The raw nested `card` object off a chat's metadata, defaults NOT applied. */
export function rawCardFields(chat: { metadata?: string | null }): CardFields {
  return cardFieldsOfMeta(parseMeta(chat));
}

/** {@link rawCardFields} over metadata the caller has already parsed. */
function cardFieldsOfMeta(meta: Record<string, unknown>): CardFields {
  const raw = meta.card;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as CardFields) : {};
}

function chatTitle(chat: { metadata?: string | null }): string | null {
  const meta = parseMeta(chat);
  const raw = (typeof meta.title === "string" && meta.title) || (typeof meta.preview === "string" && meta.preview) || null;
  return raw ? raw.replace(/\s+/g, " ").trim().slice(0, 120) : null;
}

/**
 * A child-archive flag stranded on a card root: `metadata.childArchived: true`
 * on a record that still carries a parent pointer. Returns the flag's
 * `childArchivedAt` (or `""` when unstamped) when it applies, `undefined`
 * otherwise.
 *
 * The flag is a per-child archive (child-archive.ts) and the route refuses a
 * root, but it outlives its parent: deleting a chat never cascades, and a
 * parent that was never stored (or was purged by native retention) is no
 * lineage node at all. Either way `existingRootIdOf` promotes the archived
 * child to the root of its own card. The sidebar keeps hiding that child — and
 * so the whole tree under it — because it only checks that a parent pointer
 * exists, so every chat on the card is archived. The card reads as closed to
 * match, with `closedAt` falling back to when the child was archived.
 *
 * Only meaningful on a card root; a member's flag is the ordinary child
 * archive. A truly detached root has no parent pointer (chat-detach.ts clears
 * the flag too), so it is never caught here. The parent read is inlined from
 * chat-lineage's `getParentChatId` to keep this module's read half free of
 * another import edge.
 */
export function strandedChildArchiveAt(meta: Record<string, unknown>): string | undefined {
  if (meta.childArchived !== true) return undefined;
  const parent = meta.parentChatId ?? meta.forkedFrom;
  if (typeof parent !== "string" || parent.length === 0) return undefined;
  return typeof meta.childArchivedAt === "string" ? meta.childArchivedAt : "";
}

/**
 * The lifecycle a card's root actually has: its stored lifecycle, or "closed"
 * when a stranded child-archive flag archives it (`stranded` — see
 * {@link strandedChildArchiveAt}).
 */
function effectiveLifecycle(fields: { lifecycle?: unknown }, stranded: boolean): CardLifecycle {
  return fields.lifecycle === "closed" || stranded ? "closed" : "open";
}

/** Default emoji pool used when a card has never set one. */
const DEFAULT_EMOJIS = ["🗂️", "📋", "🎯", "🚀", "💡", "🔧", "📦", "🧪", "📝", "🔍"];

function defaultEmoji(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return DEFAULT_EMOJIS[hash % DEFAULT_EMOJIS.length];
}

/**
 * Project a chat record into its {@link Card} — the listing-facing view with
 * every default applied. Pure: reads only the passed record. `id` is the chat
 * id (the card's identity), `createdAt` is the chat's creation, and
 * `updatedAt` is the card data's own timestamp (defaults to the chat's
 * creation — no edit has ever happened).
 */
export function cardFieldsFromChat(chat: ChatLike, fallbackTitle?: string | null | (() => string | null)): Card {
  const fields = rawCardFields(chat);
  const strandedAt = strandedChildArchiveAt(parseMeta(chat));
  const lifecycle = effectiveLifecycle(fields, strandedAt !== undefined);
  const closedAt = typeof fields.closedAt === "string" && fields.lifecycle === "closed" ? fields.closedAt : strandedAt || undefined;
  const storedTitle = (typeof fields.title === "string" && fields.title) || chatTitle(chat);
  const resolvedFallback = storedTitle ? null : typeof fallbackTitle === "function" ? fallbackTitle() : fallbackTitle;
  const normalizedFallback =
    typeof resolvedFallback === "string" ? resolvedFallback.replace(/\s+/g, " ").trim().slice(0, 120) : "";

  return {
    id: chat.id,
    title: storedTitle || normalizedFallback || "Untitled",
    description: typeof fields.description === "string" ? fields.description : "",
    emoji: (typeof fields.emoji === "string" && fields.emoji) || defaultEmoji(chat.id),
    lifecycle,
    ...(fields.hidden === true ? { hidden: true } : {}),
    pinned: fields.pinned === true,
    ...(typeof fields.category === "string" && fields.category ? { category: fields.category } : {}),
    ...(typeof fields.status === "string" && fields.status ? { status: fields.status } : {}),
    ...(typeof fields.statusEmoji === "string" && fields.statusEmoji ? { statusEmoji: fields.statusEmoji } : {}),
    ...(fields.metadata && typeof fields.metadata === "object" ? { metadata: fields.metadata } : {}),
    ...(lifecycle === "closed" && closedAt ? { closedAt } : {}),
    createdAt: chat.created_at,
    updatedAt: (typeof fields.updatedAt === "string" && fields.updatedAt) || chat.created_at,
  };
}

/**
 * The card's lifecycle off a chat record — "open" when absent/corrupt, and
 * "closed" when a stranded child-archive flag archives the root (see
 * {@link strandedChildArchiveAt}).
 */
export function cardLifecycleOf(chat: { metadata?: string | null }): CardLifecycle {
  const meta = parseMeta(chat);
  return effectiveLifecycle(cardFieldsOfMeta(meta), strandedChildArchiveAt(meta) !== undefined);
}

/**
 * Read the card fields for `chatId` through the file service, applying
 * defaults. Returns `null` when the chat does not exist.
 */
export function readCardFields(chatId: string): Card | null {
  const chat = chatFileService.getChat(chatId);
  return chat ? cardFieldsFromChat(chat) : null;
}

/** Validate a metadata sub-patch and return the merged result. */
function mergeCardMetadata(
  existing: Record<string, string> | undefined,
  patch: Record<string, string | null>,
): Record<string, string> {
  const merged: Record<string, string> = { ...(existing || {}) };

  for (const [rawKey, value] of Object.entries(patch)) {
    const key = rawKey.trim();
    if (!key) throw new CardFieldError("Metadata keys must be non-empty");
    if (key === "__proto__") throw new CardFieldError(`"__proto__" is not a valid metadata key`);
    if (key.length > CARD_METADATA_KEY_MAX) throw new CardFieldError(`Metadata key "${key.slice(0, 20)}…" exceeds ${CARD_METADATA_KEY_MAX} characters`);

    if (value === null || value === undefined) {
      delete merged[key];
      continue;
    }
    if (typeof value !== "string") throw new CardFieldError(`Metadata value for "${key}" must be a string or null`);
    if (value.length > CARD_METADATA_VALUE_MAX) throw new CardFieldError(`Metadata value for "${key}" exceeds ${CARD_METADATA_VALUE_MAX} characters`);
    merged[key] = value;
  }

  const keys = Object.keys(merged);
  if (keys.length > CARD_METADATA_MAX_ENTRIES) {
    throw new CardFieldError(`Metadata may not exceed ${CARD_METADATA_MAX_ENTRIES} entries`);
  }

  return keys.length > 0 ? merged : {};
}

/**
 * Whether a card in this state is archived, for the sidebar's purposes: closed
 * or hidden (opted out of listings). The two are one state everywhere a pin can be
 * seen — see the header of card-archive-unpin.ts. `stranded` is whether a
 * stranded child-archive flag is (still) closing the card, as for
 * {@link effectiveLifecycle}.
 */
function isArchivedState(fields: { lifecycle?: unknown; hidden?: unknown }, stranded: boolean): boolean {
  return effectiveLifecycle(fields, stranded) === "closed" || fields.hidden === true;
}

/**
 * Merge `patch` into the card nested inside `chatId`'s metadata.
 * Returns the updated card, or `null` when the chat is missing.
 * Throws {@link CardFieldError} on validation failures (the chat is left
 * untouched).
 *
 * The write is view-only — `chat.updated_at` is not bumped.
 *
 * `deps.pinnedMembers` lets a caller archiving many cards in one request share
 * a single read of the chat corpus across the batch; omit it and one is built
 * for this call alone. See `createPinnedMemberLookup` in card-archive-unpin.ts.
 *
 * `chatId` must be a **chat id** when the patch archives the card. The card
 * write itself takes either spelling — `getChat` resolves a session id too —
 * but the pinned-member lookup is keyed by lineage, and lineage names chat ids,
 * so passing a session id for a record whose two ids differ archives the card
 * and silently keeps its pins. Every caller today resolves through
 * `CardContext` or `walkToRootId`, both of which answer in chat ids.
 */
export function patchCardFields(chatId: string, patch: CardPatch, deps?: { pinnedMembers?: PinnedMemberLookup }): Card | null {
  const chat = chatFileService.getChat(chatId);
  if (!chat) return null;

  const meta = parseMeta(chat);
  const existing: Record<string, unknown> = { ...cardFieldsOfMeta(meta) };
  // A stranded child-archive flag closes the card without any stored
  // lifecycle (see strandedChildArchiveAt), so every "what state is it in"
  // read below goes through the derived lifecycle, not `existing.lifecycle`.
  const stranded = strandedChildArchiveAt(meta) !== undefined;
  const currentLifecycle = effectiveLifecycle(existing, stranded);
  // Captured before any field is merged: the unpin below fires on the
  // *transition* into archived, never on a card that was already there.
  const wasArchived = isArchivedState(existing, stranded);

  if (patch.title !== undefined) {
    const trimmed = patch.title.trim();
    if (!trimmed) throw new CardFieldError("Title cannot be blank");
    existing.title = trimmed.slice(0, CARD_TITLE_MAX);
  }

  if (patch.description !== undefined) {
    existing.description = patch.description;
  }

  if (patch.emoji !== undefined) {
    const trimmed = patch.emoji.trim();
    if (trimmed) existing.emoji = trimmed;
    else delete existing.emoji;
  }

  if (patch.pinned !== undefined) {
    existing.pinned = patch.pinned;
  }

  if (patch.hidden !== undefined) {
    // null/false both read as "visible" (absent-means-default invariant).
    if (patch.hidden === true) existing.hidden = true;
    else delete existing.hidden;
  }

  if (patch.status !== undefined) {
    if (patch.status === null || !patch.status.trim()) {
      delete existing.status;
      delete existing.statusEmoji;
    } else {
      existing.status = patch.status.slice(0, CARD_STATUS_MAX);
    }
  }

  if (patch.statusEmoji !== undefined) {
    if (patch.statusEmoji === null || !patch.statusEmoji.trim()) {
      delete existing.statusEmoji;
    } else {
      existing.statusEmoji = patch.statusEmoji;
    }
  }

  if (patch.category !== undefined) {
    if (patch.category === null || (typeof patch.category === "string" && !patch.category.trim())) {
      delete existing.category;
    } else {
      const trimmed = patch.category.trim();
      if (trimmed.length > CARD_CATEGORY_MAX) {
        throw new CardFieldError(`Category exceeds ${CARD_CATEGORY_MAX} characters`);
      }
      existing.category = trimmed;
    }
  }

  // Set when this write opens a card that only a stranded flag was closing:
  // the flag goes in the same write, or the reopen would change nothing.
  let clearStranded = false;
  if (patch.lifecycle !== undefined) {
    // `closedAt` describes the transition, not the most recent idempotent
    // PATCH. Re-sending { lifecycle: "closed" } must not make an old card look
    // newly closed (or reorder the archive by closedAt).
    if (patch.lifecycle !== currentLifecycle) {
      existing.lifecycle = patch.lifecycle;
      if (patch.lifecycle === "closed") {
        existing.closedAt = new Date().toISOString();
      } else {
        delete existing.closedAt;
        clearStranded = stranded;
      }
    }
  }

  if (patch.metadata !== undefined) {
    const current =
      existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
        ? (existing.metadata as Record<string, string>)
        : undefined;
    const merged = mergeCardMetadata(current, patch.metadata);
    if (Object.keys(merged).length > 0) {
      existing.metadata = merged;
    } else {
      delete existing.metadata;
    }
  }

  existing.updatedAt = new Date().toISOString();

  // Read out of `existing` here, while "after the merge" is still true of it —
  // not down beside the unpin. Every branch above happens to mutate in place,
  // so the two reads agree today, but one of them switching to a copy (as
  // mergeCardMetadata already does for its own sub-object) would silently turn
  // the unpin off with nothing to fail.
  // The same predicate as `wasArchived`: a stranded flag that survives this
  // write still closes the card.
  const nowArchived = isArchivedState(existing, stranded && !clearStranded);

  const written = chatFileService.updateChatMetadata(
    chatId,
    clearStranded ? { card: existing, childArchived: undefined, childArchivedAt: undefined } : { card: existing },
    { touch: false },
  );
  if (!written) throw new CardFieldWriteError(`Failed to persist card fields for chat "${chatId}"`);
  const updated = readCardFields(chatId);
  if (!updated) throw new CardFieldWriteError(`Card root chat "${chatId}" disappeared while it was being updated`);

  // Archiving drops the sidebar pins on this card's chats, when the user has
  // not turned that off. Deliberately keyed on the transition and only in this
  // direction — a re-archive of an already-closed card writes nothing, and
  // unarchiving never restores a pin. Both decisions, and why `hidden` counts,
  // are argued in card-archive-unpin.ts.
  //
  // After the card write, not before: an archive that failed to persist must
  // not have taken anyone's pins with it. The member writes read-merge-write,
  // so unpinning the root chat itself preserves the card object just written.
  // `unpinArchivedCardChats` swallows its own failures by design — this call
  // sits after the archive is durable, so a throw here would report a card that
  // IS closed as a failed request.
  if (!wasArchived && nowArchived) {
    unpinArchivedCardChats(chatId, deps?.pinnedMembers);
  }
  return updated;
}

/**
 * Remove a `metadata.card` object from a chat that is NOT the card's root.
 * Returns true when something was actually cleared.
 *
 * Call this from every write path that redirects a member chat id to its
 * tree's root. Card fields on a member are unreadable by design (the rollup
 * only projects from lineage roots), so a stale `lifecycle: "closed"` sitting
 * there cannot be edited through the card and never goes away: a reopen
 * patches the root, returns the root's now-open summary, and leaves the member
 * still saying "closed" on disk. Anything reading that record — or a later
 * repair pass — then disagrees with the cards API about the same card, which is
 * the shape the "reopen does nothing" report took.
 *
 * View-only, like every other card write: no `updated_at` bump.
 */
export function clearCardFieldsOn(chatId: string): boolean {
  const chat = chatFileService.getChat(chatId);
  if (!chat) return false;
  const meta = parseMeta(chat);
  if (meta.card === undefined || meta.card === null) return false;
  return chatFileService.updateChatMetadata(chatId, { card: null }, { touch: false });
}

/**
 * Whether a record is allowed to anchor a card, independent of whether its
 * parent pointer still resolves. This distinction matters after an ancestor
 * is deleted: `walkToRootId` promotes the highest surviving descendant to the
 * root, even though that record still carries its now-dangling parent id.
 */
export function isCardEligible(chat: { metadata?: string | null }): boolean {
  const meta = parseMeta(chat);
  if (meta.triggered === true) return false;
  if (typeof meta.jobRunId === "string" && meta.jobRunId) return false;
  return true;
}
