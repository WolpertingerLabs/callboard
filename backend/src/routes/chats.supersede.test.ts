/**
 * POST /api/chats/:id/continue-from, /compress/preview and /compress — over a
 * real (temp-dir) chat store with stub session providers, so the tree the
 * routes leave behind is read back through the real lineage code.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-supersede-route-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const running = vi.hoisted(() => new Set<string>());
const calls = vi.hoisted(() => ({ fork: [] as unknown[][], compress: [] as unknown[][], seed: [] as unknown[][], completion: [] as any[] }));
const completionReply = vi.hoisted(() => ({ value: "THE SUMMARY" as string | Error }));

vi.mock("../services/list-caches.js", () => ({ clearListCaches: () => {} }));
vi.mock("../services/claude.js", () => ({ getActiveSession: () => null, hasPendingRequest: () => false, getPendingRequest: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: (id: string) => running.has(id), notifyMetadata: () => {} } }));
vi.mock("../services/chat-model-completion.js", () => ({
  runChatModelCompletion: async (opts: any) => {
    calls.completion.push(opts);
    if (completionReply.value instanceof Error) throw completionReply.value;
    return completionReply.value;
  },
}));

const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 10, 0, s)).toISOString();
const history = [
  { role: "user", type: "text", content: "q1", timestamp: t(0) },
  { role: "assistant", type: "text", content: "a1", timestamp: t(1) },
  { role: "user", type: "text", content: "q2", timestamp: t(10) },
  { role: "assistant", type: "text", content: "a2", timestamp: t(11) },
];
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      forkSession: (...args: unknown[]) => (calls.fork.push(args), { logPath: "/tmp/x.jsonl" }),
      compressSession: (...args: unknown[]) => (calls.compress.push(args), { logPath: "/tmp/x.jsonl" }),
      parseSessionMessages: () => history,
      getSessionPreview: () => "preview",
    },
    {
      // No native writer: compression goes through flattened turns + seedSession.
      kind: "codex",
      seedSession: (...args: unknown[]) => (calls.seed.push(args), { logPath: "/tmp/y.jsonl" }),
      parseSessionMessages: () => history,
      getSessionPreview: () => "preview",
    },
  ],
  getSessionProvider: () => null,
}));

const { chatsRouter } = await import("./chats.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { buildChatTree } = await import("../services/chat-lineage.js");

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

function handler(path: string) {
  return (chatsRouter as any).stack.find((l: any) => l.route?.path === path && l.route.methods.post).route.stack[0].handle as (req: Request, res: Response) => unknown;
}
function call(path: string, id: string, body: unknown): Promise<{ status: number; body: any }> {
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
    void handler(path)({ query: {}, params: { id }, body } as unknown as Request, res as unknown as Response);
  });
}

const created: string[] = [];
function makeChat(meta: Record<string, unknown> = {}) {
  const chat = chatFileService.createChat("/repos/supersede-route", `s-${Math.random().toString(36).slice(2)}`, JSON.stringify(meta));
  created.push(chat.session_id);
  return chat;
}
const metaOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata);

afterEach(() => {
  for (const chat of chatFileService.getAllChats()) chatFileService.deleteChat(chat.session_id);
  created.length = 0;
  running.clear();
  calls.fork.length = calls.compress.length = calls.seed.length = calls.completion.length = 0;
  completionReply.value = "THE SUMMARY";
});

describe("POST /:id/continue-from", () => {
  it("forks natively and puts the new chat in the original's place", async () => {
    const chat = makeChat({ title: "Work", model: "opus", defaultPermissions: { fileRead: "allow" }, agentAlias: "forge" });
    const res = await call("/:id/continue-from", chat.id, { timestamp: t(1) });
    expect(res.status).toBe(201);
    const n = res.body.chat;
    expect(calls.fork).toHaveLength(1);
    expect(calls.fork[0]![1]).toBe(t(1));
    expect(metaOf(n.id)).toMatchObject({ title: "Work", model: "opus", defaultPermissions: { fileRead: "allow" }, agentAlias: "forge" });
    expect(metaOf(n.id)).not.toHaveProperty("provider");
    expect(res.body.original).toMatchObject({ id: chat.id });
    expect(metaOf(chat.id)).toMatchObject({ parentChatId: n.id, chatRole: "superseded", forkedAt: t(1) });
    expect(buildChatTree(chat.id)!.rootChatId).toBe(n.id);
  });

  it("validates and refuses", async () => {
    const chat = makeChat({});
    expect((await call("/:id/continue-from", chat.id, {})).status).toBe(400);
    expect((await call("/:id/continue-from", chat.id, { timestamp: "not a date" })).status).toBe(400);
    expect((await call("/:id/continue-from", "nope", { timestamp: t(1) })).status).toBe(404);
    running.add(chat.id);
    expect((await call("/:id/continue-from", chat.id, { timestamp: t(1) })).status).toBe(409);
    running.clear();
    expect((await call("/:id/continue-from", makeChat({ provider: "openrouter" }).id, { timestamp: t(1) })).status).toBe(400);
    expect((await call("/:id/continue-from", makeChat({ provider: "acp", acpProviderId: "x" }).id, { timestamp: t(1) })).status).toBe(400);
    // Nothing was written for any refusal.
    expect(calls.fork).toHaveLength(0);
  });
});

describe("POST /:id/compress/preview", () => {
  it("summarises the right span on the chat's own provider and model", async () => {
    const chat = makeChat({ provider: "codex", model: "gpt-5.5", effort: "high" });
    const res = await call("/:id/compress/preview", chat.id, { timestamp: t(10), direction: "before" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ summary: "THE SUMMARY", chunks: 1, provider: "codex", model: "gpt-5.5" });
    expect(calls.completion[0]).toMatchObject({ provider: "codex", model: "gpt-5.5", effort: "high" });
    expect(calls.completion[0].prompt).toContain("User: q1");
    expect(calls.completion[0].prompt).not.toContain("User: q2");
    // Nothing is written by a preview.
    expect(chatFileService.getAllChats()).toHaveLength(1);
  });

  it("400s when there is nothing to compress, 502s when the model fails", async () => {
    const chat = makeChat({});
    expect((await call("/:id/compress/preview", chat.id, { timestamp: t(0), direction: "before" })).status).toBe(400);
    expect((await call("/:id/compress/preview", chat.id, { timestamp: t(11), direction: "after" })).status).toBe(400);
    expect((await call("/:id/compress/preview", chat.id, { timestamp: t(1), direction: "sideways" })).status).toBe(400);
    completionReply.value = new Error("rate limited");
    const failed = await call("/:id/compress/preview", chat.id, { timestamp: t(1), direction: "after" });
    expect(failed.status).toBe(502);
    expect(failed.body.error).toContain("rate limited");
  });
});

describe("POST /:id/compress", () => {
  it("writes natively on Claude Code and supersedes with the pre-compression role", async () => {
    const chat = makeChat({ title: "Long one" });
    const res = await call("/:id/compress", chat.id, { timestamp: t(10), direction: "before", summary: "  edited summary  " });
    expect(res.status).toBe(201);
    expect(calls.compress[0]![1]).toMatchObject({ cutoffTimestamp: t(10), direction: "before", summary: "edited summary" });
    expect(metaOf(res.body.chat.id)).toMatchObject({ title: "Long one", supersedes: { chatId: chat.id, kind: "compress-before" } });
    expect(metaOf(chat.id)).toMatchObject({ chatRole: "pre-compression", title: "Before compression: Long one", parentChatId: res.body.chat.id });
  });

  it("seeds flattened turns on a harness without a native writer", async () => {
    const chat = makeChat({ provider: "codex" });
    const res = await call("/:id/compress", chat.id, { timestamp: t(1), direction: "after", summary: "what happened later" });
    expect(res.status).toBe(201);
    const turns = calls.seed[0]![0] as { role: string; text: string }[];
    expect(turns.map((x) => x.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[2]!.text).toContain("what happened later");
    expect(metaOf(res.body.chat.id)).toMatchObject({ provider: "codex" });
  });

  it("requires a summary and refuses an empty side", async () => {
    const chat = makeChat({});
    expect((await call("/:id/compress", chat.id, { timestamp: t(1), direction: "after", summary: "   " })).status).toBe(400);
    expect((await call("/:id/compress", chat.id, { timestamp: t(11), direction: "after", summary: "x" })).status).toBe(400);
    expect(calls.compress).toHaveLength(0);
  });
});
