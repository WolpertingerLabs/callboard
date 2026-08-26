/**
 * One-time migration: cards-as-entity → cards-as-metadata-on-root-chat.
 *
 * Old model: one JSON file per card in `~/.callboard/data/cards/`, chats
 * joined via `metadata.cardId`, job runs via `run.cardId`.
 * New model: the card is a nested `metadata.card` object on the lineage
 * ROOT chat of the conversation that created it; membership is derived from
 * the parentage tree; runs carry `rootChatId`.
 *
 * Runs at daemon startup, before the server listens and before the job
 * runner resumes — so nothing caches or serves the old shapes mid-flight.
 *
 * Idempotence is layered, because a daemon can crash anywhere in here:
 *   - a `.migrated` marker in the cards dir short-circuits the whole thing;
 *   - each processed card is MOVED to `cards-archive/` as it completes, so
 *     a re-run never sees a half-done card twice;
 *   - the cardId→rootChatId map is persisted (`cards-archive/migration-map.json`)
 *     after each card, so a re-run can still rewrite job runs even when no
 *     card files remain;
 *   - the chat sweep (strip `metadata.cardId`) and the run rewrite are
 *     naturally idempotent re-runs of the same operation.
 *
 * Memberless cards (created from the board modal with no chat, or whose
 * chats were all deleted) are archived untouched rather than migrated —
 * nothing silently evaporates; the user can read them in cards-archive/.
 *
 * Deliberate data-model loss, per plans/cards-as-prompt-metadata.md: chats
 * deliberately grouped onto one card from DIFFERENT lineages (via the old
 * add_chat_to_card) collapse to each lineage's own root — the other chats
 * become cards of their own trees.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import type { Chat } from "shared";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";
import { chatFileService } from "./chat-file-service.js";
import { buildLineageIndex } from "./chat-lineage.js";
import { isCardRoot } from "./card-fields.js";

const log = createLogger("card-migration");

const cardsDir = join(DATA_DIR, "cards");
const archiveDir = join(DATA_DIR, "cards-archive");
const markerFile = join(cardsDir, ".migrated");
const mapFile = join(archiveDir, "migration-map.json");

function parseMeta(chat: Chat): Record<string, unknown> {
  try {
    return JSON.parse(chat.metadata || "{}");
  } catch {
    return {};
  }
}

/** Old-style membership: a non-empty-string `metadata.cardId`. */
function metaCardId(chat: Chat): string | undefined {
  const cardId = parseMeta(chat).cardId;
  return typeof cardId === "string" && cardId ? cardId : undefined;
}

