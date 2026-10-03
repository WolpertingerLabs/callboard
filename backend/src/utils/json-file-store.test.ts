/**
 * The auth-file store: atomic 0o600 writes, a stat-keyed cache, and a corrupt
 * file that is moved aside instead of throwing on every load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store's reads go through a spy so a test can play the external writer:
// "the read returned, then the file changed underneath it".
const storeRead = vi.hoisted(() => ({ after: null as (() => void) | null }));
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const result = actual.readFileSync(...args);
    storeRead.after?.();
    return result;
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const { createJsonFileStore } = await import("./json-file-store.js");

interface Doc {
  items: string[];
}

const empty = (): Doc => ({ items: [] });

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "callboard-json-store-"));
  file = join(dir, "store.json");
});

afterEach(() => {
  storeRead.after = null;
  rmSync(dir, { recursive: true, force: true });
});

describe("createJsonFileStore", () => {
  it("creates the file with the empty value on first load", () => {
    const store = createJsonFileStore(file, empty);
    expect(store.load()).toEqual({ items: [] });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ items: [] });
  });

  it.skipIf(process.platform === "win32")("writes owner-only (0o600), replacing a looser existing file", () => {
    writeFileSync(file, JSON.stringify({ items: ["old"] }), { mode: 0o644 });
    const store = createJsonFileStore(file, empty);
    store.save({ items: ["new"] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("leaves no tmp files behind after a save", () => {
    const store = createJsonFileStore(file, empty);
    store.save({ items: ["a"] });
    expect(readdirSync(dir)).toEqual(["store.json"]);
  });

  it("picks up an out-of-band edit", () => {
    const store = createJsonFileStore(file, empty);
    store.save({ items: ["a"] });
    expect(store.load()).toEqual({ items: ["a"] });
    // Different size → different cache key regardless of mtime resolution.
    writeFileSync(file, JSON.stringify({ items: ["a", "b"] }));
    expect(store.load()).toEqual({ items: ["a", "b"] });
  });

  it("moves a corrupt file aside and continues empty instead of throwing", () => {
    writeFileSync(file, '{"items": ["trunc');
    const store = createJsonFileStore(file, empty);

    expect(() => store.load()).not.toThrow();
    const asides = readdirSync(dir).filter((n) => n.startsWith("store.json.corrupt-"));
    expect(asides).toHaveLength(1);
    // The corrupt bytes are preserved for inspection, not destroyed.
    expect(readFileSync(join(dir, asides[0]), "utf8")).toBe('{"items": ["trunc');

    // Subsequent loads and saves work normally.
    expect(store.load()).toEqual({ items: [] });
    store.save({ items: ["fresh"] });
    expect(store.load()).toEqual({ items: ["fresh"] });
    expect(existsSync(join(dir, asides[0]))).toBe(true);
  });

  it("re-reads a file caught mid-write instead of moving it aside", () => {
    // An external writer rewriting in place: the first read sees half a file,
    // and the rest lands right after.
    writeFileSync(file, '{"items": ["a", ');
    storeRead.after = () => {
      storeRead.after = null;
      appendFileSync(file, '"b"]}');
    };
    const store = createJsonFileStore(file, empty);

    expect(store.load()).toEqual({ items: ["a", "b"] });
    expect(readdirSync(dir)).toEqual(["store.json"]);
    expect(readFileSync(file, "utf8")).toBe('{"items": ["a", "b"]}');
  });

  it("throws for this load, and leaves the file in place, when it is still being written after the last re-read", () => {
    writeFileSync(file, '{"items": ["a"');
    // A slow writer: every read finds the file longer than the last, never complete.
    storeRead.after = () => appendFileSync(file, ', "more"');
    const store = createJsonFileStore(file, empty);

    const started = Date.now();
    expect(() => store.load()).toThrow(SyntaxError);
    // Bounded: a few short waits, well under a second.
    expect(Date.now() - started).toBeLessThan(500);
    expect(readdirSync(dir)).toEqual(["store.json"]);

    // The writer finishes; the next load reads the whole file.
    storeRead.after = null;
    appendFileSync(file, "]}");
    expect(store.load().items[0]).toBe("a");
  });
});
