/**
 * `POST /api/chats/new/message` — the `acp` + `acpProviderId` pairing.
 *
 * `"acp"` is the only routable kind whose request is incomplete on its own: the
 * kind names a wire format, and the vendor lives in a second field. This route
 * is the reason `"acp"` could finally join `ROUTABLE_PROVIDER_KINDS` at all, so
 * the rejection cases below are the guard that made that safe — a chat persisted
 * with `provider: "acp"` and no vendor is permanently unrunnable.
 *
 * The handler is pulled off the router stack and driven with a fake req/res, the
 * no-supertest style used by `stream.new-message.test.ts` and
 * `cards.delete.test.ts`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import type { Request, Response } from "express";

/** Options the route handed to `sendMessage`, per invocation. */
let lastOptions: Record<string, unknown> | null = null;

vi.mock("../services/claude.js", () => ({
  sendMessage: async (opts: Record<string, unknown>) => {
    lastOptions = opts;
    return new EventEmitter();
  },
  getActiveSession: () => null,
  stopSession: () => false,
  respondToPermission: () => false,
  hasPendingRequest: () => false,
  getPendingRequest: () => null,
}));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { notifyMetadata: () => {} } }));

const { streamRouter } = await import("./stream.js");

const newMessageHandler = (streamRouter as any).stack.find((layer: any) => layer.route?.path === "/new/message" && layer.route.methods.post).route.stack[0]
  .handle as (req: Request, res: Response) => Promise<void>;

interface Captured {
  res: Response;
  status: number | null;
  json: { error?: string } | null;
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
      state.json = body as { error?: string };
      return this;
    },
    writeHead() {
      // Reaching the SSE headers means the request was accepted.
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
  // `folder` must exist on disk — the route 400s before provider validation otherwise.
  const req = { headers: {}, body: { folder: process.cwd(), prompt: "hi", ...body }, on: () => {} } as unknown as Request;
  await newMessageHandler(req, f.res);
  return f;
}

beforeEach(() => {
  lastOptions = null;
});

describe('POST /new/message with provider "acp"', () => {
  it("forwards the vendor alongside the kind", async () => {
    const f = await post({ provider: "acp", acpProviderId: "opencode" });

    expect(f.status).toBeNull();
    expect(f.streamed).toBe(true);
    expect(lastOptions).toMatchObject({ provider: "acp", acpProviderId: "opencode" });
  });

  it("rejects the kind with no vendor rather than falling back", async () => {
    const f = await post({ provider: "acp" });

    // Silently dropping the field — the treatment every other optional knob
    // gets — would start the chat on Claude Code instead, i.e. on a harness the
    // user did not choose.
    expect(f.status).toBe(400);
    expect(f.json?.error).toContain("acpProviderId is required");
    expect(lastOptions).toBeNull();
  });

  it("rejects an unknown vendor and names the ones that exist", async () => {
    const f = await post({ provider: "acp", acpProviderId: "not-a-real-vendor" });

    expect(f.status).toBe(400);
    expect(f.json?.error).toContain("not-a-real-vendor");
    // The message lists the configured ids, so a typo is self-correcting.
    expect(f.json?.error).toContain("opencode");
    expect(lastOptions).toBeNull();
  });

  it("rejects a blank vendor the same way as a missing one", async () => {
    const f = await post({ provider: "acp", acpProviderId: "   " });

    expect(f.status).toBe(400);
    expect(lastOptions).toBeNull();
  });

  it("ignores acpProviderId on every other provider", async () => {
    // The field is meaningless off `acp`; persisting it would leave misleading
    // metadata on a Claude Code chat.
    const f = await post({ provider: "claude-code", acpProviderId: "opencode" });

    expect(f.streamed).toBe(true);
    expect(lastOptions).not.toHaveProperty("acpProviderId");
  });

  it("still drops an unknown provider silently, as before", async () => {
    // Unchanged behaviour for the non-ACP path: an unrecognized kind is dropped
    // at the boundary, which is the same outcome as omitting it.
    const f = await post({ provider: "not-a-provider" });

    expect(f.status).toBeNull();
    expect(lastOptions).not.toHaveProperty("provider");
  });
});
