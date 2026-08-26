/**
 * Route-level tests for the metadata stamped on POST /api/chats/:id/fork —
 * specifically the parentage fields (parentChatId/rootChatId) that make the
 * fork a member of its root's card: card membership is derived from the tree,
 * so the fork carrying the tree links IS the card inheritance.
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
    // walkToRootId validates the parent's stored root before stamping the
    // fork. Return the parent itself and, when its fixture names one, a
    // minimal existing ancestor.
    getChat: (id: string) => {
      if (!parentChat) return null;
      if (id === parentChat.id || id === parentChat.session_id) return parentChat;
      const meta = JSON.parse(parentChat.metadata || "{}");
      if (id === meta.parentChatId || id === meta.forkedFrom || id === meta.rootChatId) {
        return { ...parentChat, id, session_id: id, metadata: "{}" };
      }
      return null;
    },
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
      // Cline and pi both implement seedSession AND forkSession for real —
      // `agents/handoff.roundtrip.test.ts` drives the actual providers. Here
      // they are stubs like the rest, so these cases assert the ROUTE offers
      // them rather than re-proving the providers work.
      kind: "cline",
      forkSession: (...args: unknown[]) => {
        calls.forkSession.push(args);
        return { logPath: "/tmp/fork-cline.jsonl" };
      },
      seedSession: (...args: unknown[]) => {
        calls.seedSession.push(args);
        return { logPath: "/tmp/seed-cline.jsonl" };
      },
      parseSessionMessages: () => sourceMessages,
      getSessionPreview: () => "preview",
    },
    {
      kind: "pi",
      forkSession: (...args: unknown[]) => {
        calls.forkSession.push(args);
        return { logPath: "/tmp/fork-pi.jsonl" };
      },
      seedSession: (...args: unknown[]) => {
        calls.seedSession.push(args);
        return { logPath: "/tmp/seed-pi.jsonl" };
      },
      parseSessionMessages: () => sourceMessages,
      getSessionPreview: () => "preview",
    },
    {
      // AcpSessionProvider IS registered in the real getSessionProviders(), so
      // the route's `find(p => p.kind === targetKind)` guard succeeds for "acp".
      // Stubbed here WITH a seedSession the real one does not have, on purpose:
      // that makes the rejection below prove the ROUTE refuses an ACP fork on
      // its own, rather than inheriting the refusal from a missing method.
      //
      // This stub has already earned its keep once. It was written when the
      // routable allowlist was the guard; when "acp" joined that allowlist it
      // turned green-to-201 and caught the reintroduced wedged-chat bug in the
      // same commit, which is why the route now carries an explicit check.
      kind: "acp",
      seedSession: (...args: unknown[]) => {
        calls.seedSession.push(args);
        return { logPath: "/tmp/seed-acp.jsonl" };
      },
      parseSessionMessages: () => sourceMessages,
      getSessionPreview: () => "preview",
    },
  ],
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { notifyMetadata: () => {} } }));

const { chatsRouter } = await import("./chats.js");

const forkHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/fork" && layer.route.methods.post).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

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
    forkHandler({ params: { id: "parent-chat" }, body: { timestamp: "2026-01-01T00:00:00Z", ...body } } as unknown as Request, res as unknown as Response);
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
  it("links the fork into the parent's tree — which is the card membership", async () => {
    // Cards are lineage: the fork becomes a member of the root's card through
    // parentChatId/rootChatId, with no membership pointer of its own. A stale
    // legacy `cardId` on the parent must NOT be copied — it is inert data.
    setParent({ cardId: "card-42" });
    const res = await fork();
    expect(res.code).toBe(201);
    expect(res.meta.parentChatId).toBe("parent-chat");
    expect(res.meta.rootChatId).toBe("parent-chat");
    expect(res.meta.chatRole).toBe("fork");
    expect(res.meta).not.toHaveProperty("cardId");
  });

  it("carries the grandparent's stamped root onto a fork of a child", async () => {
    setParent({ parentChatId: "grandparent", rootChatId: "grandparent" });
    const res = await fork();
    expect(res.meta.parentChatId).toBe("parent-chat");
    expect(res.meta.rootChatId).toBe("grandparent");
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

  it("rejects a fork into acp, which no ACP agent can be handed a conversation", async () => {
    // "acp" is a routable kind now, so this is no longer stopped by the
    // allowlist — it is stopped by `AcpSessionProvider` implementing neither
    // `forkSession` nor `seedSession`, deliberately. ACP session state lives
    // inside the vendor's process and the protocol gives a client no way to
    // hand an agent a conversation it did not have, so a seeded transcript
    // would render correctly and then lose every bit of context on the next
    // message. A 400 is the honest answer.
    setParent({});
    const res = await fork({ provider: "acp" });
    expect(res.code).toBe(400);
    expect(res.meta.error).toContain("not supported");
    // Still refused before anything is written — which is the property that
    // actually matters, and the one the old allowlist rejection provided.
    expect(calls.seedSession).toHaveLength(0);
  });

  it("refuses openrouter as a target — the harness was removed", async () => {
    // Not a "can't be seeded" rejection: `"openrouter"` left
    // ROUTABLE_PROVIDER_KINDS, so the request never gets as far as looking for a
    // provider. Nothing is written either way.
    setParent({});
    const res = await fork({ provider: "openrouter" });
    expect(res.code).toBe(400);
    expect(res.meta.error).toContain('Unknown target provider "openrouter"');
    expect(calls.seedSession).toHaveLength(0);
  });

  it("refuses a chat stamped with the removed openrouter harness as a SOURCE", async () => {
    // ~426 chat records still name it. Without the by-name refusal the internal
    // guard would drop them to "claude-code" and the fork would go looking for a
    // Claude session log that was never written. A named 400 says what happened.
    setParent({ provider: "openrouter" });
    const res = await fork();
    expect(res.code).toBe(400);
    expect(res.meta.error).toContain("OpenRouter");
    expect(res.meta.error).toContain("removed");
    expect(calls.seedSession).toHaveLength(0);
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

  it("never carries model routing onto a fork — the feature is gone with its harness", async () => {
    setParent({ provider: "codex", modelRouting: true, modelRoutingRankId: "rank-1" });
    const res = await fork({ provider: "claude-code" });
    expect(res.meta).not.toHaveProperty("modelRouting");
    expect(res.meta).not.toHaveProperty("modelRoutingRankId");
  });
});

/**
 * The two targets Phase 5 admitted.
 *
 * Both providers implement `seedSession` and `forkSession`, and both round-trip
 * a real handoff (`agents/handoff.roundtrip.test.ts` drives the actual files).
 * What was missing was the *offer*: `ForkProvider` never named them, so the
 * capability existed and the UI refused it. These cases pin the route half.
 */
