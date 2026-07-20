/**
 * Card store — file-backed persistence for cards (tickets grouping chats
 * and job runs on the /board view).
 *
 *   ~/.callboard/data/cards/{cardId}.json   Card
 *
 * Writes are atomic (tmp file + rename) so a partial write is never
 * observable. Membership is not stored here: chats point at cards via
 * metadata.cardId and job runs via run.cardId, discovered by scan at
 * rollup time.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, rmSync } from "fs";
import { join } from "path";
import { randomUUID } from "node:crypto";
import type { Card, CardPatch, CardPayload } from "shared";
import { CARD_CATEGORY_MAX } from "shared";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("card-store");

const cardsDir = join(DATA_DIR, "cards");

if (!existsSync(cardsDir)) mkdirSync(cardsDir, { recursive: true });

export const CARD_TITLE_MAX = 200;
export const CARD_STATUS_MAX = 160;
export { CARD_CATEGORY_MAX };
export const CARD_METADATA_KEY_MAX = 64;
export const CARD_METADATA_VALUE_MAX = 2048;
export const CARD_METADATA_MAX_ENTRIES = 50;
const DEFAULT_EMOJI = "🗂️";

/** Thrown by {@link updateCard} on bad metadata; routes/tools map it to 400. */
export class CardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardValidationError";
  }
}

/**
 * Card ids we generate ({@link createCard}). Enforced on every read/write so a
 * route param can never escape cardsDir via `../` or an absolute path —
 * Express decodes %2F inside a path segment, so `..%2F..%2Ffoo` would otherwise
 * reach `join(cardsDir, "../../foo.json")`.
 */
const CARD_ID_RE = /^card-[A-Za-z0-9_-]+$/;

function cardFilePath(id: string): string | null {
  if (!CARD_ID_RE.test(id)) return null;
  return join(cardsDir, `${id}.json`);
}

