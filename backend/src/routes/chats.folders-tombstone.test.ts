/**
 * `GET /api/chats/folders` is a tombstone for browser tabs still running a
 * bundle from before the Folders view was removed. Without it, their poll falls
 * through to `GET /:id` with id "folders" and pays a full chat-store miss scan
 * before 404ing — every 15 seconds, per stale tab.
 *
 * So the claim is twofold: the answer is an empty listing, and the chat store
 * is never asked. The request is dispatched through the whole router, not a
 * handler pulled off the stack, because route *order* is what this defends.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-folders-tombstone-"));

const storeTouched = vi.fn();
vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: new Proxy(
    {},
    {
      get: (_target, prop) => {
        storeTouched(prop);
        return () => null;
      },
    },
  ),
}));

const { chatsRouter } = await import("./chats.js");

describe("GET /folders tombstone", () => {
  it("answers an empty listing without touching the chat store", async () => {
    const body = await new Promise<unknown>((resolve, reject) => {
      const req = { method: "GET", url: "/folders", originalUrl: "/folders", path: "/folders", query: {}, headers: {} };
      const res = {
        statusCode: 200,
        locals: {},
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(payload: unknown) {
          resolve(payload);
          return this;
        },
        setHeader() {},
      };
      // `handle` is real but absent from the public Router type.
      const router = chatsRouter as unknown as { handle(req: object, res: object, next: (err?: unknown) => void): void };
      router.handle(req, res, (err?: unknown) => reject(err ?? new Error("fell through the router")));
    });

    expect(body).toEqual({ folders: [] });
    expect(storeTouched).not.toHaveBeenCalled();
  });
});
