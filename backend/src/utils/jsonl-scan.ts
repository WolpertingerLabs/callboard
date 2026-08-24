/**
 * Read a JSONL file lazily, stopping at the first line that answers the caller.
 *
 * Every session format this codebase reads is JSONL, and the two questions the
 * chat list asks of one — "what cwd is this?" and "what did the user first
 * say?" — are answered by a line at the very top. Slurping the file to answer
 * them means reading the whole corpus per request: on a real device the 30 rows
 * of one sidebar page span **49 MB** of transcript, and the first user message
 * sits at byte ~3,000 even in a 13.5 MB log. Measured, that is 242 ms of blocked
 * event loop per chat-list request against 6 ms for the same answers here.
 *
 * A torn/partial line is skipped rather than fatal, and a missing or unreadable
 * file yields `undefined` rather than throwing — including when the failure is
 * the *read* rather than the open (`EIO` on a failing disk, `ESTALE` on a
 * network-mounted home). One unreadable transcript must cost the chat list that
 * transcript, not the whole response.
 *
 * Chunk boundaries are a decoding hazard, not just a line-splitting one: a
 * multi-byte character straddling one would become U+FFFD on both sides if each
 * chunk were decoded on its own, and — because the corruption lands *inside* a
 * JSON string — the line would still parse, so the damage would surface as
 * mojibake in a sidebar preview rather than as an error. {@link StringDecoder}
 * carries the partial sequence across the boundary, which is what a whole-file
 * `readFileSync(…, "utf-8")` does implicitly.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/** How much of the file to pull per read. */
const CHUNK_BYTES = 64 * 1024;

/**
 * Scan `filePath` a chunk at a time, handing each parsed line to `visit` and
 * returning the first value `visit` produces.
 *
 * `visit` returning `undefined` means "keep looking", so a line that matches
 * structurally but carries nothing usable (a user turn whose content has no
 * text block) falls through to the next line exactly as a full-file loop with
 * a `continue` would.
 *
 * Returns `undefined` when the file is unreadable or no line answered.
 */
export function scanJsonlLines<T>(filePath: string, visit: (line: any) => T | undefined): T | undefined {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return undefined;
  }
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    for (;;) {
      let bytes: number;
      try {
        bytes = readSync(fd, chunk, 0, chunk.length, null);
      } catch {
        return undefined;
      }
      const atEof = bytes === 0;
      // `end()` flushes any dangling partial sequence as U+FFFD, matching what
      // decoding the whole (truncated) file at once would have produced.
      pending += atEof ? decoder.end() : decoder.write(chunk.subarray(0, bytes));
      // Everything before the last newline is complete; the tail may be a line
      // split across this chunk boundary, so it waits for the next read. At EOF
      // there is no next read, so the tail is complete too.
      const cut = atEof ? pending.length : pending.lastIndexOf("\n") + 1;
      const ready = pending.slice(0, cut);
      pending = pending.slice(cut);
      for (const line of ready.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const hit = visit(parsed);
        if (hit !== undefined) return hit;
      }
      if (atEof) return undefined;
    }
  } finally {
    closeSync(fd);
  }
}
