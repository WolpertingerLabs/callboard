/**
 * Who may answer a computer-control confirmation — the prompt a chat set to
 * `computerControl: "ask"` raises before every GUI action.
 *
 * The gate moved from `POST /api/computer-use/:chatId/:sessionId/approve` —
 * which carries `requireSessionAuth` + `requireControlOrigin` under the comment
 * "This control plane is for the signed-in human, never an agent API key" — to
 * `POST /api/chats/:id/respond`, which sits under `requireAuth` and happily
 * accepts a Bearer `cbk_` key. Moving the gate must not weaken it: an agent
 * that has got hold of an API key must not be able to confirm its own GUI
 * action, which is the entire point of the prompt an `ask` chat raises after
 * chat policy has already admitted the tool call.
 *
 * Ordinary tool permissions are deliberately NOT affected: answering "may I run
 * Bash" over the API is a supported, documented workflow, and the only in-repo
 * consumer of this route (`respondToChat` in frontend/src/api.ts) is unchanged
 * either way.
 *
 * Handler pulled off the router stack and driven with a fake req/res, matching
 * the no-supertest style of stream.new-message.test.ts.
 */
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import type { Request, Response } from "express";

// `claude.js` re-exports the pending-prompt registry; hand the route the REAL
// one so this exercises the actual `humanOnly` flag rather than a stub's idea
// of it. Everything else on that module is irrelevant here.
vi.mock("../services/claude.js", async () => {
  const real = await import("../services/pending-requests.js");
  return {
    sendMessage: async () => new EventEmitter(),
    getActiveSession: (id: string) => sessionRegistry.get(id),
    stopSession: () => false,
    respondToPermission: real.respondToPermission,
    hasPendingRequest: real.hasPendingRequest,
    getPendingRequest: real.getPendingRequest,
  };
});

const { pendingRequests, requestHumanApproval, hasPendingRequest } = await import("../services/pending-requests.js");
const { sessionRegistry } = await import("../services/session-registry.js");
const { streamRouter } = await import("./stream.js");

