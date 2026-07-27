/**
 * Wire coverage for `POST /api/chats/new/message` — the one SSE route that does
 * *not* go through `createSSEHandler`. It duplicates that handler inline so it
 * can intercept `chat_created`, which makes it the only place where the
 * handshake's leading frame lands ahead of a frame the client must act on
 * immediately.
 *
 * `backend/src/utils/sse.test.ts` pins the shared handler's bytes; this file
 * pins this route's, against the same kind of hand-written literals. Two
 * handlers emitting the same wire is a duplication the tests have to hold
 * together, since the compiler doesn't.
 *
 * The handler is pulled off the router stack and driven with a fake req/res,
 * matching the no-supertest style in cards.delete.test.ts. `sendMessage` is
 * stubbed to hand back an emitter the test drives.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { Request, Response } from "express";
import type { IncomingHttpHeaders } from "http";
import { handshakeHeaders } from "shared/types/index.js";
import type { StreamEvent } from "../services/claude.js";

/** The emitter the stubbed `sendMessage` hands back, per invocation. */
let lastEmitter: EventEmitter;

vi.mock("../services/claude.js", () => ({
  sendMessage: async () => {
    lastEmitter = new EventEmitter();
    return lastEmitter;
  },
  getActiveSession: () => null,
  stopSession: () => false,
  respondToPermission: () => false,
  hasPendingRequest: () => false,
  getPendingRequest: () => null,
}));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { notifyMetadata: () => {} } }));

const { streamRouter } = await import("./stream.js");

const newMessageHandler = (streamRouter as any).stack.find((layer: any) => layer.route?.path === "/new/message" && layer.route.methods.post).route
  .stack[0].handle as (req: Request, res: Response) => Promise<void>;

interface FakeRes {
  res: Response;
  head: { status: number; headers: Record<string, string> } | null;
  chunks: string[];
  ended: boolean;
}

function fakeResponse(): FakeRes {
  const state: FakeRes = { head: null, chunks: [], ended: false, res: null as unknown as Response };
  state.res = {
    writeHead(status: number, headers: Record<string, string>) {
      state.head = { status, headers };
      return this;
    },
    write(chunk: string) {
      state.chunks.push(chunk);
      return true;
    },
    end() {
      state.ended = true;
      return this;
    },
  } as unknown as Response;
  return state;
}

/** Lowercase the handshake headers the way Node delivers them. */
function handshakeAsReceived(): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(handshakeHeaders()).map(([k, v]) => [k.toLowerCase(), v]));
}

/**
 * A representative new-chat run. `chat_created` leads, since that is the frame
 * this route exists to special-case and the one whose ordering relative to
 * `server_info` matters to a client that hasn't reloaded.
 */
const CANONICAL_NEW_CHAT_RUN: StreamEvent[] = [
  { type: "chat_created", content: "", chatId: "chat-1", chat: { id: "chat-1", folder: "/tmp/x" } } as unknown as StreamEvent,
  { type: "text", content: "hello" },
  { type: "tool_use", content: "", toolName: "Read", toolSource: "local" },
  { type: "permission_request", content: "", toolName: "Bash" } as StreamEvent,
  { type: "budget", content: "", costUsd: 0.25, maxBudgetUsd: 5 },
  { type: "compacting", content: "" },
  { type: "done", content: "", reason: "max_turns", costUsd: 0.5, maxBudgetUsd: 5, objectiveComplete: true },
];

/**
 * The exact bytes {@link CANONICAL_NEW_CHAT_RUN} must produce, hand-written
 * rather than derived from the route — so a payload regression in the inline
 * handler fails here instead of being reproduced by the comparison.
 */
const EXPECTED_NEW_CHAT_CHUNKS: string[] = [
  `data: {"type":"chat_created","chatId":"chat-1","chat":{"id":"chat-1","folder":"/tmp/x"}}\n\n`,
  `data: {"type":"message_update"}\n\n`,
  `data: {"type":"message_update"}\n\n`,
  `data: {"type":"permission_request","content":"","toolName":"Bash"}\n\n`,
  `data: {"type":"budget","costUsd":0.25,"maxBudgetUsd":5}\n\n`,
  `data: {"type":"compacting"}\n\n`,
  `data: {"type":"message_complete","reason":"max_turns","costUsd":0.5,"maxBudgetUsd":5,"objectiveComplete":true}\n\n`,
];

/** Drive the route to the point where it is listening, then replay the run. */
async function runNewMessage(headers: IncomingHttpHeaders = {}): Promise<FakeRes> {
  const f = fakeResponse();
  const req = {
    headers,
    // `folder` must exist on disk — the route 400s otherwise.
    body: { folder: process.cwd(), prompt: "hi" },
    on: () => {},
  } as unknown as Request;

  await newMessageHandler(req, f.res);
  for (const event of CANONICAL_NEW_CHAT_RUN) lastEmitter.emit("event", event);

  return f;
}

describe("POST /new/message — legacy client (no handshake) is unaffected", () => {
  it("writes the same SSE headers as before", async () => {
    const f = await runNewMessage();

    expect(f.head).toEqual({
      status: 200,
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  });

  it("sends server_info first, ahead of chat_created", async () => {
    const f = await runNewMessage();

    expect(f.chunks[0].startsWith("event: server_info\ndata: ")).toBe(true);
    expect(f.chunks[1]).toContain(`"type":"chat_created"`);
  });

  it("writes the exact frame bytes a pre-handshake client already parsed", async () => {
    const f = await runNewMessage();

    expect(f.chunks.slice(1)).toEqual(EXPECTED_NEW_CHAT_CHUNKS);
    expect(f.ended).toBe(true);
  });

  it("writes the identical frames whether or not the client handshakes", async () => {
    const legacy = await runNewMessage();
    const modern = await runNewMessage(handshakeAsReceived());

    // Nothing is gated yet: the advertised capabilities change no byte of the
    // stream, including the server_info frame itself.
    expect(modern.chunks).toEqual(legacy.chunks);
  });
});
