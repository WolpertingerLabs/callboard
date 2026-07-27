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
    // Echoes the composed metadata back so the test can assert on it, plus the
    // top-level workspaceId argument (which is a Chat field, not metadata).
    createChat: (folder: string, sessionId: string, metadata: string, workspaceId?: string) => ({
      id: "fork-chat",
      folder,
      session_id: sessionId,
      metadata,
      ...(workspaceId && { workspaceId }),
    }),
  },
}));
/** Calls recorded by the stub providers, so tests can assert which path ran. */
const calls: { forkSession: unknown[][]; seedSession: unknown[][] } = { forkSession: [], seedSession: [] };

/** History the source provider hands back to the handoff projection. */
let sourceMessages: unknown[] = [
  { role: "user", type: "text", content: "carried question", timestamp: "2026-01-01T00:00:00Z" },
  { role: "assistant", type: "text", content: "carried answer", timestamp: "2026-01-01T00:00:00Z" },
];

vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      forkSession: (...args: unknown[]) => {
        calls.forkSession.push(args);
        return { logPath: "/tmp/fork.jsonl" };
      },
      seedSession: (...args: unknown[]) => {
        calls.seedSession.push(args);
        return { logPath: "/tmp/seed.jsonl" };
      },
      parseSessionMessages: () => sourceMessages,
      getSessionPreview: () => "preview",
    },
    {
      kind: "codex",
      // No forkSession — Codex has no native fork, which is exactly why a
      // codex→codex fork must fall through to the seed path.
      seedSession: (...args: unknown[]) => {
        calls.seedSession.push(args);
        return { logPath: "/tmp/seed-codex.jsonl" };
      },
      parseSessionMessages: () => sourceMessages,
      getSessionPreview: () => "preview",
    },
    {
      // Deliberately stubbed WITHOUT seedSession (the real provider has one) so
      // the "target harness can't be seeded" rejection branch stays covered.
      kind: "openrouter",
      parseSessionMessages: () => sourceMessages,
      getSessionPreview: () => "preview",
    },
  ],
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { notifyMetadata: () => {} } }));

const { chatsRouter } = await import("./chats.js");

const forkHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/fork" && layer.route.methods.post)
  .route.stack[0].handle as (req: Request, res: Response) => void;

/** Invoke POST /:id/fork and resolve with the status code, the fork's parsed metadata, and the raw record. */
function fork(body: Record<string, unknown> = {}): Promise<{ code: number; meta: any; chat: any }> {
  calls.forkSession = [];
  calls.seedSession = [];
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, meta: payload.metadata ? JSON.parse(payload.metadata) : payload, chat: payload });
        return this;
      },
    };
    forkHandler(
      { params: { id: "parent-chat" }, body: { timestamp: "2026-01-01T00:00:00Z", ...body } } as unknown as Request,
      res as unknown as Response,
    );
  });
}

/**
 * Build a parent chat whose metadata is `meta` merged over the defaults.
 * `fields` sets top-level Chat columns (e.g. workspaceId, which is not metadata).
 */
function setParent(meta: Record<string, unknown>, fields: Record<string, unknown> = {}) {
  parentChat = {
    id: "parent-chat",
    folder: "/repo",
    session_id: "session-1",
    session_log_path: "/tmp/parent.jsonl",
    metadata: JSON.stringify({ session_ids: ["session-1"], title: "Parent", ...meta }),
    ...fields,
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

  it("carries the parent's workspace onto the fork", async () => {
    // The fork runs in the parent's folder, so it belongs to the parent's
    // workspace. Without the linkage it would be absent from the set Phase 2's
    // archive cascade interrupts, and would keep running in a directory being
    // removed underneath it. workspaceId is a top-level Chat field, so it is
    // NOT in the metadata blob the rest of this suite asserts on.
    setParent({}, { workspaceId: "ws-abc123" });
    const res = await fork();
    expect(res.code).toBe(201);
    expect(res.chat.workspaceId).toBe("ws-abc123");
    expect(res.meta).not.toHaveProperty("workspaceId");
  });

  it("carries the workspace across a harness handoff too", async () => {
    // The directory does not change on a handoff — only the engine does.
    setParent({}, { workspaceId: "ws-abc123" });
    const res = await fork({ provider: "codex" });
    expect(res.code).toBe(201);
    expect(res.chat.workspaceId).toBe("ws-abc123");
  });

  it("omits workspaceId when the parent has none", async () => {
    setParent({});
    const res = await fork();
    expect(res.chat).not.toHaveProperty("workspaceId");
  });
});

