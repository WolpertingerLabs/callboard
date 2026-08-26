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
 * `cardLifecycleOf`) is pure over a chat record — the board rollup works over
 * an injected snapshot of chats and must never reach back into
 * chatFileService, or its results could mix two points-in-time (see
 * card-rollup.ts and chats-snapshot.ts).  Only the *write* half
 * (`patchCardFields`) touches the file service.
 */

import type { Card, CardLifecycle, CardPatch } from "shared";
import { CARD_CATEGORY_MAX } from "shared";
import { chatFileService, type Chat } from "./chat-file-service.js";

export const CARD_TITLE_MAX = 200;
export const CARD_STATUS_MAX = 160;
export const CARD_METADATA_KEY_MAX = 64;
export const CARD_METADATA_VALUE_MAX = 2048;
export const CARD_METADATA_MAX_ENTRIES = 50;

export class CardFieldError extends Error {}
export class CardFieldWriteError extends Error {}

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
  try {
    const parsed: unknown = JSON.parse(chat.metadata || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The raw nested `card` object off a chat's metadata, defaults NOT applied. */
export function rawCardFields(chat: { metadata?: string | null }): CardFields {
  const meta = parseMeta(chat);
  const raw = meta.card;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as CardFields) : {};
}

function chatTitle(chat: { metadata?: string | null }): string | null {
  const meta = parseMeta(chat);
  const raw = (typeof meta.title === "string" && meta.title) || (typeof meta.preview === "string" && meta.preview) || null;
  return raw ? raw.replace(/\s+/g, " ").trim().slice(0, 120) : null;
}

/** Default emoji pool used when a card has never set one. */
const DEFAULT_EMOJIS = ["🗂️", "📋", "🎯", "🚀", "💡", "🔧", "📦", "🧪", "📝", "🔍"];

function defaultEmoji(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return DEFAULT_EMOJIS[hash % DEFAULT_EMOJIS.length];
}

/**
 * Project a chat record into its {@link Card} — the board-facing view with
 * every default applied. Pure: reads only the passed record. `id` is the chat
 * id (the card's identity), `createdAt` is the chat's creation, and
 * `updatedAt` is the card data's own timestamp (defaults to the chat's
 * creation — no edit has ever happened).
 */
export function cardFieldsFromChat(chat: ChatLike, fallbackTitle?: string | null | (() => string | null)): Card {
  const fields = rawCardFields(chat);
  const storedTitle = (typeof fields.title === "string" && fields.title) || chatTitle(chat);
  const resolvedFallback = storedTitle ? null : typeof fallbackTitle === "function" ? fallbackTitle() : fallbackTitle;
  const normalizedFallback =
    typeof resolvedFallback === "string" ? resolvedFallback.replace(/\s+/g, " ").trim().slice(0, 120) : "";

  return {
    id: chat.id,
    title: storedTitle || normalizedFallback || "Untitled",
    description: typeof fields.description === "string" ? fields.description : "",
    emoji: (typeof fields.emoji === "string" && fields.emoji) || defaultEmoji(chat.id),
    lifecycle: fields.lifecycle === "closed" ? "closed" : "open",
    ...(fields.hidden === true ? { hidden: true } : {}),
    pinned: fields.pinned === true,
    ...(typeof fields.category === "string" && fields.category ? { category: fields.category } : {}),
    ...(typeof fields.status === "string" && fields.status ? { status: fields.status } : {}),
    ...(typeof fields.statusEmoji === "string" && fields.statusEmoji ? { statusEmoji: fields.statusEmoji } : {}),
    ...(fields.metadata && typeof fields.metadata === "object" ? { metadata: fields.metadata } : {}),
    ...(fields.lifecycle === "closed" && typeof fields.closedAt === "string" ? { closedAt: fields.closedAt } : {}),
    createdAt: chat.created_at,
    updatedAt: (typeof fields.updatedAt === "string" && fields.updatedAt) || chat.created_at,
  };
}

/** The card's lifecycle off a chat record — "open" when absent/corrupt. */
export function cardLifecycleOf(chat: { metadata?: string | null }): CardLifecycle {
  return rawCardFields(chat).lifecycle === "closed" ? "closed" : "open";
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
 * Merge `patch` into the card nested inside `chatId`'s metadata.
 * Returns the updated card, or `null` when the chat is missing.
 * Throws {@link CardFieldError} on validation failures (the chat is left
 * untouched).
 *
 * The write is view-only — `chat.updated_at` is not bumped.
 */
export function patchCardFields(chatId: string, patch: CardPatch): Card | null {
  const chat = chatFileService.getChat(chatId);
  if (!chat) return null;

  const existing: Record<string, unknown> = { ...rawCardFields(chat) };

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

  if (patch.lifecycle !== undefined) {
    const currentLifecycle: CardLifecycle = existing.lifecycle === "closed" ? "closed" : "open";
    // `closedAt` describes the transition, not the most recent idempotent
    // PATCH. Re-sending { lifecycle: "closed" } must not make an old card look
    // newly closed (or reorder the Closed strip).
    if (patch.lifecycle !== currentLifecycle) {
      existing.lifecycle = patch.lifecycle;
      if (patch.lifecycle === "closed") {
        existing.closedAt = new Date().toISOString();
      } else {
        delete existing.closedAt;
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

  const written = chatFileService.updateChatMetadata(chatId, { card: existing }, { touch: false });
  if (!written) throw new CardFieldWriteError(`Failed to persist card fields for chat "${chatId}"`);
  const updated = readCardFields(chatId);
  if (!updated) throw new CardFieldWriteError(`Card root chat "${chatId}" disappeared while it was being updated`);
  return updated;
}

/**
 * Whether a chat qualifies as a card root: it is a lineage root (no parent),
 * not triggered, and not a job-step chat. This is the exact set the old
 * auto-card logic created cards for, so board membership is unchanged. Pure
 * over the record — safe to call over a snapshot.
 */
export function isCardRoot(chat: { metadata?: string | null }): boolean {
  const meta = parseMeta(chat);
  const hasParent =
    (typeof meta.parentChatId === "string" && meta.parentChatId) ||
    (typeof meta.forkedFrom === "string" && meta.forkedFrom);
  return !hasParent && isCardEligible(chat);
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
