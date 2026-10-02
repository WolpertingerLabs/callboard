/**
 * Atomic, durable file writes: a fresh tmp file is written and fsynced, renamed
 * over the target, and the directory fsynced after — so a reader (or a power
 * loss) sees either the previous contents or the new ones, never a truncated
 * mix. See the storage service's "Atomic, durable writes" note for why each
 * fsync is there.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "fs";
import path from "path";

export interface DurableWriteOptions {
  /** Permission bits for the newly created file (subject to umask). Defaults to the fs default (0o666). */
  mode?: number;
}

/** Write a new file (`wx`) and fsync its data before returning (fsync flushes the inode, whichever descriptor asks). */
export function writeFileDurableSync(file: string, data: string | Buffer, options: DurableWriteOptions = {}): void {
  writeFileSync(file, data, { flag: "wx", ...(options.mode !== undefined ? { mode: options.mode } : {}) });
  const fd = openSync(file, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * fsync a directory so the names created or removed in it are durable. Best
 * effort: some platforms (Windows) cannot open a directory for fsync, and
 * there it is skipped — the ordering then holds for process crashes only.
 */
export function fsyncDirSync(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* not supported here */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Write `data` to `target` via a pid-suffixed dot-prefixed tmp file + rename,
 * durably (tmp fsynced before the rename, the directory after). The tmp is
 * unlinked on failure; one orphaned by a crash is named
 * `.<basename>.<pid>.<8 hex>.tmp`.
 */
export function atomicWriteFileSync(target: string, data: string | Buffer, options: DurableWriteOptions = {}): void {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileDurableSync(tmp, data, options);
    renameSync(tmp, target);
    fsyncDirSync(path.dirname(target));
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}