describe("POST /api/chats/:id/fork cross-harness handoff", () => {
  it("copies the native session log when no target harness is given", async () => {
    setParent({});
    const res = await fork();
    expect(res.code).toBe(201);
    // Same-harness forks keep the high-fidelity path — real tool_use blocks,
    // reasoning and ids survive, which the flattened seed path drops.
    expect(calls.forkSession).toHaveLength(1);
    expect(calls.seedSession).toHaveLength(0);
    expect(res.meta.chatRole).toBe("fork");
    expect(res.meta).not.toHaveProperty("provider");
  });

  it("seeds the target harness and pins it on the fork", async () => {
    setParent({});
    const res = await fork({ provider: "codex" });
    expect(res.code).toBe(201);
    expect(calls.forkSession).toHaveLength(0);
    expect(calls.seedSession).toHaveLength(1);
    expect(res.meta.provider).toBe("codex");
    expect(res.meta.chatRole).toBe("engine-switch");
    expect(res.meta.title).toBe("→ Codex: Parent");
  });

  it("passes the preamble plus carried history to the target's writer", async () => {
    setParent({});
    await fork({ provider: "codex" });
    const [turns, opts] = calls.seedSession[0] as [any[], any];
    expect(turns[0].text).toContain("conversation_handoff");
    expect(turns.map((t) => t.text)).toContain("carried question");
    expect(opts.folder).toBe("/repo");
  });

  it("omits the provider key when handing back to claude-code", async () => {
    // sendMessage treats absent provider as claude-code; writing it explicitly
    // would be redundant metadata that every later read has to normalize.
    setParent({ provider: "codex" });
    const res = await fork({ provider: "claude-code" });
    expect(res.code).toBe(201);
    expect(res.meta).not.toHaveProperty("provider");
    expect(res.meta.chatRole).toBe("engine-switch");
  });

  it("falls back to seeding when the source harness has no native fork", async () => {
    setParent({ provider: "codex" });
    const res = await fork();
    expect(res.code).toBe(201);
    expect(calls.seedSession).toHaveLength(1);
    // Not a harness switch — the chat stays on codex and keeps the fork role.
    expect(res.meta.provider).toBe("codex");
    expect(res.meta.chatRole).toBe("fork");
  });

  it("rejects an unknown target harness", async () => {
    setParent({});
    const res = await fork({ provider: "gpt-at-home" });
    expect(res.code).toBe(400);
    expect(res.meta.error).toContain("Unknown target provider");
  });

  it("rejects a target harness that cannot be seeded", async () => {
    setParent({});
    const res = await fork({ provider: "openrouter" });
    expect(res.code).toBe(400);
    expect(res.meta.error).toContain("OpenRouter");
  });

  it("rejects a handoff when there is no history to carry", async () => {
    setParent({});
    const previous = sourceMessages;
    sourceMessages = [{ role: "assistant", type: "thinking", content: "dropped", timestamp: "2026-01-01T00:00:00Z" }];
    const res = await fork({ provider: "codex" });
    sourceMessages = previous;
    expect(res.code).toBe(400);
    expect(calls.seedSession).toHaveLength(0);
  });
});

describe("POST /api/chats/:id/fork model and effort", () => {
  it("does not carry the source harness's model across a switch", async () => {
    // Model ids are per-harness: "claude-opus-5" is meaningless to Codex, and
    // an effort scale doesn't transfer either.
    setParent({ model: "claude-opus-5", effort: "high" });
    const res = await fork({ provider: "codex" });
    expect(res.meta).not.toHaveProperty("model");
    expect(res.meta).not.toHaveProperty("effort");
  });

  it("accepts a model and effort for the new harness", async () => {
    // Codex honors metadata.model too (its config block prefers the per-chat
    // override over the global codexModel default), so it must not be dropped.
    setParent({});
    const res = await fork({ provider: "codex", model: "gpt-5.6", effort: "high" });
    expect(res.meta.effort).toBe("high");
    expect(res.meta.model).toBe("gpt-5.6");
  });

  it("drops effort when the target harness has no reasoning control", async () => {
    setParent({});
    const res = await fork({ provider: "claude-code", model: "opus", effort: "high" });
    expect(res.meta.model).toBe("opus");
    expect(res.meta).not.toHaveProperty("effort");
  });

  it("keeps model and effort on a same-harness fork", async () => {
    setParent({ model: "claude-opus-5" });
    const res = await fork();
    expect(res.meta.model).toBe("claude-opus-5");
  });

  it("drops OpenRouter model routing when leaving OpenRouter", async () => {
    setParent({ provider: "codex", modelRouting: true, modelRoutingRankId: "rank-1" });
    const res = await fork({ provider: "claude-code" });
    expect(res.meta).not.toHaveProperty("modelRouting");
    expect(res.meta).not.toHaveProperty("modelRoutingRankId");
  });
});
