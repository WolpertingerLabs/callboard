/**
 * A message may be only attachments. The composer enables Send with files and
 * no text, so POST /:id/message must take an empty prompt when `imageIds`
 * carries something, and still refuse a message that carries nothing.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import type { SessionProvider } from "../agents/ports/SessionProvider.js";

const dir = mkdtempSync(join(tmpdir(), "post-attachment-only-"));
process.env.CALLBOARD_DATA_DIR = dir;
const calls = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../services/claude.js", () => ({
  sendMessage: calls.execute,
  getActiveSession: () => null,
  stopSession: () => false,
  respondToPermission: () => false,
  hasPendingRequest: () => false,
  getPendingRequest: () => null,
}));
vi.mock("../utils/git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/git.js")>()),
  getGitInfo: () => ({ isGitRepo: true, branch: "main" }),
}));
const { chatFileService } = await import("../services/chat-file-service.js");
const { setSessionProvidersForTesting } = await import("../agents/factory.js");
const { ImageStorageService } = await import("../services/image-storage.js");
const { streamRouter } = await import("./stream.js");

const handler = (streamRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/message" && layer.route.methods.post).route.stack[0].handle as (
  req: Request,
  res: Response,
) => Promise<void>;

const CHAT = "attachment-only-chat";

async function post(body: Record<string, unknown>) {
  const response = { status: 200, body: undefined as unknown, streamed: false };
  const res = {
    status: (code: number) => {
      response.status = code;
      return res;
    },
    json: (payload: unknown) => {
      response.body = payload;
      return res;
    },
    writeHead: () => {
      response.streamed = true;
    },
    write: () => true,
    end: () => {},
  };
  await handler({ params: { id: CHAT }, body, headers: {}, on: () => {} } as unknown as Request, res as unknown as Response);
  return response;
}

beforeEach(() => {
  calls.execute.mockReset().mockImplementation(async () => new EventEmitter());
  const logPath = join(dir, `${CHAT}.jsonl`);
  writeFileSync(logPath, "");
  setSessionProvidersForTesting([
    { kind: "claude-code", resolveSession: (sid: string) => (sid === CHAT ? { logPath, folder: dir, displayFolder: dir } : null) } as unknown as SessionProvider,
  ]);
  chatFileService.upsertChat(CHAT, dir, CHAT, { metadata: JSON.stringify({ provider: "claude-code" }) });
});
afterAll(() => {
  setSessionProvidersForTesting(null);
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /:id/message with only attachments", () => {
  it("sends a file with no typed text", async () => {
    const { image } = await ImageStorageService.storeImage(Buffer.from("a,b\n1,2\n"), "data.csv", "text/csv");
    const response = await post({ prompt: "", imageIds: [image!.id] });
    expect(response.status).toBe(200);
    expect(response.streamed).toBe(true);
    expect(calls.execute).toHaveBeenCalledOnce();
    const [options] = calls.execute.mock.calls[0];
    expect(options.prompt).toBe("");
    expect(options.imageMetadata).toEqual([expect.objectContaining({ id: image!.id, name: "data.csv" })]);
  });

  it("accepts an omitted prompt too, as an empty one", async () => {
    const { image } = await ImageStorageService.storeImage(Buffer.from("png"), "shot.png", "image/png");
    expect((await post({ imageIds: [image!.id] })).streamed).toBe(true);
    expect(calls.execute.mock.calls[0][0].prompt).toBe("");
  });

  it.each([
    { prompt: "" },
    { prompt: "", imageIds: [] },
    { imageIds: "not-an-array" },
    { prompt: "", imageIds: ["bogus"] },
    { prompt: "", imageIds: ["00000000-0000-4000-8000-000000000000"] },
  ])("still refuses a message with nothing in it: %j", async (body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "prompt is required" });
    expect(calls.execute).not.toHaveBeenCalled();
  });

  it("refuses an upload that is listed but cannot be loaded, rather than sending an empty prompt", async () => {
    // A directory under an upload's name: the listing finds it, reading it fails.
    const id = randomUUID();
    mkdirSync(join(dir, "images", `${id}_unreadable`), { recursive: true });
    const response = await post({ prompt: "", imageIds: [id] });
    expect(response.status).toBe(400);
    expect(calls.execute).not.toHaveBeenCalled();
  });
});
