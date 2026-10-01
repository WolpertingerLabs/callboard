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
 *  - the draft owns its images, so deleting it (or replacing them) deletes the
 *    image files too, instead of leaking one copy per save.
 *
 * Same no-supertest style as chats.set-title.test.ts: handlers are pulled off
 * the router stack and driven with a fake req/res. Storage is real, under a
 * scratch CALLBOARD_DATA_DIR.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-queue-images-"));
process.env.CALLBOARD_DATA_DIR = DATA_DIR;

vi.mock("../services/claude.js", () => ({ sendMessage: vi.fn() }));

const { queueRouter } = await import("./queue.js");
const { ImageStorageService } = await import("../services/image-storage.js");

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

  it("replaces a draft's images on an update that sends them, deleting the dropped ones", async () => {
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
    expect([exists(kept), exists(dropped), exists(added)]).toEqual([true, false, true]);

    // An empty list is "no images now", not "unchanged".
    const cleared = await call("put", "/:id", { params: { id: created.body.id }, body: { user_message: "v3", images: [] } });
    expect("images" in cleared.body).toBe(false);
    expect([exists(kept), exists(added)]).toEqual([false, false]);
  });

  it("deletes the draft's images with the draft", async () => {
    const id = await storeImage("gone.png");
    const created = await call("post", "/", { body: { chat_id: "chat-1", user_message: "m", images: [{ id, originalName: "gone.png" }] } });

    const deleted = await call("delete", "/:id", { params: { id: created.body.id } });
    expect(deleted.body).toEqual({ ok: true });
    expect(exists(id)).toBe(false);
  });
});