const CHAT = "respond-auth-chat";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const respondHandler = (streamRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/respond" && layer.route.methods.post).route.stack[0]
  .handle as (req: Request, res: Response) => Promise<unknown>;

function fakeRequest(headers: Record<string, string>): Request {
  return {
    params: { id: CHAT },
    body: { allow: true, requestId: pendingRequests.get(CHAT)?.requestId },
    get: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

function fakeResponse(authMethod?: string) {
  const state = { status: 200, body: undefined as unknown };
  const res = {
    locals: { authMethod },
    status(code: number) {
      state.status = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
  } as unknown as Response;
  return { res, state };
}

/** A browser POSTing from the app's own origin. */
const sameOrigin = { origin: "http://localhost:8000", host: "localhost:8000" };

function respond(authMethod: string | undefined, headers: Record<string, string> = sameOrigin) {
  const { res, state } = fakeResponse(authMethod);
  respondHandler(fakeRequest(headers), res);
  return state;
}

function liveChat() {
  const emitter = new EventEmitter();
  emitter.on("event", () => {});
  sessionRegistry.register(CHAT, { type: "web", abortController: new AbortController(), emitter });
}

afterEach(() => {
  pendingRequests.delete(CHAT);
  sessionRegistry.unregister(CHAT);
});

it("refuses an API key for a computer-control confirmation, and leaves the agent still blocked", async () => {
  liveChat();
  const approval = requestHumanApproval(CHAT, { toolName: "mcp__computer_use__cu_action", input: { summary: "Click at (1, 2)" }, timeoutMs: 60_000 });

  const state = respond("bearer");

  expect(state.status).toBe(403);
  expect(state.body).toMatchObject({ code: "denied", error: expect.stringContaining("not an API key") });
  // Refused, not consumed: the human can still answer it.
  expect(hasPendingRequest(CHAT)).toBe(true);
  const settled = await Promise.race([approval, Promise.resolve("still-blocked")]);
  expect(settled).toBe("still-blocked");
});

it("refuses a cross-site POST for a computer-control confirmation even with a real session", async () => {
  liveChat();
  const approval = requestHumanApproval(CHAT, { toolName: "mcp__computer_use__cu_action", input: { summary: "Click at (1, 2)" }, timeoutMs: 60_000 });

  expect(respond("session", { origin: "http://evil.example", host: "localhost:8000" })).toMatchObject({ status: 403, body: { code: "denied" } });
  expect(respond("session", { host: "localhost:8000" })).toMatchObject({ status: 403 }); // no Origin at all
  expect(respond("session", { ...sameOrigin, "sec-fetch-site": "cross-site" })).toMatchObject({ status: 403 });

  expect(hasPendingRequest(CHAT)).toBe(true);
  expect(await Promise.race([approval, Promise.resolve("still-blocked")])).toBe("still-blocked");
});

it("accepts the signed-in, same-origin human — the one actor that may confirm", async () => {
  liveChat();
  const approval = requestHumanApproval(CHAT, { toolName: "mcp__computer_use__cu_action", input: { summary: "Click at (1, 2)" }, timeoutMs: 60_000 });

  expect(respond("session")).toMatchObject({ status: 200, body: { ok: true, toolName: "mcp__computer_use__cu_action" } });
  await expect(approval).resolves.toEqual({ approved: true, reason: "human" });
});

it("still lets an API key answer an ordinary tool permission, from anywhere", async () => {
  // What `buildCanUseTool` parks: no `humanOnly`, so the route's long-standing
  // contract is untouched.
  const answered = new Promise<unknown>((resolve) => {
    pendingRequests.set(CHAT, {
      toolName: "Bash",
      input: { command: "ls" },
      eventType: "permission_request",
      eventData: { toolName: "Bash", input: { command: "ls" } },
      resolve,
    });
  });

  expect(respond("bearer", { origin: "http://somewhere.else", host: "localhost:8000" })).toMatchObject({ status: 200, body: { ok: true, toolName: "Bash" } });
  await expect(answered).resolves.toMatchObject({ behavior: "allow" });
});

it("requires a matching identity and boolean without consuming a human prompt", async () => {
  liveChat();
  const approval = requestHumanApproval(CHAT, { toolName: "mcp__computer_use__cu_request_control", input: { kind: "browser" } });
  for (const body of [{ allow: true }, { allow: true, requestId: "stale-id" }, { allow: "true", requestId: pendingRequests.get(CHAT)?.requestId }]) {
    const req = fakeRequest(sameOrigin);
    req.body = body;
    const { res, state } = fakeResponse("session");
    respondHandler(req, res);
    expect(state.status).toBe(body.allow === "true" ? 400 : 409);
    expect(hasPendingRequest(CHAT)).toBe(true);
  }
  expect(respond("session").status).toBe(200);
  await expect(approval).resolves.toMatchObject({ approved: true });
});

it("a stale tab cannot answer a replacement prompt and a second tab cannot redeem an answer twice", async () => {
  liveChat();
  const first = requestHumanApproval(CHAT, { toolName: "first", input: {} });
  const oldRequest = fakeRequest(sameOrigin);
  expect(respond("session").status).toBe(200);
  await first;
  const second = requestHumanApproval(CHAT, { toolName: "second", input: {} });
  const { res, state } = fakeResponse("session");
  respondHandler(oldRequest, res);
  expect(state.status).toBe(409);
  expect(hasPendingRequest(CHAT)).toBe(true);
  expect(respond("session").status).toBe(200);
  await second;
  expect(respond("session").status).toBe(404);
});

it.each([true, false])("respond waits for actual host startup (success=%s), without serializing the completion promise", async (ok) => {
  liveChat();
  let complete!: (result: { ok: boolean; error?: string }) => void;
  const completion = new Promise<{ ok: boolean; error?: string }>((resolve) => {
    complete = resolve;
  });
  const approval = requestHumanApproval(CHAT, {
    toolName: "mcp__computer_use__cu_request_control",
    controlRequest: true,
    input: { kind: "browser" },
    completion,
  });
  const { getPendingRequest } = await import("../services/pending-requests.js");
  expect(getPendingRequest(CHAT)).not.toHaveProperty("completion");
  const { res, state } = fakeResponse("session");
  const response = respondHandler(fakeRequest(sameOrigin), res);
  await expect(approval).resolves.toMatchObject({ approved: true });
  expect(state.body).toBeUndefined();
  complete(ok ? { ok: true } : { ok: false, error: "Startup failed; request fresh consent" });
  await response;
  expect(state.status).toBe(ok ? 200 : 409);
  expect(state.body).toMatchObject(ok ? { ok: true } : { ok: false, error: "Startup failed; request fresh consent" });
});

it("legacy pending replay requests reload without an answerable card; upgraded replay redeems the same prompt", async () => {
  liveChat();
  const approval = requestHumanApproval(CHAT, { toolName: "mcp__computer_use__cu_action", input: { summary: "Click" } });
  const { handshakeHeaders } = await import("shared/types/index.js");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (streamRouter as any).stack.find((l: any) => l.route?.path === "/:id/pending").route.stack[0].handle;
  const oldRes = fakeResponse("session");
  handler({ params: { id: CHAT }, headers: {} }, oldRes.res);
  expect(oldRes.state.body).toMatchObject({ pending: null, reloadRequired: expect.stringContaining("Reload this Callboard tab") });
  const legacyReply = fakeRequest(sameOrigin);
  legacyReply.body = { allow: true }; // exactly what the old optimistic frontend sends
  const replyRes = fakeResponse("session");
  await respondHandler(legacyReply, replyRes.res);
  expect(replyRes.state.status).toBe(409);
  expect(hasPendingRequest(CHAT)).toBe(true);
  const modernRes = fakeResponse("session");
  handler({ params: { id: CHAT }, headers: Object.fromEntries(Object.entries(handshakeHeaders()).map(([k, v]) => [k.toLowerCase(), v])) }, modernRes.res);
  expect(modernRes.state.body).toMatchObject({ pending: { toolName: "mcp__computer_use__cu_action", requestId: pendingRequests.get(CHAT)?.requestId } });
  expect(respond("session").status).toBe(200);
  await expect(approval).resolves.toMatchObject({ approved: true });
});
it.each([true, false])("a delayed human-only %s reply cannot consume an ordinary replacement over HTTP", async (allow) => {
  liveChat();
  const consent = requestHumanApproval(CHAT, { toolName: "mcp__computer_use__cu_request_control", input: {} });
  const staleId = pendingRequests.get(CHAT)!.requestId;
  respond("session");
  await consent;
  const resolve = vi.fn();
  pendingRequests.set(CHAT, { toolName: "Bash", input: { command: "never run" }, eventType: "permission_request", eventData: {}, resolve });
  const req = fakeRequest(sameOrigin);
  req.body = { allow, requestId: staleId };
  const { res, state } = fakeResponse("session");
  await respondHandler(req, res);
  expect(state.status).toBe(409);
  expect(resolve).not.toHaveBeenCalled();
  expect(hasPendingRequest(CHAT)).toBe(true);
  req.body = { allow: false };
  await respondHandler(req, res);
  expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ behavior: "deny" }));
});

// Equivalent to the reviewer's already-blocked-chat reproduction: the prompt
// predates attachment, so future-event forwarding alone cannot recover it.
function attachStream(headers: Record<string, string> = {}) {
  const req = Object.assign(new EventEmitter(), { params: { id: CHAT }, headers });
  const chunks: string[] = [];
  const res = { writeHead: vi.fn(), write: (chunk: string) => chunks.push(chunk), end: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handler = (streamRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/stream").route.stack[0].handle;
  handler(req, res);
  return { chunks, res, close: () => req.emit("close") };
}
const controlTools = ["mcp__computer_use__cu_action", "mcp__computer_use__cu_request_control"];
it.each(controlTools)("legacy attachment recovers already-pending %s without an answerable card", async (toolName) => {
  liveChat();
  const approval = requestHumanApproval(CHAT, { toolName, input: { summary: "Click" } });
  const stream = attachStream();
  try {
    const wire = stream.chunks.join("");
    expect(wire).toContain("Reload this Callboard tab");
    expect(wire).not.toContain('"type":"permission_request"');
    expect(wire.match(/Reload this Callboard tab/g)).toHaveLength(1);
    expect(stream.res.end).not.toHaveBeenCalled();
    expect(hasPendingRequest(CHAT)).toBe(true);
  } finally {
    stream.close();
    respond("session");
    await approval;
  }
});
it.each(controlTools)("capable reconnect recovers %s via REST without duplicate SSE cards", async (toolName) => {
  const { handshakeHeaders } = await import("shared/types/index.js");
  liveChat();
  const approval = requestHumanApproval(CHAT, { toolName, input: { summary: "Click" } });
  const headers = Object.fromEntries(Object.entries(handshakeHeaders()).map(([key, value]) => [key.toLowerCase(), value]));
  const identity = pendingRequests.get(CHAT)!.requestId;
  for (let connection = 0; connection < 2; connection++) {
    const stream = attachStream(headers);
    try {
      expect(stream.chunks).toHaveLength(1); // server_info only
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (streamRouter as any).stack.find((layer: any) => layer.route?.path === "/:id/pending").route.stack[0].handle;
      const replay = fakeResponse("session");
      handler({ params: { id: CHAT }, headers }, replay.res);
      expect(replay.state.body).toMatchObject({ pending: { toolName, requestId: identity, humanOnly: true } });
    } finally {
      stream.close();
    }
  }
  respond("session");
  await expect(approval).resolves.toMatchObject({ approved: true });
});
it.each([false, true])("attachment (capable=%s) preserves ordinary REST replies and forwards future prompts", async (capable) => {
  const { handshakeHeaders } = await import("shared/types/index.js");
  liveChat();
  const resolve = vi.fn();
  pendingRequests.set(CHAT, { toolName: "Bash", input: {}, eventType: "permission_request", eventData: { toolName: "Bash", input: {} }, resolve });
  const headers = capable ? Object.fromEntries(Object.entries(handshakeHeaders()).map(([key, value]) => [key.toLowerCase(), value])) : {};
  const stream = attachStream(headers);
  try {
    expect(stream.chunks).toHaveLength(1); // no duplicate/reset of the REST card
    expect(respond("bearer")).toMatchObject({ status: 200 });
    expect(resolve).toHaveBeenCalled();
    sessionRegistry.get(CHAT)!.emitter!.emit("event", { type: "user_question", questions: [{ question: "Next question" }], content: "" });
    expect(stream.chunks.join("")).toContain("Next question");
  } finally {
    stream.close();
  }
});
it("a prompt created synchronously while subscribing is recovered after subscription", async () => {
  liveChat();
  const emitter = sessionRegistry.get(CHAT)!.emitter!;
  let approval: ReturnType<typeof requestHumanApproval> | undefined;
  emitter.once("newListener", () => {
    approval = requestHumanApproval(CHAT, { toolName: controlTools[0], input: {} });
  });
  const stream = attachStream();
  try {
    expect(stream.chunks.join("")).toContain("Reload this Callboard tab");
    expect(hasPendingRequest(CHAT)).toBe(true);
  } finally {
    stream.close();
    respond("session");
    await approval;
  }
});
