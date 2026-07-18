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
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import { randomUUID } from "node:crypto";
import type { Card, CardPatch, CardPayload } from "shared";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("card-store");

const cardsDir = join(DATA_DIR, "cards");

if (!existsSync(cardsDir)) mkdirSync(cardsDir, { recursive: true });

export const CARD_TITLE_MAX = 200;
export const CARD_STATUS_MAX = 160;
export const CARD_METADATA_MAX_ENTRIES = 50;
export const CARD_METADATA_KEY_MAX = 100;
export const CARD_METADATA_VALUE_MAX = 2000;
const DEFAULT_EMOJI = "🗂️";

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

export function createCard(payload: CardPayload): Card {
  const title = (payload.title ?? "").trim();
  if (!title) throw new Error("Card title is required");
  const now = new Date().toISOString();
  const card: Card = {
    id: `card-${randomUUID().slice(0, 8)}-${Date.now().toString(36)}`,
    title: title.slice(0, CARD_TITLE_MAX),
    description: typeof payload.description === "string" ? payload.description : "",
    emoji: payload.emoji?.trim() || DEFAULT_EMOJI,
    lifecycle: "open",
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  saveCard(card);
  return card;
}

/**
 * Merge a metadata patch into the card's existing entries. Keys are trimmed;
 * a null or blank value removes the key. Throws on invalid keys, oversized
 * values, or exceeding the entry cap — before anything is written.
 */
function mergeMetadata(existing: Record<string, string> | undefined, patch: Record<string, string | null>): Record<string, string> | undefined {
  const merged: Record<string, string> = { ...existing };
  for (const [rawKey, value] of Object.entries(patch)) {
    const key = rawKey.trim();
    if (!key) throw new Error("Metadata keys must be non-empty");
    if (key.length > CARD_METADATA_KEY_MAX) throw new Error(`Metadata keys must be at most ${CARD_METADATA_KEY_MAX} characters`);
    const trimmed = value?.trim();
    if (!trimmed) {
      delete merged[key];
    } else {
      if (trimmed.length > CARD_METADATA_VALUE_MAX) throw new Error(`Metadata values must be at most ${CARD_METADATA_VALUE_MAX} characters`);
      merged[key] = trimmed;
    }
  }
  const count = Object.keys(merged).length;
  if (count > CARD_METADATA_MAX_ENTRIES) throw new Error(`Cards support at most ${CARD_METADATA_MAX_ENTRIES} metadata entries (would have ${count})`);
  return count > 0 ? merged : undefined;
}

/**
 * Read-merge-write partial update. Only provided fields are applied;
 * `status`/`statusEmoji: null` clear the narrative status, lifecycle
 * transitions maintain `closedAt`, `metadata` merges per-key (null value
 * removes the key). Returns null when the card is missing.
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
  if (patch.statusEmoji !== undefined) {
    if (patch.statusEmoji === null || !patch.statusEmoji.trim()) delete card.statusEmoji;
    else card.statusEmoji = patch.statusEmoji;
  }
  if (patch.metadata !== undefined) {
    const merged = mergeMetadata(card.metadata, patch.metadata);
    if (merged) card.metadata = merged;
    else delete card.metadata;
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
