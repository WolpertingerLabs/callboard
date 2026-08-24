/**
 * Card membership index — the chat records that carry a `metadata.cardId`,
 * found without re-reading every chat record to look for them.
 *
 * ## The problem this exists for
 *
 * Membership lives on the chat side and is discovered by scan (see
 * card-rollup.ts), so "which chats are on a card" has always meant reading
 * every record in `~/.callboard/chats`. On a real data dir that is 8,138 files
 * to find the 239 that answer yes, and `GET /api/cards` pays it per request:
 *
 *   readdir            ~20 ms
 *   read + JSON.parse  ~150-310 ms
 *   sort by updated_at ~190-410 ms   (getAllChats sorts so it can paginate;
 *                                     the rollup re-sorts members itself, and
 *                                     `new Date()` twice per comparison over
 *                                     8k records is not cheap)
 *   ------------------------------
 *   total              ~360-555 ms
 *
 * All of it synchronous, so all of it is blocked event loop — measured
 * out-of-process, a 1 ms `/api/sessions/poll` went to 1.9 s while one cards
 * request ran. And the route is not rare: the board refetches on every
 * metadata change and every 15 s, the sidebar refetches on every metadata
 * change, and each open tab does both.
 *
 * ## What it does instead
 *
 * A file is only worth re-reading when it has changed, and `stat` answers that
 * far more cheaply than `read` + `JSON.parse`, with no sort at either end:
 *
 *   readdir + stat x8138   ~65-130 ms warm, plus a read per file that moved
 *
 * Four to five times cheaper on the same data dir, returning the same 239
 * records. It is also self-healing rather than hooked: nothing has to remember
 * to invalidate this index, because every call re-stats every file. A
 * membership write from any path — the REST routes, the MCP tools, chat
 * creation, a file edited by hand — is picked up by the next call with no
 * cooperation from the writer.
 *
 * The floor left is the 8,138 stat calls themselves. Going below it means
 * trusting write hooks to maintain the index, and a missed writer there is a
 * card that has silently lost a member until the daemon restarts — a much
 * worse failure than the one being fixed.
 *
 * ## Freshness, exactly
 *
 * An entry is reused when `(mtimeNs, size)` both match, and the timestamp is
 * the load-bearing half — a same-length rewrite is the normal case for these
 * records (`updated_at` is a fixed-width timestamp, one `cardId` swaps for
 * another of equal length), so size alone would miss it.
 *
 * That leaves exactly one way for a write to hide: landing in the same mtime
 * *tick* as the read that cached the entry. The tick is the filesystem's to
 * choose — nanoseconds on ext4 with 256-byte inodes, whole seconds on ext3 and
 * HFS+, two on FAT — so rather than assume a resolution, an entry read while
 * its mtime is still inside the current tick is simply not cached. See
 * {@link COARSE_MTIME_WINDOW_MS}. With that rule the reuse gate is sound on any
 * granularity, and on a nanosecond filesystem the writes it re-reads are ones
 * two sequential `writeFileSync` calls could never have collided on anyway.
 *
 * Only successful reads are cached. A read or parse that throws leaves the
 * file out of the index entirely, so a transient failure (EMFILE, a record
 * caught mid-rewrite by a future async writer) is retried on the next call
 * rather than latched into a chat that has silently vanished from the board.
 *
 * ## What deliberately still scans
 *
 * `unassignAllChatsFromCard` (card-membership.ts) runs once per card deletion
 * and reads every record. It asks this same question and could use this index,
 * but it is not on a hot path and the measurement above is about requests that
 * arrive several times a second. Left alone on purpose; if a second write path
 * ever wants it, this is the thing to reach for.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { Chat } from "shared";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("card-member-index");

const chatsDir = join(DATA_DIR, "chats");

/**
 * A chat's card, read off already-parsed metadata, or undefined.
 *
 * Unassign merges `cardId: null` rather than deleting the key, so membership
 * is a non-empty-string check and never key presence. Exported so this index
 * and the rollup that consumes it cannot drift on what "is on a card" means —
 * a chat the index filtered out and one the rollup then ignores have to be the
 * same set, or the board loses members.
 */
export function metaCardId(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const cardId = (meta as Record<string, unknown>).cardId;
  return typeof cardId === "string" && cardId ? cardId : undefined;
}

