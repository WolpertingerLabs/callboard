/**
 * POST /api/chats/:id/rerun — over a real (temp-dir) chat store with stub
 * session providers and a stub sendMessage, so the tree the route leaves
 * behind is read back through the real lineage code.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-rerun-route-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const running = vi.hoisted(() => new Set<string>());
const calls = vi.hoisted(() => ({ fork: [] as unknown[][], seed: [] as unknown[][], send: [] as any[], deleted: [] as string[] }));
const sendBehaviour = vi.hoisted(() => ({ throwOnExisting: null as Error | null, freshEvent: "chat_created" as "chat_created" | "error" }));

vi.mock("../services/list-caches.js", () => ({ clearListCaches: () => {} }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: (id: string) => running.has(id), notifyMetadata: () => {} } }));
vi.mock("../services/claude.js", async () => {
  const { chatFileService } = await import("../services/chat-file-service.js");
  return {
    getActiveSession: () => null,
    hasPendingRequest: () => false,
    getPendingRequest: () => null,
    sendMessage: async (opts: any) => {
      calls.send.push(opts);
      const emitter = new EventEmitter();
      if (opts.chatId) {
        if (sendBehaviour.throwOnExisting) throw sendBehaviour.throwOnExisting;
        return emitter;
      }
      // A new chat: the record appears when the harness reports its session,
      // filed by the new-chat rules (here: a folder-rule space).
      setTimeout(() => {
        if (sendBehaviour.freshEvent === "error") return void emitter.emit("event", { type: "error", content: "bad key" });
        const sid = `fresh-${Math.random().toString(36).slice(2)}`;
        const meta = {
          session_ids: [sid],
          spaceId: "folder-space",
          ...(opts.provider !== "claude-code" && { provider: opts.provider }),
          ...(opts.chatTitle && { title: opts.chatTitle }),
          ...(opts.parentChatId && { parentChatId: opts.parentChatId }),
        };
        chatFileService.upsertChat(sid, opts.folder, sid, { metadata: JSON.stringify(meta) });
        emitter.emit("event", { type: "chat_created", chatId: sid, content: "" });
      }, 0);
      return emitter;
    },
  };
});

const t = (s: number, ms = 0) => new Date(Date.UTC(2026, 0, 1, 10, 0, s, ms)).toISOString();
const history: Record<string, unknown>[] = [
  { role: "user", type: "text", content: "q1", timestamp: t(0) },
  { role: "assistant", type: "text", content: "a1", timestamp: t(1) },
  { role: "user", type: "text", content: "q2", timestamp: t(10) },
  { role: "assistant", type: "tool_use", content: "{}", toolName: "Bash", timestamp: t(11) },
  { role: "user", type: "tool_result", content: "ok", timestamp: t(12) },
  { role: "assistant", type: "text", content: "a2", timestamp: t(13) },
];
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      forkSession: (...args: unknown[]) => (calls.fork.push(args), { logPath: "/tmp/x.jsonl" }),
      parseSessionMessages: () => history,
      getSessionPreview: () => "preview",
      deleteSessionFiles: (sid: string) => calls.deleted.push(sid),
    },
    {
      // No native fork: the history goes through flattened turns + seedSession.
      kind: "codex",
      seedSession: (...args: unknown[]) => (calls.seed.push(args), { logPath: "/tmp/y.jsonl" }),
      parseSessionMessages: () => history,
      getSessionPreview: () => "preview",
      deleteSessionFiles: () => {},
    },
  ],
  getSessionProvider: () => null,
}));

const { chatsRouter } = await import("./chats.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { buildChatTree } = await import("../services/chat-lineage.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function handler(path: string) {
  return (chatsRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post).route.stack[0].handle as (
    req: Request,
    res: Response,
  ) => unknown;
}
function rerun(id: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      on() {},
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    void handler("/:id/rerun")({ query: {}, params: { id }, body } as unknown as Request, res as unknown as Response);
  });
}

function makeChat(meta: Record<string, unknown> = {}) {
  return chatFileService.createChat("/repos/rerun-route", `s-${Math.random().toString(36).slice(2)}`, JSON.stringify(meta));
}
const metaOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata);

afterEach(() => {
  for (const chat of chatFileService.getAllChats()) chatFileService.deleteChat(chat.session_id);
  running.clear();
  calls.fork.length = calls.seed.length = calls.send.length = calls.deleted.length = 0;
  sendBehaviour.throwOnExisting = null;
  sendBehaviour.freshEvent = "chat_created";
});

describe("POST /:id/rerun", () => {
  it("on a user prompt: forks strictly before it, supersedes, and sends the prompt to the new chat", async () => {
    const chat = makeChat({
      title: "Work",
      model: "opus",
      defaultPermissions: { fileRead: "allow" },
      starredMessages: ["assistant@" + t(1) + "#0", "user@" + t(10) + "#0"],
    });
    const res = await rerun(chat.id, { timestamp: t(10), role: "user", expectedParentChatId: null });
    expect(res.status).toBe(201);
    const n = res.body.chat;
    expect(res.body.prompt).toBe(t(10));
    expect(res.body.runError).toBeUndefined();
    // History strictly before q2: the providers' cutoff is inclusive, in ms.
    expect(calls.fork).toHaveLength(1);
    expect(calls.fork[0]![1]).toBe(t(9, 999));
    expect(calls.send).toEqual([{ chatId: n.id, prompt: "q2" }]);
    // In the original's place; the original is a superseded child forked at the last kept message.
    expect(metaOf(n.id)).toMatchObject({
      title: "Work",
      model: "opus",
      defaultPermissions: { fileRead: "allow" },
      supersedes: { chatId: chat.id, kind: "rerun", at: t(1) },
    });
    expect(metaOf(n.id).starredMessages).toEqual(["assistant@" + t(1) + "#0"]);
    expect(metaOf(chat.id)).toMatchObject({ parentChatId: n.id, chatRole: "superseded", forkedAt: t(1), title: "Original: Work" });
    expect(buildChatTree(chat.id)!.rootChatId).toBe(n.id);
  });

  it("on an assistant message: reruns the user prompt it answers, not a tool result", async () => {
    const chat = makeChat({ provider: "codex", model: "gpt-5.5" });
    const res = await rerun(chat.id, { timestamp: t(13), role: "assistant" });
    expect(res.status).toBe(201);
    expect(res.body.prompt).toBe(t(10));
    expect(calls.send[0]).toMatchObject({ chatId: res.body.chat.id, prompt: "q2" });
    // Codex has no native fork: the seeded history ends before q2.
    const turns = calls.seed[0]![0] as { role: string; text: string }[];
    expect(turns.map((x) => x.text).slice(-2)).toEqual(["q1", "a1"]);
    expect(metaOf(res.body.chat.id)).toMatchObject({ provider: "codex", model: "gpt-5.5" });
  });

  it("keeps the child's slot under its parent", async () => {
    const parent = makeChat({});
    const chat = makeChat({ parentChatId: parent.id, rootChatId: parent.id, chatRole: "subagent", forkedAt: t(5) });
    const res = await rerun(chat.id, { timestamp: t(10) });
    expect(res.status).toBe(201);
    expect(metaOf(res.body.chat.id)).toMatchObject({ parentChatId: parent.id, rootChatId: parent.id, chatRole: "subagent", forkedAt: t(5) });
    expect(metaOf(chat.id)).toMatchObject({ parentChatId: res.body.chat.id, rootChatId: parent.id, chatRole: "superseded" });
  });

  it("the opening prompt: starts a fresh chat on the same settings and moves it into the original's place", async () => {
    const chat = makeChat({ title: "Opening", provider: "codex", model: "gpt-5.5", effort: "high", agentAlias: "forge", sidebarFolder: "f1", pinned: true });
    const res = await rerun(chat.id, { timestamp: t(1), role: "assistant" });
    expect(res.status).toBe(201);
    expect(calls.fork).toHaveLength(0);
    expect(calls.seed).toHaveLength(0);
    expect(calls.send[0]).toMatchObject({
      folder: "/repos/rerun-route",
      prompt: "q1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      agentAlias: "forge",
      chatTitle: "Opening",
      skipTitleGeneration: true,
    });
    const n = res.body.chat;
    expect(n.id).toBe(calls.send.length && chatFileService.getChat(n.id)!.id);
    const nMeta = metaOf(n.id);
    expect(nMeta).toMatchObject({ title: "Opening", provider: "codex", sidebarFolder: "f1", pinned: true, supersedes: { chatId: chat.id, kind: "rerun" } });
    // The space the new-chat path filed it under is not C's: dropped.
    expect(nMeta).not.toHaveProperty("spaceId");
    expect(metaOf(chat.id)).toMatchObject({ parentChatId: n.id, chatRole: "superseded", title: "Original: Opening" });
    expect(metaOf(chat.id)).not.toHaveProperty("pinned");
    expect(buildChatTree(chat.id)!.rootChatId).toBe(n.id);
  });

  it("the opening prompt: 502s and leaves the original alone when the fresh chat fails to start", async () => {
    sendBehaviour.freshEvent = "error";
    const chat = makeChat({ title: "Opening" });
    const res = await rerun(chat.id, { timestamp: t(0) });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("bad key");
    expect(metaOf(chat.id)).not.toHaveProperty("parentChatId");
  });

  it("reports a run that could not start beside the new chat, which is in place", async () => {
    sendBehaviour.throwOnExisting = new Error("effort not supported");
    const chat = makeChat({});
    const res = await rerun(chat.id, { timestamp: t(10) });
    expect(res.status).toBe(201);
    expect(res.body.runError).toBe("effort not supported");
    expect(metaOf(chat.id)).toMatchObject({ parentChatId: res.body.chat.id });
  });

  it("validates and refuses while streaming, for an invalid message, or a moved chat", async () => {
    const chat = makeChat({});
    expect((await rerun(chat.id, {})).status).toBe(400);
    expect((await rerun(chat.id, { timestamp: "not a date" })).status).toBe(400);
    expect((await rerun(chat.id, { timestamp: t(10), role: "system" })).status).toBe(400);
    expect((await rerun("nope", { timestamp: t(10) })).status).toBe(404);
    // No message there, and a tool result is not a prompt.
    expect((await rerun(chat.id, { timestamp: t(30) })).status).toBe(400);
    expect((await rerun(chat.id, { timestamp: t(12), role: "user" })).status).toBe(400);
    running.add(chat.id);
    const busy = await rerun(chat.id, { timestamp: t(10) });
    expect(busy.status).toBe(409);
    expect(busy.body.error).toMatch(/running/);
    running.clear();
    expect((await rerun(chat.id, { timestamp: t(10), expectedParentChatId: "someone-else" })).status).toBe(409);
    expect((await rerun(makeChat({ provider: "acp", acpProviderId: "x" }).id, { timestamp: t(10) })).status).toBe(400);
    // Nothing was written or sent for any refusal.
    expect(calls.fork).toHaveLength(0);
    expect(calls.send).toHaveLength(0);
  });
});
