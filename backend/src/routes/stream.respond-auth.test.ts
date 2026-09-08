/**
 * Who may answer a computer-control confirmation.
 *
 * The gate moved from `POST /api/computer-use/:chatId/:sessionId/approve` —
 * which carries `requireSessionAuth` + `requireControlOrigin` under the comment
 * "This control plane is for the signed-in human, never an agent API key" — to
 * `POST /api/chats/:id/respond`, which sits under `requireAuth` and happily
 * accepts a Bearer `cbk_` key. Moving the gate must not weaken it: an agent
 * that has got hold of an API key must not be able to confirm its own GUI
 * action, which is the entire point of a second gate that runs after chat
 * policy has already said yes.
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
    getActiveSession: () => null,
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
  .handle as (req: Request, res: Response) => void;

function fakeRequest(headers: Record<string, string>): Request {
  return {
    params: { id: CHAT },
    body: { allow: true },
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