/** {@link metaCardId} against a chat record's raw metadata blob. */
export function chatCardId(chat: Pick<Chat, "metadata">): string | undefined {
  try {
    return metaCardId(JSON.parse(chat.metadata || "{}"));
  } catch {
    return undefined;
  }
}

/**
 * How far in the past a file's mtime must already be, at the moment we read
 * it, before that mtime is allowed to stand in for the file's contents.
 *
 * This is the guard against a *coarse* clock, and it has to exist because the
 * granularity is the filesystem's to choose, not ours: ext4 stores nanoseconds
 * only with 256-byte inodes, HFS+ and ext3 store whole seconds, FAT stores two.
 * On any of those, a record written twice inside one tick with an equal-length
 * payload — the normal shape here, since `updated_at` is a fixed-width
 * timestamp — presents the same `(mtime, size)` before and after, and a scan
 * that ran between the two writes would cache the first forever.
 *
 * So an entry read while its mtime is still inside the current tick is not
 * cacheable: a later write could still land in that same tick. Two seconds
 * covers the coarsest granularity in play. The next scan re-reads it, by which
 * time the tick has closed and the entry becomes cacheable — so the cost is a
 * re-read of the handful of records written in the last two seconds, not a
 * standing penalty. Same rule `make` and `rsync` use for the same reason.
 */
const COARSE_MTIME_WINDOW_MS = 2_000;

interface IndexEntry {
  mtimeNs: bigint;
  size: bigint;
  /**
   * The record — kept only when it is on a card. The other ~97% of files are
   * remembered as a `null` so they are not re-read, which is what keeps the
   * index around a megabyte rather than the whole chat corpus in memory.
   */
  chat: Chat | null;
}

const index = new Map<string, IndexEntry>();

/**
 * Every chat record that currently carries a `metadata.cardId`, in **directory
 * order** — which on ext4 is a hash of the filename, so treat it as arbitrary.
 *
 * Deliberately unsorted: the rollup groups by card and orders each group's
 * members itself, so a sort here would be thrown away. A caller that renders
 * this list directly has to apply its own — `get_card` does.
 */
export function listCardMemberChats(): Chat[] {
  let files: string[];
  try {
    files = readdirSync(chatsDir).filter((file) => file.endsWith(".json"));
  } catch (error) {
    log.error(`Error reading chats directory: ${error}`);
    return [];
  }

  const members: Chat[] = [];
  const present = new Set<string>();

  for (const file of files) {
    present.add(file);
    const filepath = join(chatsDir, file);

    let stats;
    try {
      stats = statSync(filepath, { bigint: true });
    } catch {
      // Deleted between the readdir and here — nothing to report, and the
      // entry goes with it.
      index.delete(file);
      continue;
    }

    const cached = index.get(file);
    if (cached && cached.mtimeNs === stats.mtimeNs && cached.size === stats.size) {
      if (cached.chat) members.push(cached.chat);
      continue;
    }

    // Only entries whose tick has already closed are worth remembering; see
    // COARSE_MTIME_WINDOW_MS. Computed before the read so a slow read cannot
    // talk us into trusting a timestamp that was fresh when we opened it.
    const cacheable = Date.now() - Number(stats.mtimeNs / 1_000_000n) >= COARSE_MTIME_WINDOW_MS;

    let chat: Chat;
    try {
      chat = JSON.parse(readFileSync(filepath, "utf8"));
    } catch (error) {
      // Not cached: see the module header. An unreadable record is retried
      // rather than latched, so it cannot disappear from the board for as
      // long as nothing happens to touch it.
      log.error(`Error reading chat file ${file}: ${error}`);
      index.delete(file);
      continue;
    }

    const onCard = chatCardId(chat) !== undefined ? chat : null;
    if (cacheable) index.set(file, { mtimeNs: stats.mtimeNs, size: stats.size, chat: onCard });
    else index.delete(file);
    if (onCard) members.push(onCard);
  }

  for (const file of index.keys()) if (!present.has(file)) index.delete(file);

  return members;
}

/** Drop everything cached. For tests; production never needs it (see header). */
export function resetCardMemberIndex(): void {
  index.clear();
}
