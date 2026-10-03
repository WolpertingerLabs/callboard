/**
 * DELETE /api/images/:imageId removes the image's references from every chat.
 *
 * The sweep reads each record's metadata in turn, so one record whose metadata
 * will not parse must be skipped — not abort the loop and leave every later
 * chat still pointing at an image that no longer exists — and must not be
 * written either, since there is nothing in it this route can safely change.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

/* eslint-disable @typescript-eslint/no-explicit-any */

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-images-delete-"));

let chats: any[] = [];
const updateChat = vi.fn((_id: string, _updates: Record<string, unknown>) => true);

vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getAllChats: () => chats,
    updateChat: (...args: any[]) => (updateChat as any)(...args),
  },
}));
vi.mock("../services/image-storage.js", () => ({ ImageStorageService: { deleteImage: () => true } }));

const { imagesRouter } = await import("./images.js");

const handler = (imagesRouter as any).stack.find((layer: any) => layer.route?.path === "/:imageId" && layer.route.methods.delete).route.stack[0].handle as (
  req: Request,
  res: Response,
) => Promise<void>;

function remove(imageId: string): Promise<{ code: number; body: any }> {
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
    void handler({ params: { imageId } } as unknown as Request, res as unknown as Response);
  });
}

const withImages = (id: string, images: Record<string, { id: string }[]>) => ({ id, metadata: JSON.stringify({ title: id, images }) });

beforeEach(() => {
  updateChat.mockClear();
});

describe("DELETE /api/images/:imageId", () => {
  it("skips a record whose metadata does not parse and still cleans the chats after it", async () => {
    chats = [
      withImages("before", { m1: [{ id: "img-x" }, { id: "img-keep" }] }),
      { id: "corrupt", metadata: '{"images": {"m1": [{"id": "img-x"' },
      withImages("after", { m1: [{ id: "img-x" }], m2: [{ id: "img-other" }] }),
    ];

    const res = await remove("img-x");

    expect(res.code).toBe(200);
    expect(updateChat.mock.calls.map((c) => c[0])).toEqual(["before", "after"]);
    const after = JSON.parse((updateChat.mock.calls[1][1] as any).metadata);
    expect(after).toEqual({ title: "after", images: { m2: [{ id: "img-other" }] } });
    const before = JSON.parse((updateChat.mock.calls[0][1] as any).metadata);
    expect(before.images).toEqual({ m1: [{ id: "img-keep" }] });
  });

  it("writes nothing to a chat that never referenced the image", async () => {
    chats = [withImages("other", { m1: [{ id: "img-other" }] }), { id: "bare", metadata: "{}" }];
    expect((await remove("img-x")).code).toBe(200);
    expect(updateChat).not.toHaveBeenCalled();
  });
});
