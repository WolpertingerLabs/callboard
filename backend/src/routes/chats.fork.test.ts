/**
 * Route-level tests for the metadata stamped on POST /api/chats/:id/fork —
 * specifically that a fork inherits its parent's card membership, so the fork
 * still shows up in the card rollup (which discovers members by scanning
 * `metadata.cardId`).
 *
 * The handler is pulled off the router stack and driven with a fake req/res
 * rather than a live HTTP server, matching the no-supertest style in
 * cards.metadata.test.ts. The chat lookup, file service and session provider
 * are stubbed so the test asserts purely on the metadata the route composes.
 */
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

let parentChat: any;

vi.mock("../utils/chat-lookup.js", () => ({ findChat: () => parentChat }));
vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    // Echoes the composed metadata back so the test can assert on it.
    createChat: (folder: string, sessionId: string, metadata: string) => ({ id: "fork-chat", folder, session_id: sessionId, metadata }),
  },
}));
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      forkSession: () => ({ logPath: "/tmp/fork.jsonl" }),
      getSessionPreview: () => "preview",
    },
  ],
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { notifyMetadata: () => {} } }));

const { chatsRouter } = await import("./chats.js");

const forkHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/fork" && layer.route.methods.post)
  .route.stack[0].handle as (req: Request, res: Response) => void;

/** Invoke POST /:id/fork and resolve with the status code and the fork's parsed metadata. */
function fork(): Promise<{ code: number; meta: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, meta: payload.metadata ? JSON.parse(payload.metadata) : payload });
        return this;
      },
    };
    forkHandler({ params: { id: "parent-chat" }, body: { timestamp: "2026-01-01T00:00:00Z" } } as unknown as Request, res as unknown as Response);
  });
}

/** Build a parent chat whose metadata is `meta` merged over the defaults. */
function setParent(meta: Record<string, unknown>) {
  parentChat = {
    id: "parent-chat",
    folder: "/repo",
    session_id: "session-1",
    session_log_path: "/tmp/parent.jsonl",
    metadata: JSON.stringify({ session_ids: ["session-1"], title: "Parent", ...meta }),
  };
}

describe("POST /api/chats/:id/fork metadata", () => {
  it("carries the parent's card id onto the fork", async () => {
    setParent({ cardId: "card-42" });
    const res = await fork();
    expect(res.code).toBe(201);
    expect(res.meta.cardId).toBe("card-42");
    expect(res.meta.parentChatId).toBe("parent-chat");
    expect(res.meta.chatRole).toBe("fork");
  });

  it("omits cardId when the parent has none", async () => {
    setParent({});
    const res = await fork();
    expect(res.meta).not.toHaveProperty("cardId");
  });

  it("omits cardId when the parent was unassigned from its card", async () => {
    // Unassign merges `cardId: null` rather than deleting the key, so key
    // presence alone would wrongly stamp a null card onto the fork.
    setParent({ cardId: null });
    const res = await fork();
    expect(res.meta).not.toHaveProperty("cardId");
  });
});
