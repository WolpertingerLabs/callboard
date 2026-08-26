/**
 * When a file's mtime is allowed to stand in for its contents.
 *
 * Two caches in this codebase avoid re-reading the chat corpus by reusing an
 * entry whose `(mtime, size)` still match — `chats-snapshot.ts` (the board's
 * membership scan) and `chat-file-service.ts` (`getAllChats`). Both depend on
 * the same non-obvious property, so the rule lives here rather than being
 * stated twice: a second copy is one edit away from disagreeing, and the way it
 * would disagree is a record that silently stops updating.
 */

/**
 * How far in the past a file's mtime must already be, at the moment we read it,
 * before that mtime is allowed to stand in for the file's contents.
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
export const COARSE_MTIME_WINDOW_MS = 2_000;

/**
 * Has this file's mtime tick closed, making it safe to cache against?
 *
 * Call this *before* reading the file, so a slow read cannot talk you into
 * trusting a timestamp that was still fresh when you opened it.
 */
export function isMtimeSettled(mtimeNs: bigint, now: number = Date.now()): boolean {
  return now - Number(mtimeNs / 1_000_000n) >= COARSE_MTIME_WINDOW_MS;
}
