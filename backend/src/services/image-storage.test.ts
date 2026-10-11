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

describe("file attachments", () => {
  it("stores a non-image under its name and loads it back as a named attachment", async () => {
    const result = await ImageStorageService.storeImage(Buffer.from("a,b\n1,2\n"), "my report (v2).csv", "text/csv");
    expect(result.success).toBe(true);
    const id = result.image!.id;
    expect(fileFor(id)).toBe(`${id}_my_report_v2_.csv`);

    const [loaded] = ImageStorageService.loadImageBuffers([id]);
    expect(loaded).toMatchObject({ id, name: "my_report_v2_.csv", mimeType: "text/csv", storagePath: join(imagesDir, `${id}_my_report_v2_.csv`) });
    expect(ImageStorageService.getImage(id)!.image.originalName).toBe("my_report_v2_.csv");
  });

  it("never reads a file attachment back as an image, whatever its extension", async () => {
    const result = await ImageStorageService.storeImage(Buffer.from("not really"), "fake.png", "application/octet-stream");
    const [loaded] = ImageStorageService.loadImageBuffers([result.image!.id]);
    expect(loaded.name).toBe("fake.png");
    expect(loaded.mimeType).toBe("application/octet-stream");
  });

  it("keeps images as they were: no name, image type", async () => {
    const result = await ImageStorageService.storeImage(Buffer.from("png-bytes"), "shot.png", "image/png");
    const [loaded] = ImageStorageService.loadImageBuffers([result.image!.id]);
    expect(loaded.name).toBeUndefined();
    expect(loaded.mimeType).toBe("image/png");
  });

  it("holds images to 10MB but other files to 25MB", async () => {
    const elevenMb = Buffer.alloc(11 * 1024 * 1024);
    expect((await ImageStorageService.storeImage(elevenMb, "big.png", "image/png")).success).toBe(false);
    expect((await ImageStorageService.storeImage(elevenMb, "big.bin", "application/octet-stream")).success).toBe(true);
    expect((await ImageStorageService.storeImage(Buffer.alloc(26 * 1024 * 1024), "huge.bin", "application/octet-stream")).success).toBe(false);
  });

  it("does not dedup a base64 image onto a file attachment with the same bytes", async () => {
    const file = await ImageStorageService.storeImage(Buffer.from("shared-bytes"), "same.txt", "text/plain");
    const imageId = storeBase64Image(b64("shared-bytes"), "image/png");
    expect(imageId).not.toBe(file.image!.id);
    expect(fileFor(imageId!)).toBe(`${imageId}.png`);
  });
});