function atomicWrite(filepath: string, content: string): void {
  const tmp = `${filepath}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, filepath);
}

/** Load the persisted cardId→rootChatId map (empty when no prior pass ran). */
function loadMap(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(mapFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveMap(map: Record<string, string>): void {
  atomicWrite(mapFile, JSON.stringify(map, null, 2));
}

/**
 * The old card entity's non-default fields, expressed as a
 * `metadata.card` patch. Only fields that differ from the new defaults are
 * written — the absent-means-default invariant is what lets a card exist
 * with no metadata.card object until someone edits it.
 */
function legacyCardToPatch(card: Record<string, unknown>, rootChat: Chat): Record<string, unknown> | null {
  const rootMeta = parseMeta(rootChat);
  // The new default title is the chat's own title (or prompt preview).
  const chatDefaultTitle = ((typeof rootMeta.title === "string" && rootMeta.title) || (typeof rootMeta.preview === "string" && rootMeta.preview) || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  const patch: Record<string, unknown> = {};

  if (typeof card.title === "string" && card.title && card.title !== chatDefaultTitle) {
    patch.title = card.title;
  }
  if (typeof card.description === "string" && card.description) {
    patch.description = card.description;
  }
  // The old store's default emoji was a constant; the new default is
  // hash-derived per card. A card still carrying the old default adopts the
  // new one rather than pinning the constant on every migrated card.
  if (typeof card.emoji === "string" && card.emoji && card.emoji !== "🗂️") {
    patch.emoji = card.emoji;
  }
  if (card.pinned === true) {
    patch.pinned = true;
  }
  if (typeof card.category === "string" && card.category) {
    patch.category = card.category;
  }
  if (typeof card.status === "string" && card.status) {
    patch.status = card.status;
  }
  if (typeof card.statusEmoji === "string" && card.statusEmoji) {
    patch.statusEmoji = card.statusEmoji;
  }
  if (card.metadata && typeof card.metadata === "object" && !Array.isArray(card.metadata) && Object.keys(card.metadata).length > 0) {
    patch.metadata = card.metadata;
  }
  if (card.lifecycle === "closed") {
    patch.lifecycle = "closed";
    if (typeof card.closedAt === "string" && card.closedAt) patch.closedAt = card.closedAt;
  }
  // Preserve the card entity's own edit history — the new card's updatedAt
  // is otherwise the chat's created_at.
  if (typeof card.updatedAt === "string" && card.updatedAt) {
    patch.updatedAt = card.updatedAt;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Run the migration. Returns a summary for the startup log. Safe to call on
 * every boot: the marker (and the per-card archive moves) make repeats free.
 */
export function migrateCardsToMetadata(): { skipped: boolean; migrated: number; archivedMemberless: number; chatsStripped: number; runsRewritten: number } {
  if (existsSync(markerFile)) return { skipped: true, migrated: 0, archivedMemberless: 0, chatsStripped: 0, runsRewritten: 0 };
  if (!existsSync(cardsDir)) mkdirSync(cardsDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });

  const result = { skipped: false, migrated: 0, archivedMemberless: 0, chatsStripped: 0, runsRewritten: 0 };
  const map = loadMap();

  const cardFiles = existsSync(cardsDir) ? readdirSync(cardsDir).filter((f) => f.endsWith(".json")) : [];
  const allChats = chatFileService.getAllChats();
  const { rootKeyOf } = buildLineageIndex(allChats);

  for (const file of cardFiles) {
    let card: Record<string, unknown>;
    try {
      card = JSON.parse(readFileSync(join(cardsDir, file), "utf8"));
    } catch (err: any) {
      // Unparseable card file: archive it (out of the live dir) and move on —
      // a corrupt entity must not block the daemon from starting.
      log.error(`Could not parse card file ${file}: ${err.message} — archiving untouched`);
      renameSync(join(cardsDir, file), join(archiveDir, file));
      continue;
    }
    const cardId = typeof card.id === "string" ? card.id : file.replace(/\.json$/, "");
    if (map[cardId]) continue; // already migrated by an earlier (crashed) pass

    // Members under the OLD model: chats carrying this card's id.
    const members = allChats.filter((c) => metaCardId(c) === cardId);
    if (members.length === 0) {
      // Memberless card — nothing to attach the metadata to. Archive the
      // file untouched so nothing silently evaporates.
      renameSync(join(cardsDir, file), join(archiveDir, file));
      result.archivedMemberless++;
      log.info(`Archived memberless card ${cardId} ("${card.title ?? "?"}") to cards-archive/`);
      continue;
    }

    // Root member: a member that is itself a lineage root AND qualifies as
    // a card root (not triggered, not a job step) — that is the chat whose
    // metadata.card becomes this card. Degrade to the oldest member when no
    // member qualifies (cross-tree groupings, all-triggered memberships...).
    const rootMembers = members.filter((m) => rootKeyOf(m.id) === m.id && isCardRoot(m));
    const candidates = rootMembers.length > 0 ? rootMembers : members;
    const root = candidates.reduce((oldest, m) => (m.created_at < oldest.created_at ? m : oldest));

    const patch = legacyCardToPatch(card, root);
    if (patch) {
      // View-only write: the card's fields must not bump the chat's
      // updated_at (it would resurface the chat as unread / reorder the
      // sidebar) — same discipline as every post-migration card write.
      const merged = { ...(parseMeta(root).card as Record<string, unknown> | undefined), ...patch };
      chatFileService.updateChatMetadata(root.id, { card: merged }, { touch: false });
      result.migrated++;
      log.info(`Migrated card ${cardId} ("${card.title ?? "?"}") onto root chat ${root.id}`);
    }

    // Card processed — move it out of the live dir and persist the mapping,
    // in this order, so a crash anywhere leaves a consistent re-run state.
    map[cardId] = root.id;
    renameSync(join(cardsDir, file), join(archiveDir, file));
    saveMap(map);
  }

  // Strip old membership pointers from every chat that still carries one.
  // Written as `null` (not key deletion) through the file service so the
  // write is cache-consistent; no reader of the key remains either way.
  for (const chat of allChats) {
    if (typeof parseMeta(chat).cardId === "string") {
      chatFileService.updateChatMetadata(chat.id, { cardId: null }, { touch: false });
      result.chatsStripped++;
    }
  }

  // Rewrite run.cardId → run.rootChatId through the map. Runs whose card was
  // archived memberless (or points at a card that no longer exists) simply
  // lose the pointer — they belong to no card, matching the old projection
  // where they only showed on a card that existed.
  const runsDir = join(DATA_DIR, "jobs", "runs");
  if (existsSync(runsDir)) {
    for (const file of readdirSync(runsDir).filter((f) => f.endsWith(".json"))) {
      const filepath = join(runsDir, file);
      let run: Record<string, unknown>;
      try {
        run = JSON.parse(readFileSync(filepath, "utf8"));
      } catch (err: any) {
        log.error(`Could not parse run file ${file}: ${err.message} — leaving it untouched`);
        continue;
      }
      if (typeof run.cardId !== "string") continue; // already rewritten, or never had one
      const rootChatId = map[run.cardId];
      if (rootChatId) run.rootChatId = rootChatId;
      delete run.cardId;
      // Plain file write, NOT job-store saveRun: the migration must not bump
      // updatedAt (it would reorder every run listing) nor touch the
      // execution-key index (not yet built at startup).
      atomicWrite(filepath, JSON.stringify(run, null, 2));
      result.runsRewritten++;
    }
  }

  writeFileSync(markerFile, new Date().toISOString());
  log.info(
    `Card migration complete: ${result.migrated} card(s) migrated onto root chats, ` +
      `${result.archivedMemberless} memberless card(s) archived, ${result.chatsStripped} chat(s) unlinked, ${result.runsRewritten} run(s) rewritten`,
  );
  return result;
}
