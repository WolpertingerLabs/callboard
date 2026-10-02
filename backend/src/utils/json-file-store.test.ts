/**
 * The auth-file store: atomic 0o600 writes, a stat-keyed cache, and a corrupt
 * file that is moved aside instead of throwing on every load.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonFileStore } from "./json-file-store.js";

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
});
