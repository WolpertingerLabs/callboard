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
 *   - a data-root `.cards-as-metadata-migrated` marker short-circuits it;
 *   - the cardId→rootChatId map is persisted (`cards-archive/migration-map.json`)
 *     before each archive move, so a re-run can still rewrite job runs even
 *     when no card files remain (and finishes a pending move when both exist);
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
 *
 * {@link repairStrandedCardFields} is exported alongside and runs on every
 * boot, marker or not: the first shipped migration could write card fields to
 * a chat that is not a lineage root, where nothing reads them, and the marker
 * means the migration itself will never revisit those installs.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import type { Chat } from "shared";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";
import { chatFileService } from "./chat-file-service.js";
import { buildLineageIndex } from "./chat-lineage.js";
import { isCardEligible } from "./card-fields.js";

const log = createLogger("card-migration");

const cardsDir = join(DATA_DIR, "cards");
const archiveDir = join(DATA_DIR, "cards-archive");
// Keep the marker in the data root. Creating cards/ merely to hold a marker
// would make every fresh install look like it carried legacy card entities
// (and contradict the post-migration data-dir contract in the README).
const markerFile = join(DATA_DIR, ".cards-as-metadata-migrated");
// Accepted for compatibility with development builds that used the original
// marker location before this migration shipped.
const legacyMarkerFile = join(cardsDir, ".migrated");
const mapFile = join(archiveDir, "migration-map.json");

