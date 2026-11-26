/**
 * `awaitingInput` on `GET /api/sessions/poll` — which chats are blocked on the
 * human, for the sidebar's yellow dot. Rides with `sessions` under the session
 * version, so these assert that a pending-request change moves that version
 * and that the steady state stays silent.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

// DATA_DIR is read when utils/paths.js first loads — set it before importing.
const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-awaiting-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;
const chatsDir = join(tmpRoot, "chats");
mkdirSync(chatsDir, { recursive: true });
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

// chat-lineage imports claude.js (heavy) only for hasPendingRequest.
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false }));

const { sessionsRouter } = await import("./sessions.js");
const { sessionRegistry } = await import("../services/session-registry.js");
const { clearOpenApprovalsForTest, openHumanApproval, pendingRequests } = await import("../services/pending-requests.js");

function writeChat(id: string, metadata: Record<string, unknown> = {}) {
  const chat = {
    id,
    folder: "/tmp/repo",
    session_id: `session-${id}`,
    session_log_path: null,
    metadata: JSON.stringify(metadata),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(join(chatsDir, `session-${id}.json`), JSON.stringify(chat));
}

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
  pendingRequests.delete("job-step");
  clearOpenApprovalsForTest();
  sessionRegistry.unregister(CHAT);
});

describe("GET /api/sessions/poll — awaitingInput", () => {
  it("comes with sessions on a first poll", async () => {
    const body = await poll({});
    expect(body.sessions).toBeDefined();
    expect(body.awaitingInput).toEqual([]);
    expect(body.awaitingBelow).toEqual([]);
  });

  it("is absent when the client already has this session version", async () => {
    const { version } = await poll({});
    const body = await poll({ v: String(version) });
    expect(body).not.toHaveProperty("sessions");
    expect(body).not.toHaveProperty("awaitingInput");
    expect(body).not.toHaveProperty("awaitingBelow");
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

  it("names every ancestor of a waiting chat in awaitingBelow — even one the list never shows", async () => {
    // root ← mid ← job-step (a triggered chat the sidebar filters out).
    writeChat("root");
    writeChat("mid", { parentChatId: "root", rootChatId: "root" });
    writeChat("job-step", { parentChatId: "mid", rootChatId: "root", triggered: true });
    const before = await poll({});
    pendingRequests.set("job-step", blocking());
    const raised = await poll({ v: String(before.version) });
    expect(raised.awaitingInput).toEqual(["job-step"]);
    expect(raised.awaitingBelow).toEqual(["mid", "root"]);

    pendingRequests.delete("job-step");
    const answered = await poll({ v: String(raised.version) });
    expect(answered.awaitingBelow).toEqual([]);
  });

  it("follows a stamped root when the chain has no parent pointer (a job-step chat)", async () => {
    writeChat("run-root");
    writeChat("orphan-step", { rootChatId: "run-root" });
    const before = await poll({});
    pendingRequests.set("orphan-step", blocking());
    const raised = await poll({ v: String(before.version) });
    expect(raised.awaitingBelow).toEqual(["run-root"]);
    pendingRequests.delete("orphan-step");
  });
});
