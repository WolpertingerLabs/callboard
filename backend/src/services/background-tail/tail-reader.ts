/**
 * Read the end of a growing log file without ever blocking on it.
 *
 * Opens with `O_NONBLOCK` (and `O_NOFOLLOW` when asked) and checks `fstat`
 * on the open handle, so a FIFO or device named as a redirect target is
 * reported `not_regular` instead of hanging the request, and a file swapped
 * between the caller's stat and our open is caught by the inode check.
 */
import { constants } from "fs";
import { open } from "fs/promises";

export const DEFAULT_TAIL_BYTES = 64 * 1024;
export const DEFAULT_TAIL_LINES = 200;
export const MAX_TAIL_LINES = 500;

export type TailResult =
  | { ok: true; size: number; mtimeMs: number; ino: number; lines: string[]; truncated: boolean; binary: boolean }
  | { ok: false; error: "missing" | "not_regular" | "unreadable" | "refused" };

export function clampLines(n: unknown): number {
  const v = typeof n === "number" ? n : typeof n === "string" && n.trim() !== "" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return DEFAULT_TAIL_LINES;
  return Math.min(MAX_TAIL_LINES, Math.max(1, Math.floor(v)));
}

// CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), and other two-byte escapes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]/g;

/** One display line: progress-bar redraws (`\r`) collapse to their last frame; escape sequences go. */
export function cleanLine(line: string): string {
  let l = line.endsWith("\r") ? line.replace(/\r+$/, "") : line;
  const cr = l.lastIndexOf("\r");
  if (cr >= 0) l = l.slice(cr + 1);
  return l.replace(ANSI, "");
}

/** Length of `buf` without a trailing, incomplete UTF-8 sequence (the writer is mid-character). */
function completeUtf8Length(buf: Buffer): number {
  const n = buf.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = buf[n - back];
    if ((b & 0xc0) === 0x80) continue; // continuation byte; keep looking for the lead
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? n - back : n;
  }
  return n;
}

export async function readTail(absPath: string, opts: { maxBytes?: number; lines?: number; noFollow?: boolean; expectIno?: number } = {}): Promise<TailResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_TAIL_BYTES;
  const want = clampLines(opts.lines ?? DEFAULT_TAIL_LINES);
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOCTTY ?? 0) | (opts.noFollow ? constants.O_NOFOLLOW : 0);

  let fh;
  try {
    fh = await open(absPath, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, error: "missing" };
    if (code === "ELOOP") return { ok: false, error: "refused" };
    if (code === "ENXIO") return { ok: false, error: "not_regular" }; // e.g. a socket
    return { ok: false, error: "unreadable" };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { ok: false, error: "not_regular" };
    if (opts.expectIno !== undefined && st.ino !== opts.expectIno) return { ok: false, error: "refused" };

    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    let bytes = buf.subarray(0, got);

    let nul = 0;
    for (const b of bytes) if (b === 0) nul++;
    if (bytes.length > 0 && nul / bytes.length > 0.01) {
      return { ok: true, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, lines: [], truncated: start > 0, binary: true };
    }

    let truncated = false;
    if (start > 0) {
      truncated = true;
      let skip = 0;
      while (skip < bytes.length && (bytes[skip] & 0xc0) === 0x80) skip++;
      bytes = bytes.subarray(skip);
      // The first line is (almost certainly) cut; drop it unless it is all we have.
      const nl = bytes.indexOf(0x0a);
      if (nl >= 0) bytes = bytes.subarray(nl + 1);
    }
    bytes = bytes.subarray(0, completeUtf8Length(bytes));

    const parts = bytes.toString("utf8").split("\n");
    if (parts.length && parts[parts.length - 1] === "") parts.pop();
    if (parts.length > want) truncated = true;
    const lines = parts.slice(-want).map(cleanLine);
    return { ok: true, size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, lines, truncated, binary: false };
  } catch {
    return { ok: false, error: "unreadable" };
  } finally {
    await fh.close().catch(() => {});
  }
}
