/**
 * Storage service: the one chokepoint for key/item validation, containment,
 * atomic writes and limits.
 *
 * Limits are checked against the sizes *recorded in meta.json*, so the key and
 * store ceilings (250MB / 2GB) are exercised by seeding meta with large
 * recorded sizes rather than by writing gigabytes.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StorageKeyMetaFile } from "shared/types/index.js";
import { TRAVERSAL_MATRIX } from "./__fixtures__/storage-traversal-matrix.js";

const DATA = mkdtempSync(join(tmpdir(), "callboard-storage-svc-"));
process.env.CALLBOARD_DATA_DIR = DATA;

const svc = await import("./storage-service.js");
const { STORAGE_ROOT, STORAGE_MAX_ITEM_BYTES, STORAGE_MAX_KEY_BYTES, STORAGE_MAX_STORE_BYTES, STORAGE_MAX_ITEMS_PER_KEY, StorageError } = svc;

async function expectCode(p: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    expect(err).toBeInstanceOf(StorageError);
    expect((err as InstanceType<typeof StorageError>).code).toBe(code);
    return err as Error;
  }
  throw new Error(`expected StorageError(${code}), got success`);
}

function seedMeta(key: string, items: StorageKeyMetaFile["items"]) {
  const meta: StorageKeyMetaFile = { version: 1, key, created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z", items };
  mkdirSync(join(STORAGE_ROOT, key, "items"), { recursive: true });
  writeFileSync(join(STORAGE_ROOT, key, "meta.json"), JSON.stringify(meta));
}

const fake = (size: number) => ({ mimeType: "application/octet-stream", size, sha256: "0", created: "x", updated: "x" });

beforeEach(() => rmSync(STORAGE_ROOT, { recursive: true, force: true }));
afterEach(() => rmSync(STORAGE_ROOT, { recursive: true, force: true }));

describe("validation", () => {
  it("accepts well-formed keys and names", () => {
    for (const key of ["a", "cramhouse-birds", "v1.2_x", "0", "a".repeat(64)]) expect(svc.isValidStorageKey(key), key).toBe(true);
    for (const name of ["deck.json", "img-card-12.jpg", "A_b.C-d", "x".repeat(128), "meta.json"]) expect(svc.isValidItemName(name), name).toBe(true);
  });

  it("rejects the whole traversal matrix, for keys and for item names", () => {
    for (const bad of [...TRAVERSAL_MATRIX, "UPPER", "a".repeat(65)]) {
      expect(svc.isValidStorageKey(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const bad of TRAVERSAL_MATRIX) {
      expect(svc.isValidItemName(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(svc.isValidItemName("x".repeat(129))).toBe(false);
    for (const nonString of [undefined, null, 1, {}, ["a"]]) {
      expect(svc.isValidStorageKey(nonString)).toBe(false);
      expect(svc.isValidItemName(nonString)).toBe(false);
    }
  });

  it("validates in the service itself — every entry point, not just routes", async () => {
    await svc.createStorageKey("k");
    for (const bad of TRAVERSAL_MATRIX) {
      await expectCode(() => svc.createStorageKey(bad), "invalid");
      await expectCode(() => svc.getStorageKey(bad), "invalid");
      await expectCode(svc.saveStorageItem("k", bad, Buffer.from("x")), "invalid");
      await expectCode(svc.saveStorageItem(bad, "ok.txt", Buffer.from("x"), { createKey: true }), "invalid");
      await expectCode(() => svc.getStorageItem("k", bad), "invalid");
      await expectCode(svc.deleteStorageItem("k", bad), "invalid");
      await expectCode(svc.deleteStorageKey(bad), "invalid");
    }
    // Nothing escaped: the store holds exactly the one key, and nothing appeared next to it.
    expect(readdirSync(STORAGE_ROOT)).toEqual(["k"]);
    expect(readdirSync(join(STORAGE_ROOT, "k", "items"))).toEqual([]);
    expect(readdirSync(DATA).filter((f) => !["storage", "artifacts"].includes(f))).toEqual([]);
  });

  it("refuses a key directory that is a symlink out of the store", async () => {
    const outside = mkdtempSync(join(tmpdir(), "callboard-outside-"));
    mkdirSync(join(outside, "items"));
    writeFileSync(join(outside, "meta.json"), JSON.stringify({ version: 1, key: "evil", created: "", updated: "", items: {} }));
    mkdirSync(STORAGE_ROOT, { recursive: true });
    symlinkSync(outside, join(STORAGE_ROOT, "evil"));
    await expectCode(svc.saveStorageItem("evil", "x.txt", Buffer.from("pwned")), "invalid");
    await expectCode(() => svc.getStorageKey("evil"), "invalid");
    expect(existsSync(join(outside, "items", "x.txt"))).toBe(false);
    expect(svc.listStorageKeys()).toEqual([]);
  });

  it("refuses an item that is a symlink", async () => {
    await svc.createStorageKey("k");
    const outside = join(mkdtempSync(join(tmpdir(), "callboard-outside-")), "secret.txt");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(STORAGE_ROOT, "k", "items", "link.txt"));
    await expectCode(() => svc.itemFilePath("k", "link.txt"), "invalid");
  });
});

describe("keys and items", () => {
  it("creates, lists, updates and deletes keys; duplicate create is a conflict", async () => {
    const created = await svc.createStorageKey("deck", "Birds");
    expect(created).toMatchObject({ key: "deck", description: "Birds", itemCount: 0, totalSize: 0, items: [] });
    await expectCode(svc.createStorageKey("deck"), "conflict");
    await svc.updateStorageKey("deck", { description: "Birds of Europe" });
    expect(svc.listStorageKeys()).toEqual([expect.objectContaining({ key: "deck", description: "Birds of Europe" })]);
    await svc.updateStorageKey("deck", { description: "" });
    expect(svc.getStorageKey("deck").description).toBeUndefined();
    await svc.deleteStorageKey("deck");
    expect(svc.listStorageKeys()).toEqual([]);
    await expectCode(svc.deleteStorageKey("deck"), "not_found");
  });

  it("saves, overwrites, reads and deletes items with sha256, size and MIME", async () => {
    await svc.createStorageKey("k");
    const first = await svc.saveStorageItem("k", "deck.json", Buffer.from('{"a":1}'));
    expect(first).toMatchObject({ name: "deck.json", mimeType: "application/json", size: 7 });
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    const second = await svc.saveStorageItem("k", "deck.json", Buffer.from('{"a":22}'), { mimeType: "Text/Plain; charset=utf-8" });
    expect(second).toMatchObject({ mimeType: "text/plain", size: 8, created: first.created });
    expect(svc.readStorageItemBytes("k", "deck.json").data.toString()).toBe('{"a":22}');
    expect(svc.getStorageKey("k")).toMatchObject({ itemCount: 1, totalSize: 8 });
    expect((await svc.saveStorageItem("k", "blob", Buffer.from([0]))).mimeType).toBe("application/octet-stream");
    await expectCode(svc.saveStorageItem("k", "x", Buffer.from(""), { mimeType: "text/html\r\nX-Evil: 1" }), "invalid");
    await svc.deleteStorageItem("k", "deck.json");
    await expectCode(() => svc.getStorageItem("k", "deck.json"), "not_found");
    await expectCode(svc.deleteStorageItem("k", "deck.json"), "not_found");
  });

  it("needs the key to exist unless createKey is set", async () => {
    await expectCode(svc.saveStorageItem("nokey", "a.txt", Buffer.from("x")), "not_found");
    await svc.saveStorageItem("nokey", "a.txt", Buffer.from("x"), { createKey: true });
    expect(svc.getStorageKey("nokey").itemCount).toBe(1);
  });

  it("does not treat inherited object keys as items", async () => {
    await svc.createStorageKey("k");
    await expectCode(() => svc.getStorageItem("k", "constructor"), "not_found");
    await expectCode(svc.deleteStorageItem("k", "toString"), "not_found");
  });

  it("writes atomically and leaves no tmp files behind", async () => {
    await svc.createStorageKey("k");
    await svc.saveStorageItem("k", "a.txt", Buffer.from("hello"));
    expect(readdirSync(join(STORAGE_ROOT, "k", "items"))).toEqual(["a.txt"]);
    expect(readdirSync(join(STORAGE_ROOT, "k")).sort()).toEqual(["items", "meta.json"]);
  });

  it("serializes concurrent saves to one key so no meta entry is lost", async () => {
    await svc.createStorageKey("k");
    const names = Array.from({ length: 40 }, (_, i) => `item-${i}.txt`);
    await Promise.all(names.map((n) => svc.saveStorageItem("k", n, Buffer.from(n))));
    const meta = JSON.parse(readFileSync(join(STORAGE_ROOT, "k", "meta.json"), "utf-8")) as StorageKeyMetaFile;
    expect(Object.keys(meta.items).sort()).toEqual([...names].sort());
    expect(svc.getStorageKey("k").itemCount).toBe(40);
  });

  it("a failing save in the chain does not wedge the saves queued behind it", async () => {
    await svc.createStorageKey("k");
    const results = await Promise.allSettled([
      svc.saveStorageItem("k", "a.txt", Buffer.from("a")),
      svc.saveStorageItem("k", "b.txt", Buffer.alloc(STORAGE_MAX_ITEM_BYTES + 1)),
      svc.saveStorageItem("k", "c.txt", Buffer.from("c")),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(svc.listStorageItems("k").map((i) => i.name)).toEqual(["a.txt", "c.txt"]);
  });
});

describe("limits (checked before any bytes are written)", () => {
  it("exports the documented values", () => {
    expect(STORAGE_MAX_ITEM_BYTES).toBe(25 * 1024 * 1024);
    expect(STORAGE_MAX_KEY_BYTES).toBe(250 * 1024 * 1024);
    expect(STORAGE_MAX_STORE_BYTES).toBe(2 * 1024 * 1024 * 1024);
    expect(STORAGE_MAX_ITEMS_PER_KEY).toBe(5000);
  });

  it("per item: 25MB is allowed, one byte more is refused", async () => {
    await svc.createStorageKey("k");
    const err = await expectCode(svc.saveStorageItem("k", "big.bin", Buffer.alloc(STORAGE_MAX_ITEM_BYTES + 1)), "limit");
    expect(err.message).toMatch(/per-item limit/);
    expect(readdirSync(join(STORAGE_ROOT, "k", "items"))).toEqual([]);
    await svc.saveStorageItem("k", "max.bin", Buffer.alloc(STORAGE_MAX_ITEM_BYTES));
  });

  it("per key: total bytes", async () => {
    seedMeta("k", { "old.bin": fake(STORAGE_MAX_KEY_BYTES - 10) });
    const err = await expectCode(svc.saveStorageItem("k", "new.bin", Buffer.alloc(11)), "limit");
    expect(err.message).toMatch(/per-key limit/);
    expect(existsSync(join(STORAGE_ROOT, "k", "items", "new.bin"))).toBe(false);
    await svc.saveStorageItem("k", "new.bin", Buffer.alloc(10));
    // Overwriting an item counts only the difference: the key is exactly full,
    // and replacing a 10-byte item with another 10 bytes still fits.
    seedMeta("k", { "old.bin": fake(STORAGE_MAX_KEY_BYTES - 10), "same.bin": fake(10) });
    await svc.saveStorageItem("k", "same.bin", Buffer.alloc(10));
    await expectCode(svc.saveStorageItem("k", "same.bin", Buffer.alloc(11)), "limit");
  });

  it("whole store: total bytes across keys", async () => {
    seedMeta("a", { "x.bin": fake(STORAGE_MAX_KEY_BYTES) });
    for (const k of ["b", "c", "d", "e", "f", "g"]) seedMeta(k, { "x.bin": fake(STORAGE_MAX_KEY_BYTES) });
    seedMeta("h", { "x.bin": fake(STORAGE_MAX_STORE_BYTES - 7 * STORAGE_MAX_KEY_BYTES - 5) });
    await svc.createStorageKey("z");
    const err = await expectCode(svc.saveStorageItem("z", "one.bin", Buffer.alloc(6)), "limit");
    expect(err.message).toMatch(/whole-store limit/);
    expect(existsSync(join(STORAGE_ROOT, "z", "items", "one.bin"))).toBe(false);
    await svc.saveStorageItem("z", "one.bin", Buffer.alloc(5));
  });

  it("items per key: 5000", async () => {
    const items: StorageKeyMetaFile["items"] = {};
    for (let i = 0; i < STORAGE_MAX_ITEMS_PER_KEY; i++) items[`i${i}`] = fake(1);
    seedMeta("k", items);
    const err = await expectCode(svc.saveStorageItem("k", "one-more", Buffer.from("x")), "limit");
    expect(err.message).toMatch(/item limit/);
    // Overwriting an existing item does not add one.
    writeFileSync(join(STORAGE_ROOT, "k", "items", "i0"), "x");
    await svc.saveStorageItem("k", "i0", Buffer.from("y"));
  });
});

describe("source_path (render_file's checks)", () => {
  it("requires an absolute, NUL-free path to an existing regular file within the limit", async () => {
    await svc.createStorageKey("k");
    const dir = mkdtempSync(join(tmpdir(), "callboard-src-"));
    const file = join(dir, "photo.png");
    writeFileSync(file, Buffer.from([0x89, 0x50]));
    await expectCode(svc.saveStorageItemFromFile("k", "a.png", "relative/photo.png"), "invalid");
    await expectCode(svc.saveStorageItemFromFile("k", "a.png", file + "\0.txt"), "invalid");
    await expectCode(svc.saveStorageItemFromFile("k", "a.png", join(dir, "missing.png")), "not_found");
    await expectCode(svc.saveStorageItemFromFile("k", "a.png", dir), "invalid");
    const link = join(dir, "link");
    symlinkSync(file, link);
    // A symlink is realpath'd, and the MIME falls back to the source's extension.
    expect(await svc.saveStorageItemFromFile("k", "copied", link)).toMatchObject({ size: 2, mimeType: "image/png" });
  });
});
