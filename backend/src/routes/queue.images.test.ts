/**
 * Route-level tests for the images a draft carries.
 *
 * Saving a draft used to drop its attachments outright: the composer handed
 * them over and nothing stored them. A draft now records the ids the regular
 * upload route (`POST /api/images/upload`) returned, and these tests pin the
 * storage half of that:
 *
 *  - `images` round-trips through create and read;
 *  - an update that sends `images` replaces them, and one that does not keeps
 *    them — an older tab only ever sends `user_message`, and re-saving a draft
 *    there must not strip what it cannot see;
 *  - a draft file written before drafts had images still lists and loads;
 *  - a draft only references its images: dropping them, deleting the draft or
 *    sending it never deletes an image file. Each automatic deletion the
 *    first version of this had was a way to lose a user's image for good —
 *    the dedup test below is one; queue.traversal.wire.test.ts and
 *    Chat.draftImages.test.tsx have the others;
 *  - `POST /:id/execute-now` sends the draft's images with it, and refuses
 *    (keeping the draft) when one of them is gone.
 *
 * Same no-supertest style as chats.set-title.test.ts: handlers are pulled off
 * the router stack and driven with a fake req/res. Storage is real, under a
 * scratch CALLBOARD_DATA_DIR.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

const DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-queue-images-"));
process.env.CALLBOARD_DATA_DIR = DATA_DIR;

vi.mock("../services/claude.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../services/image-metadata.js", () => ({ storeMessageImages: vi.fn(async () => {}) }));

const { queueRouter } = await import("./queue.js");
const { ImageStorageService, storeBase64Image } = await import("../services/image-storage.js");
const { sendMessage } = await import("../services/claude.js");
const { storeMessageImages } = await import("../services/image-metadata.js");

type Method = "get" | "post" | "put" | "delete";

function call(method: Method, path: string, req: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> }): Promise<{ code: number; body: any }> {
  const layer = (queueRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle as (req: Request, res: Response) => void;
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    handler({ params: {}, query: {}, body: {}, ...req } as unknown as Request, res as unknown as Response);
  });
}

async function storeImage(name: string): Promise<string> {
  const result = await ImageStorageService.storeImage(Buffer.from(`png-bytes-${name}`), name, "image/png");
  return result.image!.id;
}

const exists = (id: string) => ImageStorageService.getImage(id) !== null;

describe("draft images", () => {
  it("stores the images a draft is saved with and returns them on read", async () => {
    const id = await storeImage("shot.png");

    const created = await call("post", "/", { body: { chat_id: "chat-1", user_message: "look at this", images: [{ id, originalName: "shot.png" }] } });
    expect(created.code).toBe(201);
    expect(created.body.images).toEqual([{ id, originalName: "shot.png" }]);

    const read = await call("get", "/:id", { params: { id: created.body.id } });
    expect(read.body.images).toEqual([{ id, originalName: "shot.png" }]);

    const listed = await call("get", "/", { query: { chat_id: "chat-1" } });
    expect(listed.body.find((d: any) => d.id === created.body.id).images).toEqual([{ id, originalName: "shot.png" }]);
  });

  it("omits images entirely on a draft saved without any", async () => {
    const created = await call("post", "/", { body: { chat_id: "chat-1", user_message: "text only" } });
    expect(created.code).toBe(201);
    expect("images" in created.body).toBe(false);
  });

  it("rejects an images list that is not ids from the upload route", async () => {
    for (const images of ["nope", [{ originalName: "x.png" }], [{ id: "../../etc/passwd", originalName: "x.png" }]]) {
      const res = await call("post", "/", { body: { chat_id: "chat-1", user_message: "m", images } });
      expect(res.code).toBe(400);
    }
  });

  it("keeps only the last path segment of an originalName, capped", async () => {
    const id = await storeImage("named.png");
    const res = await call("post", "/", {
      body: {
        chat_id: "chat-1",
        user_message: "m",
        images: [
          { id, originalName: "../../../evil.sh" },
          { id, originalName: "x".repeat(1000) },
          { id, originalName: 7 },
        ],
      },
    });
    expect(res.code).toBe(201);
    expect(res.body.images.map((i: any) => i.originalName)).toEqual(["evil.sh", "x".repeat(255), id]);
  });

  it("still loads a draft file written before drafts had images", async () => {
    const legacyId = "11111111-2222-4333-8444-555555555555";
    writeFileSync(
      join(DATA_DIR, "queue", `${legacyId}.json`),
      JSON.stringify({ id: legacyId, chat_id: "chat-legacy", user_message: "old draft", status: "draft", created_at: "2026-03-01T00:00:00.000Z" }),
    );

    const read = await call("get", "/:id", { params: { id: legacyId } });
    expect(read.body).toMatchObject({ id: legacyId, user_message: "old draft" });
    expect(read.body.images).toBeUndefined();

    const listed = await call("get", "/", { query: { chat_id: "chat-legacy" } });
    expect(listed.body.map((d: any) => d.id)).toEqual([legacyId]);
  });

  it("keeps a draft's images when an update does not mention them (an older tab)", async () => {
    const id = await storeImage("keep.png");
    const created = await call("post", "/", { body: { chat_id: "chat-1", user_message: "v1", images: [{ id, originalName: "keep.png" }] } });

    const updated = await call("put", "/:id", { params: { id: created.body.id }, body: { user_message: "v2" } });
    expect(updated.body).toMatchObject({ user_message: "v2", images: [{ id, originalName: "keep.png" }] });
    expect(exists(id)).toBe(true);
  });

  it("replaces a draft's images on an update that sends them, leaving the dropped files in place", async () => {
    const kept = await storeImage("kept.png");
    const dropped = await storeImage("dropped.png");
    const added = await storeImage("added.png");
    const created = await call("post", "/", {
      body: {
        chat_id: "chat-1",
        user_message: "v1",
        images: [
          { id: kept, originalName: "kept.png" },
          { id: dropped, originalName: "dropped.png" },
        ],
      },
    });

    const updated = await call("put", "/:id", {
      params: { id: created.body.id },
      body: {
        user_message: "v2",
        images: [
          { id: kept, originalName: "kept.png" },
          { id: added, originalName: "added.png" },
        ],
      },
    });
    expect(updated.body.images).toEqual([
      { id: kept, originalName: "kept.png" },
      { id: added, originalName: "added.png" },
    ]);
    // A re-save that raced the composer's restore would arrive looking exactly
    // like this; the files it "dropped" must survive it.
    expect([exists(kept), exists(dropped), exists(added)]).toEqual([true, true, true]);

    // An empty list is "no images now", not "unchanged".
    const cleared = await call("put", "/:id", { params: { id: created.body.id }, body: { user_message: "v3", images: [] } });
    expect("images" in cleared.body).toBe(false);
    expect([exists(kept), exists(added)]).toEqual([true, true]);
  });

  it("leaves the image files in place when the draft is deleted", async () => {
    const id = await storeImage("stays.png");
    const created = await call("post", "/", { body: { chat_id: "chat-1", user_message: "m", images: [{ id, originalName: "stays.png" }] } });

    const deleted = await call("delete", "/:id", { params: { id: created.body.id } });
    expect(deleted.body).toEqual({ ok: true });
    expect(exists(id)).toBe(true);
  });

  it("does not break chat history that dedup pointed at a draft's image file", async () => {
    // `storeBase64Image` (the session parsers' path for a sent image) returns
    // any file on disk with the same bytes and caches that id. With the
    // draft's copy the only one, history resolves to the draft's file.
    const bytes = Buffer.from("screenshot-sent-and-drafted");
    const draftCopy = (await ImageStorageService.storeImage(bytes, "dup.png", "image/png")).image!.id;
    const created = await call("post", "/", { body: { chat_id: "chat-1", user_message: "m", images: [{ id: draftCopy, originalName: "dup.png" }] } });

    const historyId = storeBase64Image(bytes.toString("base64"), "image/png");
    expect(historyId).toBe(draftCopy);

    await call("delete", "/:id", { params: { id: created.body.id } });
    // The cached id is what the next parse hands the chat view.
    expect(storeBase64Image(bytes.toString("base64"), "image/png")).toBe(historyId);
    expect(exists(historyId!)).toBe(true);
  });
});

describe("POST /:id/execute-now", () => {
  it("sends the draft's images with it", async () => {
    vi.mocked(sendMessage).mockResolvedValueOnce(new EventEmitter() as any);
    const id = await storeImage("exec.png");
    const created = await call("post", "/", { body: { chat_id: "chat-1", user_message: "m", images: [{ id, originalName: "exec.png" }] } });

    const res = await call("post", "/:id/execute-now", { params: { id: created.body.id } });
    expect(res.code).toBe(200);
    const opts = vi.mocked(sendMessage).mock.calls.at(-1)![0];
    expect(opts).toMatchObject({ chatId: "chat-1", prompt: "m" });
    expect(opts.imageMetadata).toHaveLength(1);
    expect(opts.imageMetadata![0].buffer.toString()).toBe("png-bytes-exec.png");
    expect(storeMessageImages).toHaveBeenCalledWith("chat-1", [id]);
    expect(exists(id)).toBe(true);
  });

  it("records a new chat's images once the chat exists", async () => {
    const emitter = new EventEmitter();
    vi.mocked(sendMessage).mockResolvedValueOnce(emitter as any);
    const id = await storeImage("exec-new.png");
    const created = await call("post", "/", { body: { folder: "/tmp/p", user_message: "m", images: [{ id, originalName: "exec-new.png" }] } });

    await call("post", "/:id/execute-now", { params: { id: created.body.id } });
    expect(vi.mocked(sendMessage).mock.calls.at(-1)![0].imageMetadata).toHaveLength(1);
    emitter.emit("event", { type: "chat_created", chatId: "chat-new" });
    expect(storeMessageImages).toHaveBeenCalledWith("chat-new", [id]);
  });

  it("refuses, and keeps the draft, when one of its images is gone", async () => {
    vi.mocked(sendMessage).mockClear();
    const id = await storeImage("vanishing.png");
    const created = await call("post", "/", { body: { chat_id: "chat-1", user_message: "m", images: [{ id, originalName: "vanishing.png" }] } });
    ImageStorageService.deleteImage(id);

    const res = await call("post", "/:id/execute-now", { params: { id: created.body.id } });
    expect(res.code).toBe(409);
    expect(sendMessage).not.toHaveBeenCalled();
    expect((await call("get", "/:id", { params: { id: created.body.id } })).code).toBe(200);
  });
});
