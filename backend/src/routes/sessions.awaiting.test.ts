/**
 * `awaitingInput` on `GET /api/sessions/poll` — which chats are blocked on the
 * human, for the sidebar's yellow dot. Rides with `sessions` under the session
 * version, so these assert that a pending-request change moves that version
 * and that the steady state stays silent.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { sessionsRouter } from "./sessions.js";
import { sessionRegistry } from "../services/session-registry.js";
import { clearOpenApprovalsForTest, openHumanApproval, pendingRequests } from "../services/pending-requests.js";

const pollHandler = (sessionsRouter as any).stack.find((layer: any) => layer.route?.path === "/poll" && layer.route.methods.get).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function poll(query: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve) => {
    const res = {
      json(payload: any) {
        resolve(payload);
        return this;
      },
    };
    pollHandler({ query } as unknown as Request, res as unknown as Response);
  });
}

const CHAT = "awaiting-chat";
const blocking = () => ({ toolName: "Bash", input: {}, eventType: "permission_request" as const, eventData: {}, resolve: () => {} });

afterEach(() => {
  pendingRequests.delete(CHAT);
  clearOpenApprovalsForTest();
  sessionRegistry.unregister(CHAT);
});

describe("GET /api/sessions/poll — awaitingInput", () => {
  it("comes with sessions on a first poll", async () => {
    const body = await poll({});
    expect(body.sessions).toBeDefined();
    expect(body.awaitingInput).toEqual([]);
  });

  it("is absent when the client already has this session version", async () => {
    const { version } = await poll({});
    const body = await poll({ v: String(version) });
    expect(body).not.toHaveProperty("sessions");
    expect(body).not.toHaveProperty("awaitingInput");
  });

  it("is resent when a running chat raises a prompt, and again when it is answered", async () => {
    sessionRegistry.register(CHAT, { type: "web" });
    const before = await poll({});
    expect(before.awaitingInput).toEqual([]);

    pendingRequests.set(CHAT, blocking());
    const raised = await poll({ v: String(before.version) });
    expect(raised.version).not.toBe(before.version);
    expect(raised.sessions).toHaveProperty(CHAT);
    expect(raised.awaitingInput).toEqual([CHAT]);

    pendingRequests.delete(CHAT);
    const answered = await poll({ v: String(raised.version) });
    expect(answered.awaitingInput).toEqual([]);
  });

  it("names a chat with only an open approval — no run behind it", async () => {
    const before = await poll({});
    openHumanApproval(CHAT, { toolName: "mcp__computer_use__cu_action", input: {} }, () => {});
    const body = await poll({ v: String(before.version) });
    expect(body.sessions).not.toHaveProperty(CHAT);
    expect(body.awaitingInput).toEqual([CHAT]);
  });
});
