import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clampLines, cleanLine, readTail } from "./tail-reader.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bgtail-read-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (name: string, data: string | Buffer) => {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};

describe("readTail", () => {
  it("reads a small file whole", async () => {
    const p = write("a.log", "one\ntwo\nthree\n");
    const r = await readTail(p);
    expect(r).toMatchObject({ ok: true, lines: ["one", "two", "three"], truncated: false, binary: false, size: 14 });
  });

  it("keeps an unterminated last line", async () => {
    const r = await readTail(write("a.log", "one\ntwo"));
    expect(r).toMatchObject({ lines: ["one", "two"] });
  });

  it("reads only the end of a large file and drops the cut first line", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(20)}`);
    const p = write("big.log", lines.join("\n") + "\n");
    const r = await readTail(p, { lines: 500 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.truncated).toBe(true);
    expect(r.lines).toHaveLength(500);
    expect(r.lines[r.lines.length - 1]).toBe(lines[4999]);
    for (const l of r.lines) expect(l).toMatch(/^line \d+ x{20}$/);
  });

  it("drops the cut first line even when the window starts mid-character", async () => {
    // 64 KiB window; put a 3-byte character across its left edge.
    const tail = "\nafter\n";
    const total = 64 * 1024 + 10;
    const prefixLen = total - 64 * 1024 - 1; // window starts one byte into "€"
    const body = Buffer.concat([
      Buffer.from("a".repeat(prefixLen)),
      Buffer.from("€"),
      Buffer.from("b".repeat(total - prefixLen - 3 - tail.length)),
      Buffer.from(tail),
    ]);
    const r = await readTail(write("u.log", body), { maxBytes: 64 * 1024 });
    expect(r).toMatchObject({ ok: true, truncated: true, lines: ["after"] });
  });

  it("does not end on half a character the writer has not finished", async () => {
    const euro = Buffer.from("€");
    const r = await readTail(write("p.log", Buffer.concat([Buffer.from("ok\nprice "), euro.subarray(0, 2)])));
    expect(r).toMatchObject({ lines: ["ok", "price "] });
  });

  it("collapses progress redraws and strips ANSI", async () => {
    const r = await readTail(write("p.log", "10%\r50%\r100%\n\x1b[32mgreen\x1b[0m done\r\n\x1b]0;title\x07plain\n"));
    expect(r).toMatchObject({ lines: ["100%", "green done", "plain"] });
  });

  it("flags binary output and returns no lines", async () => {
    const r = await readTail(write("b.bin", Buffer.alloc(1000, 0)));
    expect(r).toMatchObject({ ok: true, binary: true, lines: [] });
  });

  it("returns not_regular for a FIFO without blocking", async () => {
    const p = join(dir, "fifo");
    execFileSync("mkfifo", [p]);
    const r = await readTail(p);
    expect(r).toEqual({ ok: false, error: "not_regular" });
  });

  it("returns missing for an absent file", async () => {
    expect(await readTail(join(dir, "nope"))).toEqual({ ok: false, error: "missing" });
  });

  it("refuses a symlink when noFollow is set, and follows it otherwise", async () => {
    const target = write("t.log", "x\n");
    const link = join(dir, "l.log");
    symlinkSync(target, link);
    expect(await readTail(link, { noFollow: true })).toEqual({ ok: false, error: "refused" });
    expect(await readTail(link)).toMatchObject({ ok: true, lines: ["x"] });
  });

  it("refuses a file whose inode changed since it was checked", async () => {
    const p = write("i.log", "x\n");
    const ino = statSync(p).ino;
    expect(await readTail(p, { expectIno: ino })).toMatchObject({ ok: true });
    expect(await readTail(p, { expectIno: ino + 1 })).toEqual({ ok: false, error: "changed" });
  });

  it("honours the lines limit", async () => {
    const r = await readTail(write("n.log", "a\nb\nc\nd\n"), { lines: 2 });
    expect(r).toMatchObject({ lines: ["c", "d"], truncated: true });
  });
});

describe("clampLines", () => {
  it.each([
    [undefined, 200],
    ["", 200],
    ["abc", 200],
    ["0", 1],
    ["-5", 1],
    ["50", 50],
    ["10000", 500],
    [12.7, 12],
  ])("%s → %s", (input, want) => {
    expect(clampLines(input)).toBe(want);
  });
});

describe("cleanLine", () => {
  it("handles CRLF", () => {
    expect(cleanLine("abc\r")).toBe("abc");
  });
});
