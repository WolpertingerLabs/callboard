/**
 * The lazy JSONL scanner, and the three things that make it a safe replacement
 * for slurping the file.
 *
 * It exists because the chat list reads 175 MB of transcript per request to
 * extract 82 preview strings that all live in the first few KB of their files.
 * Stopping at the hit is the point — but stopping early is only correct if the
 * scanner agrees with a whole-file read on everything it *does* return, and the
 * ways a chunked reader can silently disagree are specific:
 *
 *  - a line straddling a chunk boundary must not be split into two invalid ones;
 *  - a multi-byte character straddling a chunk boundary must not decode to
 *    U+FFFD on both sides. This is the nasty one: the corruption lands inside a
 *    JSON string, so the line still parses and the damage surfaces as mojibake
 *    in a sidebar preview rather than as an error;
 *  - a torn final line (a transcript being appended to as we read) must be
 *    skipped, not fatal.
 *
 * The chunk is 64 KB, so the fixtures here are built to put the interesting
 * bytes exactly on that boundary rather than hoping to land near it.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanJsonlLines } from "./jsonl-scan.js";

const CHUNK = 64 * 1024;
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-jsonl-scan-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let seq = 0;
function fixture(contents: string | Buffer): string {
  const path = join(tmpRoot, `f${seq++}.jsonl`);
  writeFileSync(path, contents);
  return path;
}

/** Pad a JSON line out with filler so the next line starts at `targetByte`. */
function padTo(targetByte: number, soFar: string): string {
  const filler = targetByte - Buffer.byteLength(soFar) - 1; // -1 for the newline
  return JSON.stringify({ type: "pad", filler: "x".repeat(Math.max(0, filler - 24)) });
}

describe("scanJsonlLines", () => {
  it("returns the first value visit produces and stops there", () => {
    const seen: string[] = [];
    const path = fixture([JSON.stringify({ id: "a" }), JSON.stringify({ id: "b" }), JSON.stringify({ id: "c" })].join("\n"));

    const hit = scanJsonlLines<string>(path, (line) => {
      seen.push(line.id);
      return line.id === "b" ? line.id : undefined;
    });

    expect(hit).toBe("b");
    expect(seen).toEqual(["a", "b"]);
  });

  it("treats undefined as keep-looking, so a structural match with nothing usable falls through", () => {
    const path = fixture([JSON.stringify({ type: "user", text: "" }), JSON.stringify({ type: "user", text: "real" })].join("\n"));

    const hit = scanJsonlLines<string>(path, (line) => (line.type === "user" && line.text ? line.text : undefined));

    expect(hit).toBe("real");
  });

  it("returns a falsy-but-defined hit rather than scanning past it", () => {
    // `""` is a hit. getFirstUserMessage depends on this: an empty user message
    // ends the scan there, exactly as the whole-file loop it replaced did.
    const path = fixture([JSON.stringify({ v: "" }), JSON.stringify({ v: "later" })].join("\n"));

    expect(scanJsonlLines<string>(path, (line) => line.v)).toBe("");
  });

  it("returns undefined when no line answers", () => {
    const path = fixture([JSON.stringify({ id: "a" }), JSON.stringify({ id: "b" })].join("\n"));
    expect(scanJsonlLines(path, () => undefined)).toBeUndefined();
  });

  it("returns undefined for a missing file rather than throwing", () => {
    expect(scanJsonlLines(join(tmpRoot, "does-not-exist.jsonl"), () => "hit")).toBeUndefined();
  });

  it("skips malformed lines and blank lines", () => {
    const path = fixture(["", "not json at all", "  ", JSON.stringify({ id: "good" })].join("\n"));
    expect(scanJsonlLines<string>(path, (line) => line.id)).toBe("good");
  });

  it("skips a torn final line", () => {
    // A transcript appended to while being read: the last line is half-written.
    const path = fixture([JSON.stringify({ id: "a" }), '{"id":"trunc'].join("\n"));
    expect(scanJsonlLines<string>(path, (line) => (line.id === "trunc" ? "reached" : undefined))).toBeUndefined();
  });

  it("reads a line that straddles a chunk boundary", () => {
    const head = padTo(CHUNK, "");
    // The target line starts ~40 bytes before the boundary and runs past it.
    const straddleStart = CHUNK - 40;
    const pad = padTo(straddleStart, "");
    const target = JSON.stringify({ id: "straddler", tail: "y".repeat(200) });
    const path = fixture([pad, target, head].join("\n"));

    expect(scanJsonlLines<string>(path, (line) => (line.id === "straddler" ? line.tail : undefined))).toBe("y".repeat(200));
  });

  it("does not corrupt a multi-byte character split across a chunk boundary", () => {
    // Build a line whose emoji lands with its 4 UTF-8 bytes spanning byte
    // 65536. Decoding each chunk independently would yield U+FFFD on both
    // sides — and because the damage is inside a JSON string, the line would
    // still parse and the mojibake would reach the UI.
    const emoji = "🙂"; // 4 bytes
    const prefix = '{"id":"mb","text":"';
    // Place the emoji so that 2 of its 4 bytes fall before the boundary.
    const before = CHUNK - Buffer.byteLength(prefix) - 2;
    const line = `${prefix}${"a".repeat(before)}${emoji}${"b".repeat(50)}"}`;
    const path = fixture(line);

    const text = scanJsonlLines<string>(path, (l) => (l.id === "mb" ? l.text : undefined));
    expect(text).toBeDefined();
    expect(text).toContain(emoji);
    expect(text).not.toContain("�");
    expect(text).toBe(`${"a".repeat(before)}${emoji}${"b".repeat(50)}`);
  });

  it("agrees with a whole-file read across many chunk boundaries", () => {
    // ~5 chunks of transcript with the answer at the very end, so the scan is
    // forced through every boundary before it can return.
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push(JSON.stringify({ i, blob: "ø".repeat(500) }));
    lines.push(JSON.stringify({ i: "final", blob: "done" }));
    const path = fixture(lines.join("\n"));

    const viaScan = scanJsonlLines<number>(path, (line) => (line.i === "final" ? line.blob : undefined));
    expect(viaScan).toBe("done");

    // And every line it walked past parses to what a slurping reader sees.
    const collected: unknown[] = [];
    scanJsonlLines(path, (line) => {
      collected.push(line);
      return undefined;
    });
    expect(collected).toEqual(lines.map((l) => JSON.parse(l)));
  });
});
