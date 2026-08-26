/**
 * Chats snapshot — the parsed chat corpus, found without re-reading chat
 * files that have not changed.
 *
 * ## The problem this exists for
 *
 * In the cards-as-metadata model, "which chats are on a card" is answered
 * by lineage: the board rollup (GET /api/cards) needs EVERY chat record,
 * because any of them can be a card root or a member of any root's tree,
 * and the root's `metadata.card` is where the card's fields live. On a real
 * data dir that is 8,138 files per request:
 *
 *   readdir            ~20 ms
 *   read + JSON.parse  ~150-310 ms
 *   sort by updated_at ~190-410 ms   (getAllChats sorts so it can paginate;
 *                                     the rollup groups and orders members
 *                                     itself, so the sort is pure waste here)
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
 * A file is only worth re-reading when it has changed, and `stat` answers
 * that far more cheaply than `read` + `JSON.parse`, with no sort at either
 * end:
 *
 *   readdir + stat x8138   ~65-130 ms warm, plus a read per file that moved
 *
 * Four to five times cheaper on the same data dir, returning every record.
 * It is also self-healing rather than hooked: nothing has to remember to
 * invalidate this index, because every call re-stats every file. A card
 * write, chat creation, or a record edited by hand is picked up by the next
 * call with no cooperation from the writer.
 *
 * The floor left is the 8,138 stat calls themselves. Going below it means
 * trusting write hooks to maintain the index, and a missed writer there is
 * a card that has silently lost a member until the daemon restarts — a much
 * worse failure than the one being fixed.
 *
 * Unlike its predecessor (which cached only the ~3% of records carrying a
 * `metadata.cardId`, keeping the index around a megabyte), this snapshot
 * keeps every parsed record — the lineage model has no membership key to
 * filter on. That is a standing ~10 MB on an 8k-record data dir: real, but
 * bounded by the corpus and paid once, versus the parse cost paid on every
 * poll. If the corpus ever grows another order of magnitude, revisit here.
 *
 * ## Freshness, exactly
 *
 * An entry is reused when `(mtimeNs, size)` both match, and the timestamp is
 * the load-bearing half — a same-length rewrite is the normal case for these
 * records (`updated_at` is a fixed-width timestamp, one field swaps for
 * another of equal length), so size alone would miss it.
 *
 * That leaves exactly one way for a write to hide: landing in the same mtime
 * *tick* as the read that cached the entry. The tick is the filesystem's to
 * choose — nanoseconds on ext4 with 256-byte inodes, whole seconds on ext3
 * and HFS+, two on FAT — so rather than assume a resolution, an entry read
 * while its mtime is still inside the current tick is simply not cached. See
 * {@link COARSE_MTIME_WINDOW_MS} in utils/mtime-freshness.ts. With that rule
 * the reuse gate is sound on any granularity, and on a nanosecond filesystem
 * the writes it re-reads are ones two sequential `writeFileSync` calls could
 * never have collided on anyway.
 *
 * Only successful reads are cached. A read or parse that throws leaves the
 * file out of the snapshot entirely, so a transient failure (EMFILE, a
 * record caught mid-rewrite by a future async writer) is retried on the next
 * call rather than latched into a chat that has silently vanished from the
 * board.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { Chat } from "shared";
import { DATA_DIR } from "../utils/paths.js";
import { createLogger } from "../utils/logger.js";
import { isMtimeSettled } from "../utils/mtime-freshness.js";

const log = createLogger("chats-snapshot");

const chatsDir = join(DATA_DIR, "chats");

interface IndexEntry {
  mtimeNs: bigint;
  size: bigint;
  chat: Chat;
}

const index = new Map<string, IndexEntry>();

/**
 * Every chat record on disk, parsed, in **directory order** — which on ext4
 * is a hash of the filename, so treat it as arbitrary.
 *
 * Deliberately unsorted: callers either group by lineage (the rollup, the
 * chats route's cards-only filter — both order members themselves) or sort
 * by their own key. A sort here is thrown away by every consumer; it was a
 * third of the cost the index exists to avoid.
 */
export function listChatsSnapshot(): Chat[] {
  let files: string[];
  try {
    files = readdirSync(chatsDir).filter((file) => file.endsWith(".json"));
  } catch (error) {
    log.error(`Error reading chats directory: ${error}`);
    return [];
  }

  const chats: Chat[] = [];
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
      chats.push(cached.chat);
      continue;
    }

    // Only entries whose tick has already closed are worth remembering; see
    // isMtimeSettled. Computed before the read so a slow read cannot talk us
    // into trusting a timestamp that was fresh when we opened it.
    const cacheable = isMtimeSettled(stats.mtimeNs);

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

    if (cacheable) index.set(file, { mtimeNs: stats.mtimeNs, size: stats.size, chat });
    else index.delete(file);
    chats.push(chat);
  }

  for (const file of index.keys()) if (!present.has(file)) index.delete(file);

  return chats;
}

/** Drop everything cached. For tests; production never needs it (see header). */
export function resetChatsSnapshot(): void {
  index.clear();
}
