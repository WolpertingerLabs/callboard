/**
 * A small JSON file store with an in-memory cache, for the daemon's auth files
 * (sessions.json, api-keys.json) — read on every request, written rarely.
 *
 * - Writes are atomic (tmp + rename, see atomic-write.ts) and created 0o600:
 *   these files hold secrets, and a crash mid-write must not leave a
 *   truncated file behind. No fsync: tmp + rename is what prevents truncation,
 *   and sessions.json is rewritten on authenticated requests, where a
 *   synchronous fsync of file and directory would stall the event loop.
 * - The cache is keyed on the file's real stat (inode, mtimeNs, size), so an
 *   out-of-band edit or replacement is picked up on the next load.
 * - A file that fails to parse does not throw. It is renamed aside to
 *   `<file>.corrupt-<timestamp>` (kept for inspection, never overwritten) and
 *   the store continues empty. For sessions that logs everyone out, which beats
 *   the alternative: every auth check throwing until someone fixes the file by
 *   hand. The next load finds no file and recreates it empty; the corrupt
 *   copy is never touched again.
 * - ...unless the file is merely mid-write. Something outside the daemon may
 *   rewrite it in place, and a read that lands inside that write sees half a
 *   file. So a parse failure is re-read a couple of times, a few ms apart, and
 *   the file is only moved aside when it still fails AND its (mtimeNs, size)
 *   held still across the wait — stably corrupt. A file still changing after
 *   the last attempt throws for this one load and is left exactly where it is;
 *   the next load reads it again.
 */
import { renameSync, readFileSync, statSync, type BigIntStats } from "fs";
import { atomicWriteFileSync } from "./atomic-write.js";
import { createLogger } from "./logger.js";

const log = createLogger("json-file-store");

/** Auth files hold secrets: owner read/write only. */
const SECRET_FILE_MODE = 0o600;

/** Re-reads of a file that failed to parse: 3 × 20ms, so at most ~60ms on the event loop. */
const TORN_READ_RETRIES = 3;
const TORN_READ_RETRY_DELAY_MS = 20;

/** `load()` is synchronous, so the wait between re-reads has to be too. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface JsonFileStore<T> {
  /** Current contents. Creates the file (with `empty()`) when absent. */
  load(): T;
  /** Replace the contents atomically. */
  save(data: T): void;
}

interface CacheKey {
  ino: bigint;
  mtimeNs: bigint;
  size: bigint;
}

function sameKey(a: CacheKey, b: BigIntStats): boolean {
  return a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.size === b.size;
}

function statOrNull(filePath: string): BigIntStats | null {
  try {
    return statSync(filePath, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function createJsonFileStore<T>(filePath: string, empty: () => T): JsonFileStore<T> {
  let cache: T | null = null;
  let cacheKey: CacheKey | null = null;

  function remember(data: T, st: BigIntStats | null): void {
    cache = data;
    cacheKey = st ? { ino: st.ino, mtimeNs: st.mtimeNs, size: st.size } : null;
  }

  function save(data: T): void {
    atomicWriteFileSync(filePath, JSON.stringify(data, null, 2), { mode: SECRET_FILE_MODE, fsync: false });
    remember(data, statOrNull(filePath));
  }

  function load(): T {
    const st = statOrNull(filePath);
    if (!st) {
      const initial = empty();
      save(initial);
      return initial;
    }
    if (cache !== null && cacheKey && sameKey(cacheKey, st)) return cache;

    const raw = readFileSync(filePath, "utf8");
    try {
      const parsed = JSON.parse(raw) as T;
      remember(parsed, st);
      return parsed;
    } catch (firstErr) {
      // Mid-write or corrupt? Wait, look again, and only call it corrupt once
      // the file has stopped changing and still does not parse.
      let err = firstErr;
      let before: BigIntStats = st;
      for (let attempt = 1; ; attempt++) {
        sleepSync(TORN_READ_RETRY_DELAY_MS);
        const after = statOrNull(filePath);
        // Replaced by rename and momentarily absent, or deleted: start over.
        if (!after) return load();
        try {
          const parsed = JSON.parse(readFileSync(filePath, "utf8")) as T;
          remember(parsed, after);
          return parsed;
        } catch (retryErr) {
          err = retryErr;
        }
        if (sameKey(before, after)) break;
        if (attempt >= TORN_READ_RETRIES) throw err;
        before = after;
      }

      const fallback = empty();
      const aside = `${filePath}.corrupt-${Date.now()}`;
      try {
        renameSync(filePath, aside);
        log.error(`${filePath} is not valid JSON (${(err as Error).message}); moved it to ${aside} and continuing with an empty store`);
        // Not cached against a stat: the next load finds no file and creates it empty.
        remember(fallback, null);
      } catch (renameErr) {
        log.error(
          `${filePath} is not valid JSON (${(err as Error).message}) and could not be moved aside (${(renameErr as Error).message}); continuing with an empty store`,
        );
        // Cached against the corrupt file's stat so every request doesn't re-read and re-log it.
        remember(fallback, st);
      }
      return fallback;
    }
  }

  return { load, save };
}
