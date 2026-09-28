/**
 * Storage saves under injected filesystem failures.
 *
 * meta.json is the commit point: a failure at any step before it is replaced
 * must leave the previous committed state — meta AND bytes — exactly as it
 * was, and a failure after it must leave only an unreferenced file that the
 * key's next mutation sweeps. `fs` is wrapped so any call can be made to fail
 * on a chosen path; this does not depend on file permissions, so it has teeth
 * when the suite runs as root too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { StorageKeyMetaFile } from "shared/types/index.js";

type Fault = (op: string, target: string) => void;
const faults: { current: Fault | null } = vi.hoisted(() => ({ current: null }));

vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  const wrap =
    <A extends unknown[], R>(op: string, fn: (...a: A) => R) =>
    (...args: A): R => {
      faults.current?.(op, String(args[0]));
      return fn(...args);
    };
  const wrapped = {
    ...real,
    writeFileSync: wrap("writeFileSync", real.writeFileSync),
    renameSync: wrap("renameSync", real.renameSync),
    rmSync: wrap("rmSync", real.rmSync),
    unlinkSync: wrap("unlinkSync", real.unlinkSync),
  };
  return { ...wrapped, default: wrapped };
});

const DATA = mkdtempSync(join(tmpdir(), "callboard-storage-fail-"));
process.env.CALLBOARD_DATA_DIR = DATA;

const svc = await import("./storage-service.js");
const { STORAGE_ROOT } = svc;

const items = () => readdirSync(join(STORAGE_ROOT, "k", "items")).sort();
const metaText = () => readFileSync(join(STORAGE_ROOT, "k", "meta.json"), "utf-8");
const meta = () => JSON.parse(metaText()) as StorageKeyMetaFile;

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: injected`), { code });
}

/** Fail the first `op` whose target satisfies `match`. */
function failOnce(op: string, match: (target: string) => boolean, code = "EACCES"): void {
  faults.current = (o, t) => {
    if (o === op && match(t)) {
      faults.current = null;
      throw errno(code);
    }
  };
}

const isMetaCommit = (t: string) => basename(t).startsWith(".meta.json.");
const isBlob = (name: string) => (t: string) => basename(t).startsWith(`${name}~`);

beforeEach(async () => {
  faults.current = null;
  rmSync(STORAGE_ROOT, { recursive: true, force: true });
  await svc.createStorageKey("k");
  await svc.saveStorageItem("k", "a.txt", Buffer.from("original bytes"));
});

afterEach(() => {
  faults.current = null;
});

describe("a failed overwrite leaves the previous item intact", () => {
  it("meta write fails (EACCES, as the review measured): old bytes, old meta, no new file", async () => {
    const before = { meta: metaText(), files: items() };
    failOnce("writeFileSync", isMetaCommit);
    await expect(svc.saveStorageItem("k", "a.txt", Buffer.from("NEW CONTENT, much longer than before"))).rejects.toThrow(/EACCES/);
    expect(metaText()).toBe(before.meta);
    expect(items()).toEqual(before.files);
    expect(svc.readStorageItemBytes("k", "a.txt").data.toString()).toBe("original bytes");
    expect(svc.getStorageItem("k", "a.txt")).toMatchObject({ size: 14 });
  });

  it("meta rename fails: same", async () => {
    const before = { meta: metaText(), files: items() };
    failOnce("renameSync", (t) => basename(t).startsWith(".meta.json"), "ENOSPC");
    await expect(svc.saveStorageItem("k", "a.txt", Buffer.from("new"))).rejects.toThrow(/ENOSPC/);
    expect(metaText()).toBe(before.meta);
    expect(items()).toEqual(before.files);
    expect(svc.readStorageItemBytes("k", "a.txt").data.toString()).toBe("original bytes");
  });

  it("the blob write itself fails: same", async () => {
    const before = { meta: metaText(), files: items() };
    failOnce("writeFileSync", isBlob("a.txt"), "ENOSPC");
    await expect(svc.saveStorageItem("k", "a.txt", Buffer.from("new"))).rejects.toThrow(/ENOSPC/);
    expect(metaText()).toBe(before.meta);
    expect(items()).toEqual(before.files);
    expect(svc.readStorageItemBytes("k", "a.txt").data.toString()).toBe("original bytes");
  });
});

describe("a failed new-item save leaves nothing behind", () => {
  it("meta write fails: item absent, no stray bytes, totals unchanged", async () => {
    const total = svc.storeTotalBytes();
    const files = items();
    failOnce("writeFileSync", isMetaCommit);
    await expect(svc.saveStorageItem("k", "new.txt", Buffer.from("x".repeat(500)))).rejects.toThrow(/EACCES/);
    expect(svc.listStorageItems("k").map((i) => i.name)).toEqual(["a.txt"]);
    expect(items()).toEqual(files);
    expect(svc.storeTotalBytes()).toBe(total);
  });
});

describe("crash-shaped leftovers are swept by the next mutation", () => {
  it("meta commit fails AND the cleanup of the new file fails (≈ a crash): the stray is swept next save", async () => {
    faults.current = (op, t) => {
      if (op === "writeFileSync" && isMetaCommit(t)) throw errno("EIO");
      if (op === "rmSync" && isBlob("a.txt")(t)) throw errno("EIO");
    };
    await expect(svc.saveStorageItem("k", "a.txt", Buffer.from("never committed"))).rejects.toThrow(/EIO/);
    faults.current = null;
    expect(items()).toHaveLength(2); // the committed blob + the orphan
    expect(svc.readStorageItemBytes("k", "a.txt").data.toString()).toBe("original bytes");
    await svc.saveStorageItem("k", "b.txt", Buffer.from("b"));
    expect(items()).toEqual([meta().items["a.txt"].file, meta().items["b.txt"].file].sort());
  });

  it("committed, but removing the previous blob fails: the save succeeds and the old blob is swept next time", async () => {
    const oldBlob = meta().items["a.txt"].file!;
    failOnce("rmSync", (t) => basename(t) === oldBlob, "EBUSY");
    await svc.saveStorageItem("k", "a.txt", Buffer.from("updated"));
    expect(svc.readStorageItemBytes("k", "a.txt").data.toString()).toBe("updated");
    expect(items()).toContain(oldBlob);
    await svc.saveStorageItem("k", "b.txt", Buffer.from("b"));
    expect(items()).not.toContain(oldBlob);
    expect(items()).toHaveLength(2);
  });
});
