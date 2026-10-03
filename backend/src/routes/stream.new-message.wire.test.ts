/**
 * Exhaustive byte capture for `POST /api/chats/new/message`.
 *
 * `stream.new-message.test.ts` pins one canonical run. This file drives every
 * branch of the route's event forwarder — chat_created, every pass-through
 * type, the payload-carrying optional fields, both terminal frames, events
 * arriving after the terminal frame, and a client disconnect — and pins the
 * complete chunk sequence (headers, server_info, data frames, end) against
 * hand-written literals.
 *
 * It was written against the route's former inline copy of `createSSEHandler`
 * and passed there unchanged, so it is the proof that folding the route onto
 * the shared handler did not move a byte.
 */
import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { Request, Response } from "express";
import type { StreamEvent } from "../services/claude.js";

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
const { buildServerInfo } = await import("../services/stream-session.js");

const newMessageHandler = (streamRouter as any).stack.find((layer: any) => layer.route?.path === "/new/message" && layer.route.methods.post).route
  .stack[0].handle as (req: Request, res: Response) => Promise<void>;

/** Every call against the fake response, in order — headers, writes and end share one log. */
type Op = { op: "head"; status: number; headers: Record<string, string> } | { op: "write"; chunk: string } | { op: "end" };

async function drive(events: StreamEvent[], opts: { closeAfter?: number } = {}) {
  const ops: Op[] = [];
  const closeHandlers: Array<() => void> = [];
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      ops.push({ op: "head", status, headers });
      return this;
    },
    write(chunk: string) {
      ops.push({ op: "write", chunk });
      return true;
    },
    end() {
      ops.push({ op: "end" });
      return this;
    },
  } as unknown as Response;
  const req = {
    headers: {},
    body: { folder: process.cwd(), prompt: "hi" },
    on: (name: string, fn: () => void) => {
      if (name === "close") closeHandlers.push(fn);
    },
  } as unknown as Request;

  await newMessageHandler(req, res);
  events.forEach((event, i) => {
    if (opts.closeAfter === i) closeHandlers.forEach((fn) => fn());
    lastEmitter.emit("event", event);
  });
  return { ops, listeners: lastEmitter.listenerCount("event") };
}

const HEAD: Op = { op: "head", status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } };
const serverInfo = (): Op => ({ op: "write", chunk: `event: server_info\ndata: ${JSON.stringify(buildServerInfo())}\n\n` });
const data = (json: string): Op => ({ op: "write", chunk: `data: ${json}\n\n` });

const ev = (e: Record<string, unknown>) => ({ content: "", ...e }) as unknown as StreamEvent;

describe("POST /new/message — full SSE byte stream", () => {
  it("forwards every branch, then ends on done and ignores anything after", async () => {
    const { ops, listeners } = await drive([
      ev({ type: "text", content: "before created" }),
      ev({ type: "chat_created", chatId: "c-1", chat: { id: "c-1", folder: "/x", metadata: '{"a":1}' }, extra: "dropped" }),
      ev({ type: "thinking", content: "hm" }),
      ev({ type: "tool_use", toolName: "Read" }),
      ev({ type: "tool_result", content: "ok" }),
      ev({ type: "control_request_result", controlRequestResult: { subtype: "set_model", ok: true } }),
      ev({ type: "permission_request", toolName: "Bash", input: { command: "ls" }, requestId: "r1" }),
      ev({ type: "user_question", questions: [{ q: "?" }] }),
      ev({ type: "plan_review", plan: "do it" }),
      ev({ type: "compacting", extra: 1 }),
      ev({ type: "cleared", extra: 1 }),
      ev({ type: "budget", costUsd: 0.1, maxBudgetUsd: 2 }),
      ev({ type: "budget" }),
      ev({ type: "chat_created", chatId: "c-2", chat: undefined }),
      ev({ type: "done", reason: "max_turns", costUsd: 0, maxBudgetUsd: 3, objectiveComplete: false, abandonedBackgroundTaskIds: ["t1", "t2"] }),
      ev({ type: "text", content: "after done" }),
      ev({ type: "done" }),
    ]);

    expect(ops).toEqual([
      HEAD,
      serverInfo(),
      data(`{"type":"message_update"}`),
      data(`{"type":"chat_created","chatId":"c-1","chat":{"id":"c-1","folder":"/x","metadata":"{\\"a\\":1}"}}`),
      data(`{"type":"message_update"}`),
      data(`{"type":"message_update"}`),
      data(`{"type":"message_update"}`),
      data(`{"type":"message_update","controlRequestResult":{"subtype":"set_model","ok":true}}`),
      data(`{"content":"","type":"permission_request","toolName":"Bash","input":{"command":"ls"},"requestId":"r1"}`),
      data(`{"content":"","type":"user_question","questions":[{"q":"?"}]}`),
      data(`{"content":"","type":"plan_review","plan":"do it"}`),
      data(`{"type":"compacting"}`),
      data(`{"type":"cleared"}`),
      data(`{"type":"budget","costUsd":0.1,"maxBudgetUsd":2}`),
      data(`{"type":"budget"}`),
      data(`{"type":"chat_created","chatId":"c-2"}`),
      data(`{"type":"message_complete","reason":"max_turns","costUsd":0,"maxBudgetUsd":3,"objectiveComplete":false,"abandonedBackgroundTaskIds":["t1","t2"]}`),
      { op: "end" },
    ]);
    expect(listeners).toBe(0);
  });

  it("ends on error, with and without abandoned tasks, and detaches", async () => {
    const withTasks = await drive([
      ev({ type: "chat_created", chatId: "c-1", chat: { id: "c-1" } }),
      ev({ type: "error", content: "boom", abandonedBackgroundTaskIds: ["t1"] }),
      ev({ type: "text" }),
    ]);
    expect(withTasks.ops).toEqual([
      HEAD,
      serverInfo(),
      data(`{"type":"chat_created","chatId":"c-1","chat":{"id":"c-1"}}`),
      data(`{"type":"message_error","content":"boom","abandonedBackgroundTaskIds":["t1"]}`),
      { op: "end" },
    ]);
    expect(withTasks.listeners).toBe(0);

    const bare = await drive([ev({ type: "error", content: "x", abandonedBackgroundTaskIds: [] }), ev({ type: "done", reason: "" })]);
    expect(bare.ops).toEqual([HEAD, serverInfo(), data(`{"type":"message_error","content":"x"}`), { op: "end" }]);
  });

  it("a bare done omits every optional field", async () => {
    const { ops } = await drive([ev({ type: "done", reason: "", abandonedBackgroundTaskIds: [] })]);
    expect(ops).toEqual([HEAD, serverInfo(), data(`{"type":"message_complete"}`), { op: "end" }]);
  });

  it("stops forwarding (without ending) once the client disconnects", async () => {
    const { ops, listeners } = await drive([ev({ type: "chat_created", chatId: "c-1", chat: { id: "c-1" } }), ev({ type: "text" }), ev({ type: "done" })], {
      closeAfter: 1,
    });
    expect(ops).toEqual([HEAD, serverInfo(), data(`{"type":"chat_created","chatId":"c-1","chat":{"id":"c-1"}}`)]);
    expect(listeners).toBe(0);
  });
});
