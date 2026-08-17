/**
 * The chunked rollout reader — the thing that made reading a rollout's head
 * cheap, and the two ways chunking can go wrong quietly.
 *
 * Rollouts run to megabytes, so the reader pulls 64 KB at a time and stops at
 * the first line that answers. Both failure modes below are silent by
 * construction, which is why they get tests of their own:
 *
 *  - a **multi-byte character straddling a chunk boundary**, which decodes to
 *    U+FFFD on both sides if each chunk is decoded on its own. The damage lands
 *    inside a JSON string, so the line still parses — the preview is not
 *    dropped, it is quietly wrong, and it is the user's own words that come
 *    back as mojibake.
 *  - a **read that fails after the open succeeded**. This reader is called from
 *    discovery's visible-filter loop, outside any try, so a throw does not cost
 *    one rollout — it 500s GET /api/chats and blanks the sidebar.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearCodexSessionMetaCache, readCodexSessionMeta, readFirstUserPrompt } from "./sessionParser.js";

const THREAD_ID = "019ec7f2-cd5d-7823-b2d1-6683c42bfe32";
/** The reader's read size — the boundary this file aims characters at. */
const CHUNK_BYTES = 64 * 1024;

/** 2-, 3- and 4-byte sequences, so every continuation-byte offset is swept. */
const PROMPT = "Résumé the “design doc” — it's in ~/docs → 😀 done";
const PROMPT_BYTES = Buffer.byteLength(PROMPT);

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-scan-"));
  filePath = join(dir, `rollout-2026-06-14T17-03-58-${THREAD_ID}.jsonl`);
  clearCodexSessionMetaCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearCodexSessionMetaCache();
});

/** A two-line rollout whose meta line carries `padBytes` of ASCII filler. */
function rollout(padBytes: number): string {
  const meta = JSON.stringify({
    type: "session_meta",
    payload: { id: THREAD_ID, timestamp: "2026-06-14T17:03:58.000Z", cwd: "/p/x", cli_version: "0.139.0", pad: "z".repeat(padBytes) },
  });
  const user = JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: PROMPT } });
  return `${meta}\n${user}\n`;
}

/** Byte offset at which the prompt's text starts. JSON leaves it unescaped. */
function promptOffsetOf(text: string): number {
  const idx = text.indexOf(PROMPT);
  if (idx < 0) throw new Error("prompt not found verbatim in the rollout");
  return Buffer.byteLength(text.slice(0, idx));
}

/** Padding that puts the prompt's first byte exactly at `target`. */
function padFor(target: number): number {
  const probe = 60_000;
  return probe + (target - promptOffsetOf(rollout(probe)));
}

describe("readFirstUserPrompt — characters straddling a 64 KB chunk boundary", () => {
  it("returns the prompt intact wherever the boundary falls inside it", () => {
    // Walk the 65536-byte boundary through the prompt one byte at a time,
    // starting and ending just clear of it as controls. Decoding each chunk on
    // its own corrupts every offset that lands mid-sequence — for this prompt,
    // one failure per continuation byte.
    const corrupted: number[] = [];
    for (let start = CHUNK_BYTES - PROMPT_BYTES - 1; start <= CHUNK_BYTES + 1; start++) {
      const text = rollout(padFor(start));
      expect(promptOffsetOf(text)).toBe(start);
      expect(Buffer.byteLength(text)).toBeGreaterThan(CHUNK_BYTES);
      writeFileSync(filePath, text, "utf-8");
      if (readFirstUserPrompt(filePath) !== PROMPT) corrupted.push(CHUNK_BYTES - start);
    }
    // Reported as "bytes of the prompt that preceded the boundary", so a
    // failure names the split points rather than the padding sizes.
    expect(corrupted).toEqual([]);
  });

  it("puts the boundary inside a 4-byte astral character specifically", () => {
    // The sweep above covers this, but pinning the astral case on its own means
    // a regression names itself: a split surrogate pair is the case a
    // stateless decoder mangles into two replacement characters.
    const emojiIndex = Buffer.byteLength(PROMPT.slice(0, PROMPT.indexOf("😀")));
    for (let split = 1; split <= 3; split++) {
      const text = rollout(padFor(CHUNK_BYTES - emojiIndex - split));
      writeFileSync(filePath, text, "utf-8");
      expect(readFirstUserPrompt(filePath)).toBe(PROMPT);
    }
  });

  it("still reads a rollout whose last character is truncated mid-sequence", () => {
    // The tail case the decoder must not swallow: at EOF a dangling partial
    // sequence is flushed, exactly as decoding the whole file at once would.
    const text = rollout(padFor(CHUNK_BYTES - 8));
    // Cut two bytes into the astral character, past the boundary — so the last
    // chunk ends holding half a sequence with no next read to complete it.
    const cut = Buffer.byteLength(text.slice(0, text.indexOf("😀"))) + 2;
    expect(cut).toBeGreaterThan(CHUNK_BYTES);
    writeFileSync(filePath, Buffer.from(text, "utf-8").subarray(0, cut));
    expect(readFirstUserPrompt(filePath)).toBeNull(); // the torn line is skipped
    expect(readCodexSessionMeta(filePath)?.cwd).toBe("/p/x");
  });
});

describe("the chunked reader — a read that fails after the open succeeded", () => {
  it("answers 'nothing here' instead of throwing", () => {
    // A directory is the deterministic stand-in: openSync succeeds on Linux and
    // readSync throws EISDIR. The triggers that matter in production are EIO on
    // a failing disk and ESTALE/EIO on a network-mounted home — `~/.codex` on
    // NFS or sshfs is not exotic. The reader this replaced returned `[]` on a
    // read failure and its sibling `readHead` returns null; a throw here
    // escapes discovery entirely.
    expect(() => readFirstUserPrompt(dir)).not.toThrow();
    expect(readFirstUserPrompt(dir)).toBeNull();
    expect(() => readCodexSessionMeta(dir)).not.toThrow();
    expect(readCodexSessionMeta(dir)).toBeNull();
  });
});