describe("POST /api/chats/:id/fork — cline and pi are handoff targets", () => {
  it.each([
    ["cline", "Cline"],
    ["pi", "pi"],
  ])("hands a claude-code chat off to %s", async (kind, label) => {
    setParent({});
    const res = await fork({ provider: kind });
    expect(res.code).toBe(201);
    expect(calls.seedSession).toHaveLength(1);
    expect(res.meta.provider).toBe(kind);
    expect(res.meta.chatRole).toBe("engine-switch");
    expect(res.meta.title).toBe(`→ ${label}: Parent`);
  });

  it.each(["cline", "pi"])("takes the high-fidelity native path for a same-harness %s fork", async (kind) => {
    setParent({ provider: kind });
    const res = await fork();
    expect(res.code).toBe(201);
    // Both have a native fork, so neither should fall through to the flattened
    // seed path the way Codex does.
    expect(calls.forkSession).toHaveLength(1);
    expect(calls.seedSession).toHaveLength(0);
    expect(res.meta.chatRole).toBe("fork");
  });

  it.each(["cline", "pi"])("hands a %s chat back out to another harness", async (kind) => {
    setParent({ provider: kind });
    const res = await fork({ provider: "codex" });
    expect(res.code).toBe(201);
    expect(calls.seedSession).toHaveLength(1);
    expect(res.meta.provider).toBe("codex");
  });

  it.each(["cline", "pi"])("passes the preamble and carried history to %s's writer", async (kind) => {
    setParent({});
    await fork({ provider: kind });
    const [turns] = calls.seedSession[0] as [Array<{ text: string }>, unknown];
    expect(turns[0].text).toContain("conversation_handoff");
    expect(turns.map((t) => t.text)).toContain("carried question");
  });
});