function atomicWrite(filepath: string, content: string): void {
  const tmp = `${filepath}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, filepath);
}

function saveCard(card: Card): void {
  const filepath = cardFilePath(card.id);
  if (!filepath) throw new Error(`Invalid card id: ${card.id}`);
  atomicWrite(filepath, JSON.stringify(card, null, 2));
}

export function listCards(): Card[] {
  const cards: Card[] = [];
  for (const file of readdirSync(cardsDir).filter((f) => f.endsWith(".json"))) {
    try {
      cards.push(JSON.parse(readFileSync(join(cardsDir, file), "utf8")));
    } catch (err: any) {
      log.error(`Failed to read card ${file}: ${err.message}`);
    }
  }
  return cards;
}

export function getCard(id: string): Card | null {
  const filepath = cardFilePath(id);
  if (!filepath || !existsSync(filepath)) return null;
  try {
    return JSON.parse(readFileSync(filepath, "utf8"));
  } catch (err: any) {
    log.error(`Failed to read card ${id}: ${err.message}`);
    return null;
  }
}

export function cardExists(id: string): boolean {
  return getCard(id) !== null;
}

/**
 * Remove a card's file. Used for user-initiated deletion of CLOSED cards
 * (the route enforces lifecycle) and as best-effort cleanup for cards created
 * as part of a larger operation that then failed (e.g. auto-created alongside
 * a chat record whose write threw). Returns false when the id is invalid or
 * the file is already gone.
 */
export function deleteCard(id: string): boolean {
  const filepath = cardFilePath(id);
  if (!filepath || !existsSync(filepath)) return false;
  try {
    rmSync(filepath);
    return true;
  } catch (err: any) {
    log.error(`Failed to delete card ${id}: ${err.message}`);
    return false;
  }
}

export function createCard(payload: CardPayload): Card {
  const title = (payload.title ?? "").trim();
  if (!title) throw new Error("Card title is required");
  const now = new Date().toISOString();
  const category = typeof payload.category === "string" ? payload.category.trim().slice(0, CARD_CATEGORY_MAX) : "";
  const card: Card = {
    id: `card-${randomUUID().slice(0, 8)}-${Date.now().toString(36)}`,
    title: title.slice(0, CARD_TITLE_MAX),
    description: typeof payload.description === "string" ? payload.description : "",
    emoji: payload.emoji?.trim() || DEFAULT_EMOJI,
    lifecycle: "open",
    ...(category && { category }),
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  saveCard(card);
  return card;
}

/**
 * Merge a {@link CardPatch} metadata map onto a card's existing entries: each
 * key is set to its value, `null` deletes it, absent keys are untouched. Keys
 * are trimmed. Throws {@link CardValidationError} rather than silently
 * truncating, since a clipped URL or ticket id is worse than a rejected write.
 */
function applyMetadataPatch(current: Record<string, string> | undefined, patch: Record<string, string | null>): Record<string, string> {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new CardValidationError("metadata must be an object");
  }
  const merged: Record<string, string> = { ...(current ?? {}) };

  for (const [rawKey, value] of Object.entries(patch)) {
    const key = rawKey.trim();
    if (!key) throw new CardValidationError("metadata keys must be non-empty");
    // `merged` has no own `__proto__`, so assigning it would hit the inherited
    // Object.prototype setter — silently writing nothing and reporting success.
    if (key === "__proto__") throw new CardValidationError('"__proto__" is not a valid metadata key');
    if (key.length > CARD_METADATA_KEY_MAX) {
      throw new CardValidationError(`metadata key "${key.slice(0, 20)}…" exceeds ${CARD_METADATA_KEY_MAX} characters`);
    }
    if (value === null) {
      delete merged[key];
      continue;
    }
    if (typeof value !== "string") {
      throw new CardValidationError(`metadata value for "${key}" must be a string or null`);
    }
    if (value.length > CARD_METADATA_VALUE_MAX) {
      throw new CardValidationError(`metadata value for "${key}" exceeds ${CARD_METADATA_VALUE_MAX} characters`);
    }
    merged[key] = value;
  }

  if (Object.keys(merged).length > CARD_METADATA_MAX_ENTRIES) {
    throw new CardValidationError(`metadata is limited to ${CARD_METADATA_MAX_ENTRIES} entries`);
  }
  return merged;
}

/**
 * Read-merge-write partial update. Only provided fields are applied;
 * `status`/`statusEmoji: null` clear the narrative status, lifecycle
 * transitions maintain `closedAt`, and `metadata` merges per key (see
 * {@link applyMetadataPatch}). Returns null when the card is missing.
 */
export function updateCard(id: string, patch: CardPatch): Card | null {
  const card = getCard(id);
  if (!card) return null;

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error("Card title is required");
    card.title = title.slice(0, CARD_TITLE_MAX);
  }
  if (patch.description !== undefined) card.description = patch.description;
  if (patch.emoji !== undefined) card.emoji = patch.emoji.trim() || DEFAULT_EMOJI;
  if (patch.pinned !== undefined) card.pinned = patch.pinned === true;
  if (patch.status !== undefined) {
    if (patch.status === null || !patch.status.trim()) delete card.status;
    else card.status = patch.status.slice(0, CARD_STATUS_MAX);
  }
  if (patch.category !== undefined) {
    const category = patch.category === null ? "" : patch.category.trim();
    if (!category) delete card.category;
    else card.category = category.slice(0, CARD_CATEGORY_MAX);
  }
  if (patch.statusEmoji !== undefined) {
    if (patch.statusEmoji === null || !patch.statusEmoji.trim()) delete card.statusEmoji;
    else card.statusEmoji = patch.statusEmoji;
  }
  if (patch.metadata !== undefined) {
    const merged = applyMetadataPatch(card.metadata, patch.metadata);
    if (Object.keys(merged).length === 0) delete card.metadata;
    else card.metadata = merged;
  }
  if (patch.lifecycle !== undefined && patch.lifecycle !== card.lifecycle) {
    card.lifecycle = patch.lifecycle;
    if (patch.lifecycle === "closed") card.closedAt = new Date().toISOString();
    else delete card.closedAt;
  }

  card.updatedAt = new Date().toISOString();
  saveCard(card);
  return card;
}