function parseMeta(chat: Chat): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(chat.metadata || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function atomicWrite(filepath: string, content: string): void {
  const tmp = `${filepath}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, filepath);
}

/** Load the persisted cardId→rootChatId map (empty when no prior pass ran). */
function loadMap(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(mapFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function saveMap(map: Record<string, string>): void {
  mkdirSync(archiveDir, { recursive: true });
  atomicWrite(mapFile, JSON.stringify(map, null, 2));
}

function archiveCardFile(file: string): void {
  mkdirSync(archiveDir, { recursive: true });
  renameSync(join(cardsDir, file), join(archiveDir, file));
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
 * The chat a card's fields must be written to: the lineage root of the chat
 * we were about to write to. Returns null when that root is not in the corpus
 * or does not qualify as a card root, in which case the caller keeps its own
 * candidate — a card whose fields sit on a non-root chat is invisible, but a
 * card whose fields are dropped on the floor is gone.
 */
function resolveWriteTarget(candidate: Chat, existingRootIdOf: (id: string) => string, allChats: Chat[]): Chat | null {
  const rootId = existingRootIdOf(candidate.id);
  if (rootId === candidate.id) return candidate;
  const root = allChats.find((c) => c.id === rootId);
  return root && isCardEligible(root) ? root : null;
}

/**
 * Move card fields that are sitting on a non-root chat onto that chat's actual
 * lineage root, and clear the stranded copy.
 *
 * Separate from the migration and NOT gated on its marker, because the marker
 * has already been written on every real install: the bug fixed above (writing
 * `metadata.card` onto a non-root when no member of a legacy card was a
 * lineage root) left data behind that no later run of the migration will ever
 * revisit. `card-rollup.ts` only projects a card from a chat that is its own
 * lineage root, so those fields are not lost on disk — they are invisible,
 * which presents to the user as a card that silently shows the wrong title and
 * no status, and (with defect 2) as a card that will not reopen no matter how
 * many times they click it. Two such chats existed on the data dir this was
 * diagnosed against, one carrying a title, a narrative status and
 * `lifecycle: "closed"`.
 *
 * Merge rule: the root's own values win on conflict. The root is the record
 * the board has been showing and the one every editor has been writing to
 * since the migration, so a stranded value is by definition the older of the
 * two; only keys the root does not have are filled in.
 *
 * Idempotent: after a pass the stranded chats no longer carry `metadata.card`,
 * so a second call finds nothing. Runs on every boot for that reason — the
 * cost when there is nothing to repair is one lineage index over the corpus
 * the migration already builds.
 */
export function repairStrandedCardFields(): { repaired: number; cleared: number } {
  const result = { repaired: 0, cleared: 0 };
  const allChats = chatFileService.getAllChats();
  if (allChats.length === 0) return result;
  const { existingRootIdOf } = buildLineageIndex(allChats);
  const byId = new Map(allChats.map((chat) => [chat.id, chat]));

  for (const chat of allChats) {
    const rawStranded = parseMeta(chat).card;
    if (!rawStranded || typeof rawStranded !== "object" || Array.isArray(rawStranded)) continue;
    const rootId = existingRootIdOf(chat.id);
    if (rootId === chat.id) continue; // on its root already — the normal case

    const stranded = rawStranded as Record<string, unknown>;
    const root = byId.get(rootId);
    if (root && isCardEligible(root)) {
      const rawExisting = parseMeta(root).card;
      const existing = rawExisting && typeof rawExisting === "object" && !Array.isArray(rawExisting) ? (rawExisting as Record<string, unknown>) : {};
      const merged = { ...stranded, ...existing };
      // View-only write, like every other card write: merging fields must not
      // bump updated_at and resurface the chat as unread.
      if (!chatFileService.updateChatMetadata(root.id, { card: merged }, { touch: false })) {
        log.error(`Could not merge stranded card fields from chat ${chat.id} onto root ${root.id} — leaving both in place for the next boot`);
        continue;
      }
      result.repaired++;
      log.info(`Repaired stranded card fields: merged ${Object.keys(stranded).join(", ")} from chat ${chat.id} onto root chat ${root.id}`);
    } else {
      // No eligible root to merge into (the root is a triggered/job chat, or
      // is missing from the corpus). Clearing regardless is still right: these
      // fields were never readable, and leaving them makes a member chat's own
      // record disagree with its card — the state that makes reopen look
      // broken. Logged in full so the values are recoverable from the log.
      log.warn(`Clearing unreachable card fields on chat ${chat.id} (root ${rootId} is not a card root): ${JSON.stringify(stranded)}`);
    }

    if (!chatFileService.updateChatMetadata(chat.id, { card: null }, { touch: false })) {
      log.error(`Could not clear stranded card fields from chat ${chat.id}`);
      continue;
    }
    result.cleared++;
  }

  if (result.cleared > 0) {
    log.info(`Stranded card repair: ${result.repaired} card(s) merged onto their root chat, ${result.cleared} stranded copy/copies cleared`);
  }
  return result;
}

/**
 * Run the migration. Returns a summary for the startup log. Safe to call on
 * every boot: the marker (and the per-card archive moves) make repeats free.
 */
export function migrateCardsToMetadata(): { skipped: boolean; migrated: number; archivedMemberless: number; chatsStripped: number; runsRewritten: number } {
  if (existsSync(markerFile) || existsSync(legacyMarkerFile)) {
    return { skipped: true, migrated: 0, archivedMemberless: 0, chatsStripped: 0, runsRewritten: 0 };
  }

  const result = { skipped: false, migrated: 0, archivedMemberless: 0, chatsStripped: 0, runsRewritten: 0 };
  const map = loadMap();

  const cardFiles = existsSync(cardsDir) ? readdirSync(cardsDir).filter((f) => f.endsWith(".json")) : [];
  const allChats = chatFileService.getAllChats();
  const { existingRootIdOf } = buildLineageIndex(allChats);
  // Index the old membership pointers once. Filtering the whole corpus for
  // every card reparses N chat metadata blobs M times (hundreds of cards ×
  // thousands of chats) on the synchronous startup path.
  const membersByCard = new Map<string, Chat[]>();
  const chatsWithLegacyCardId = new Set<string>();
  for (const chat of allChats) {
    const cardId = parseMeta(chat).cardId;
    if (typeof cardId !== "string") continue;
    chatsWithLegacyCardId.add(chat.id);
    if (!cardId) continue;
    const members = membersByCard.get(cardId) ?? [];
    members.push(chat);
    membersByCard.set(cardId, members);
  }

  for (const file of cardFiles) {
    let card: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(cardsDir, file), "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("card file must contain a JSON object");
      }
      card = parsed as Record<string, unknown>;
    } catch (err: any) {
      // Unparseable card file: archive it (out of the live dir) and move on —
      // a corrupt entity must not block the daemon from starting.
      log.error(`Could not parse card file ${file}: ${err.message} — archiving untouched`);
      archiveCardFile(file);
      continue;
    }
    const cardId = typeof card.id === "string" ? card.id : file.replace(/\.json$/, "");
    if (map[cardId]) {
      // A crash after persisting the mapping but before the final archive move
      // leaves both. Finish that move now; merely `continue`-ing would write
      // the marker with a legacy card still live forever.
      archiveCardFile(file);
      continue;
    }

    // Members under the OLD model: chats carrying this card's id.
    const members = membersByCard.get(cardId) ?? [];
    if (members.length === 0) {
      // Memberless card — nothing to attach the metadata to. Archive the
      // file untouched so nothing silently evaporates.
      archiveCardFile(file);
      result.archivedMemberless++;
      log.info(`Archived memberless card ${cardId} ("${card.title ?? "?"}") to cards-archive/`);
      continue;
    }

    // Root member: a member that is itself a lineage root AND qualifies as
    // a card root (not triggered, not a job step) — that is the chat whose
    // metadata.card becomes this card. Degrade to the oldest member when no
    // member qualifies (cross-tree groupings, all-triggered memberships...).
    const rootMembers = members.filter((m) => existingRootIdOf(m.id) === m.id && isCardEligible(m));
    const candidates = rootMembers.length > 0 ? rootMembers : members;
    const oldest = candidates.reduce((prev, m) => (m.created_at < prev.created_at ? m : prev));
    // The degraded branch above can pick a chat that is NOT a lineage root,
    // and card-rollup.ts only ever projects a card from a chat where
    // existingRootIdOf(chat.id) === chat.id. Writing there put the user's
    // title/status/description somewhere nothing reads — not lost on disk,
    // but invisible, which is worse. Resolve to the tree's actual root so the
    // fields land where the board looks for them.
    const root = resolveWriteTarget(oldest, existingRootIdOf, allChats) ?? oldest;

    const patch = legacyCardToPatch(card, root);
    if (patch) {
      // View-only write: the card's fields must not bump the chat's
      // updated_at (it would resurface the chat as unread / reorder the
      // sidebar) — same discipline as every post-migration card write.
      const rawExisting = parseMeta(root).card;
      const existing = rawExisting && typeof rawExisting === "object" && !Array.isArray(rawExisting) ? (rawExisting as Record<string, unknown>) : {};
      const merged = { ...existing, ...patch };
      const written = chatFileService.updateChatMetadata(root.id, { card: merged }, { touch: false });
      // Never archive the only durable copy of a legacy card unless its fields
      // actually landed on the root chat. updateChatMetadata reports parse/I/O
      // failures as false; aborting leaves the live card in place for retry.
      if (!written) throw new Error(`Could not persist migrated card ${cardId} on root chat ${root.id}`);
      result.migrated++;
      log.info(`Migrated card ${cardId} ("${card.title ?? "?"}") onto root chat ${root.id}`);
    }

    // Persist the mapping BEFORE the archive move. If the process dies between
    // them, the map branch above finishes the move on retry; the reverse order
    // loses the only cardId→rootChatId evidence needed to rewrite legacy runs.
    map[cardId] = root.id;
    saveMap(map);
    archiveCardFile(file);
  }

  // Strip old membership pointers from every chat that still carries one.
  // Written as `null` (not key deletion) through the file service so the
  // write is cache-consistent; no reader of the key remains either way.
  for (const chat of allChats) {
    if (chatsWithLegacyCardId.has(chat.id)) {
      const stripped = chatFileService.updateChatMetadata(chat.id, { cardId: null }, { touch: false });
      if (!stripped) throw new Error(`Could not remove legacy cardId from chat ${chat.id}`);
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
        const parsed: unknown = JSON.parse(readFileSync(filepath, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("run file must contain a JSON object");
        }
        run = parsed as Record<string, unknown>;
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

  atomicWrite(markerFile, new Date().toISOString());
  log.info(
    `Card migration complete: ${result.migrated} card(s) migrated onto root chats, ` +
      `${result.archivedMemberless} memberless card(s) archived, ${result.chatsStripped} chat(s) unlinked, ${result.runsRewritten} run(s) rewritten`,
  );
  return result;
}
