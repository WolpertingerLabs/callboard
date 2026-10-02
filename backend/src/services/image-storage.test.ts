/**
 * storeBase64Image's sha256 dedup: never hands back the id of a deleted file,
 * and builds its hash index once instead of re-reading the whole images
 * directory on every miss.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-image-storage-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

// The service imports from "fs"; count its reads so a full rescan shows up.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const fs = await import("fs");
const { ImageStorageService, storeBase64Image } = await import("./image-storage.js");

const imagesDir = join(tmpRoot, "images");
const b64 = (s: string) => Buffer.from(s).toString("base64");
const fileFor = (id: string) => readdirSync(imagesDir).find((f) => f.startsWith(id));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("storeBase64Image", () => {
  it("dedups identical bytes to one id", () => {
    const a = storeBase64Image(b64("same-bytes"), "image/png");
    expect(a).toBeTruthy();
    expect(storeBase64Image(b64("same-bytes"), "image/png")).toBe(a);
  });

  it("does not return the id of an image deleted through the API", () => {
    const first = storeBase64Image(b64("deleted-later"), "image/png")!;
    expect(ImageStorageService.deleteImage(first)).toBe(true);

    const second = storeBase64Image(b64("deleted-later"), "image/png")!;
    expect(second).not.toBe(first);
    expect(fileFor(second)).toBeDefined();
  });

  it("does not return the id of an image removed from disk behind its back", () => {
    const first = storeBase64Image(b64("unlinked-externally"), "image/png")!;
    unlinkSync(join(imagesDir, fileFor(first)!));

    const second = storeBase64Image(b64("unlinked-externally"), "image/png")!;
    expect(second).not.toBe(first);
    expect(existsSync(join(imagesDir, fileFor(second)!))).toBe(true);
  });

  it("finds an upload stored after the index was built", async () => {
    const upload = (await ImageStorageService.storeImage(Buffer.from("uploaded-then-parsed"), "x.png", "image/png")).image!.id;
    expect(storeBase64Image(b64("uploaded-then-parsed"), "image/png")).toBe(upload);
  });

  it("falls back to another file with the same bytes when the indexed one is deleted", async () => {
    const one = (await ImageStorageService.storeImage(Buffer.from("twice-uploaded"), "a.png", "image/png")).image!.id;
    const two = (await ImageStorageService.storeImage(Buffer.from("twice-uploaded"), "b.png", "image/png")).image!.id;
    expect(storeBase64Image(b64("twice-uploaded"), "image/png")).toBe(one);

    ImageStorageService.deleteImage(one);
    expect(storeBase64Image(b64("twice-uploaded"), "image/png")).toBe(two);
  });

  it("does not re-read the images directory on a miss once the index exists", () => {
    storeBase64Image(b64("warm-the-index"), "image/png");
    vi.mocked(fs.readFileSync).mockClear();

    expect(storeBase64Image(b64("a-brand-new-image"), "image/png")).toBeTruthy();
    expect(vi.mocked(fs.readFileSync)).not.toHaveBeenCalled();
  });
});
