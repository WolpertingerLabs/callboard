/**
 * A new-chat draft is a chat-creation path: `execute-now` creates the chat with
 * the draft's stored permissions. So saving one records the same creation note
 * as `POST /api/chats` (computer-use-policy.creation-note.test.ts pins the note
 * itself). A draft for an existing chat never uses its permissions: no note.
 */
import { beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-queue-note-"));

const note = vi.hoisted(() => vi.fn());
vi.mock("../services/claude.js", () => ({ sendMessage: vi.fn(), RetiredProviderError: class RetiredProviderError extends Error {} }));
vi.mock("../services/computer-use-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/computer-use-policy.js")>()),
  noteComputerControlAtCreation: note,
}));

const { queueRouter } = await import("./queue.js");

function create(body: Record<string, unknown>, authMethod: string): Promise<number> {
  type Layer = { route?: { path: string; methods: Record<string, boolean>; stack: { handle: (req: Request, res: Response) => void }[] } };
  const route = (queueRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === "/" && l.route.methods.post)!.route!;
  const handler = route.stack[route.stack.length - 1].handle;
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      locals: { authMethod },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json() {
        resolve(this.statusCode);
        return this;
      },
    };
    handler({ params: {}, query: {}, body } as unknown as Request, res as unknown as Response);
  });
}

beforeEach(() => note.mockClear());

const perms = { fileRead: "allow", fileWrite: "allow", codeExecution: "allow", webAccess: "allow", browserControl: "allow", computerControl: "deny" };

it("notes the permissions of a new-chat draft, with the caller's auth method", async () => {
  expect(await create({ user_message: "hi", folder: "/tmp/project", defaultPermissions: perms }, "bearer")).toBe(201);
  expect(note).toHaveBeenCalledWith("POST /api/queue", "bearer", perms);
});

it("does not note a draft for an existing chat, which never uses its permissions", async () => {
  expect(await create({ user_message: "hi", chat_id: "chat-1", defaultPermissions: perms }, "bearer")).toBe(201);
  expect(note).not.toHaveBeenCalled();
});
