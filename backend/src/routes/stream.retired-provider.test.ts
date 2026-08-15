/**
 * `POST /api/chats/:id/message` for a chat pinned to a harness this build
 * removed — the two Phase 4 corrections to the refusal path.
 *
 * 1. It answers **410 Gone**, not 500. The message was actionable either way;
 *    what 500 claimed was that Callboard had failed, for a condition that is
 *    entirely about the chat's own state and that no retry can clear.
 * 2. It does not write metadata on the way to refusing. The per-chat
 *    reasoning-effort branch sits ahead of `sendMessage` and still listed
 *    `"openrouter"`, so it could persist an effort value onto a chat that can
 *    never run again.
 *
 * Same no-supertest style as stream.acp-provider.test.ts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { Request, Response } from "express";

/** Metadata merges the route performed, in order. */
let metadataWrites: Record<string, unknown>[] = [];
/** Chat record the stubbed file service hands back. */
let chatRecord: { id: string; folder: string; session_id: string; metadata: string } | null = null;

class FakeRetiredProviderError extends Error {}

const RETIRED_MESSAGE = "This chat ran on the OpenRouter agent harness, which has been removed. It cannot be resumed.";

vi.mock("../services/claude.js", () => ({
  // Mirrors the real resolveProviderKind: refuse a retired kind by name rather
  // than degrading it to claude-code and hunting for a session log.
  sendMessage: async (opts: Record<string, unknown>) => {
    const chat = chatRecord;
    if (chat && JSON.parse(chat.metadata).provider === "openrouter") throw new FakeRetiredProviderError(RETIRED_MESSAGE);
    void opts;
    return new EventEmitter();
  },
  getActiveSession: () => null,
  stopSession: () => false,
  respondToPermission: () => false,
  hasPendingRequest: () => false,
  getPendingRequest: () => null,
  RetiredProviderError: FakeRetiredProviderError,
}));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { notifyMetadata: () => {} } }));
vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getChat: () => chatRecord,
    updateChatMetadata: (_id: string, fields: Record<string, unknown>) => {
      metadataWrites.push(fields);
      return true;
    },
  },
}));
vi.mock("../utils/git.js", () => ({ getGitInfo: () => ({ isGitRepo: true, branch: "main" }), resolveBranch: () => ({ ok: true, folder: "/tmp/proj" }) }));

const { streamRouter } = await import("./stream.js");

const messageHandler = (streamRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/message" && layer.route.methods.post).route.stack[0]
  .handle as (req: Request, res: Response) => Promise<void>;

interface Captured {
  res: Response;
  status: number | null;
  json: { error?: string; code?: string } | null;
  streamed: boolean;
}

function fakeResponse(): Captured {
  const state: Captured = { status: null, json: null, streamed: false, res: null as unknown as Response };
  state.res = {
    status(code: number) {
      state.status = code;
      return this;
    },
    json(body: unknown) {
      state.json = body as { error?: string; code?: string };
      return this;
    },
    writeHead() {
      state.streamed = true;
      return this;
    },
    write() {
      return true;
    },
    end() {
      return this;
    },
  } as unknown as Response;
  return state;
}

async function post(body: Record<string, unknown>): Promise<Captured> {
  const f = fakeResponse();
  const req = { headers: {}, params: { id: "chat-1" }, body: { prompt: "hi", ...body }, on: () => {} } as unknown as Request;
  await messageHandler(req, f.res);
  return f;
}

function setChat(meta: Record<string, unknown>) {
  chatRecord = { id: "chat-1", folder: "/tmp/proj", session_id: "sess-1", metadata: JSON.stringify(meta) };
}

beforeEach(() => {
  metadataWrites = [];
  setChat({ provider: "openrouter", lastBranch: "main" });
});

describe("POST /:id/message on a removed harness", () => {
  it("answers 410 Gone with the refusal message, not 500", async () => {
    const f = await post({});

    expect(f.status).toBe(410);
    expect(f.json?.error).toContain("OpenRouter agent harness");
    expect(f.json?.code).toBe("retired_provider");
    // No SSE stream was opened — the client gets a plain JSON body it can render.
    expect(f.streamed).toBe(false);
  });

  it("does not persist a reasoning effort onto a chat that can never run", async () => {
    await post({ effort: "high" });

    // The branch ran ahead of the refusal, so "it is unreachable in practice"
    // was never true — only "no live chat still names openrouter" was.
    expect(metadataWrites.some((w) => "effort" in w)).toBe(false);
  });

  it("still persists effort for a live harness that takes one", async () => {
    // The guard removed one kind from the list; it did not disable the branch.
    setChat({ provider: "codex", lastBranch: "main" });
    await post({ effort: "high" });

    expect(metadataWrites).toContainEqual({ effort: "high" });
  });

  it("leaves an ordinary failure as a 500", async () => {
    // 410 is reserved for the retired-harness refusal — a genuine server fault
    // must not be relabelled as a permanent client-state condition.
    setChat({ provider: "codex", lastBranch: "main" });
    const f = fakeResponse();
    const req = { headers: {}, params: { id: "chat-1" }, body: { prompt: "hi", imageIds: ["nope"] }, on: () => {} } as unknown as Request;
    await messageHandler(req, f.res);

    expect(f.status).toBe(500);
    expect(f.json?.code).toBeUndefined();
  });
});
