/**
 * Card policy on `POST /api/chats/new/message`.
 *
 * The composer no longer sends a card flag at all — the server decides. That
 * makes the default the whole feature: if the route stops asking for a card
 * when the body is silent, every other card test still passes and new chats
 * quietly stop getting one. So the body-with-no-flag case is pinned first.
 *
 * `sendMessage` is stubbed and its options captured, in the no-supertest style
 * of stream.new-message.test.ts — what this file pins is the request the route
 * *makes*, not what the service then does with it. The service-side invariant
 * has its own coverage in services/claude.auto-card.test.ts, deliberately: the
 * two layers are meant to hold independently.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { Request, Response } from "express";

/** Options the route passed to `sendMessage`, per invocation. */
let lastOpts: Record<string, unknown> | null = null;

vi.mock("../services/claude.js", () => ({
  sendMessage: async (opts: Record<string, unknown>) => {
    lastOpts = opts;
    return new EventEmitter();
  },
  getActiveSession: () => null,
  stopSession: () => false,
  respondToPermission: () => false,
  hasPendingRequest: () => false,
  getPendingRequest: () => null,
}));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { notifyMetadata: () => {} } }));

// An open card the route can validate a `cardId` against. Anything not listed
// here reads as unknown/closed and gets dropped.
const OPEN_CARD_ID = "card-open-1";
vi.mock("../services/card-store.js", () => ({
  getCard: (id: string) => (id === OPEN_CARD_ID ? { id, title: "Open card", lifecycle: "open" } : null),
}));

const { streamRouter } = await import("./stream.js");

const newMessageHandler = (streamRouter as any).stack.find((layer: any) => layer.route?.path === "/new/message" && layer.route.methods.post).route
  .stack[0].handle as (req: Request, res: Response) => Promise<void>;

/** Swallows everything the SSE handler writes — this file asserts on opts. */
function sinkResponse(): Response {
  return {
    writeHead() {
      return this;
    },
    write() {
      return true;
    },
    end() {
      return this;
    },
    status() {
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
}

/** POST the given body to the route and return the captured sendMessage opts. */
async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  lastOpts = null;
  const req = {
    headers: {},
    // `folder` must exist on disk — the route 400s otherwise.
    body: { folder: process.cwd(), prompt: "hi", ...body },
    on: () => {},
  } as unknown as Request;
  await newMessageHandler(req, sinkResponse());
  expect(lastOpts, "route never reached sendMessage").not.toBeNull();
  return lastOpts!;
}

beforeEach(() => {
  lastOpts = null;
});

describe("POST /new/message — server-owned card creation", () => {
  it("asks for a card when the body carries no card fields at all", async () => {
    // The post-removal client's exact request shape. If this regresses, the
    // feature silently does nothing.
    const opts = await post({});

    expect(opts.createCard).toBe(true);
    expect(opts.cardId).toBeUndefined();
    expect(opts.cardCategory).toBeUndefined();
  });

  it("still honours an explicit createCard: false", async () => {
    const opts = await post({ createCard: false });

    expect(opts.createCard).toBeUndefined();
    expect(opts.cardId).toBeUndefined();
  });

  it("joins an explicit open cardId instead of creating one", async () => {
    const opts = await post({ cardId: OPEN_CARD_ID });

    expect(opts.cardId).toBe(OPEN_CARD_ID);
    expect(opts.createCard).toBeUndefined();
  });

  it("creates nothing when the requested cardId is stale", async () => {
    // A closed or deleted id drops the association entirely rather than
    // surprising the caller with a brand-new card they did not ask for.
    const opts = await post({ cardId: "card-closed-9" });

    expect(opts.cardId).toBeUndefined();
    expect(opts.createCard).toBeUndefined();
  });

  it("does not ask for a card when the chat is a child", async () => {
    const opts = await post({ parentChatId: "chat-parent-1" });

    expect(opts.parentChatId).toBe("chat-parent-1");
    expect(opts.createCard).toBeUndefined();
  });

  it("forwards a category when an API client supplies one", async () => {
    // The UI can no longer set this, but the field stays on the wire for
    // API callers — auto-created cards are otherwise uncategorized.
    const opts = await post({ cardCategory: "  infra  " });

    expect(opts.createCard).toBe(true);
    expect(opts.cardCategory).toBe("infra");
  });
});
