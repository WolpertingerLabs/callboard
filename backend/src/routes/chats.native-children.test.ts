/**
 * Route-level tests for how GET /api/chats scopes native Codex children.
 *
 * A native child is a subagent a parent Codex thread spawned. Callboard can
 * neither drive nor close it, so on the sidebar it is automation: hidden while
 * "Show triggered chats" is off (`excludeTriggered=true`, the default request),
 * in place when it is on. Its parent's tree is a different route and is never
 * scoped by this — that is where a hidden child stays reachable from.
 *
 * Same no-supertest style as chats.job-run-status.test.ts: the handler is
 * pulled off the router stack and driven with a fake req/res. The discovered
 * session's file path does not exist, so the native metadata the route sees is
 * the PERSISTED kind — which is also the shape of the ghost this guards
 * against: a record written while the rollout existed, outliving it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-native-children-"));

let fileChats: any[] = [];
let sessions: string[] = [];

vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getAllChats: () => fileChats,
    getChat: (id: string) => fileChats.find((c) => c.id === id) ?? null,
  },
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getPendingRequest: () => null, getActiveSession: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, get: () => undefined, notifyMetadata: () => {} } }));
vi.mock("../utils/git.js", () => ({ getGitInfo: () => ({ isGitRepo: false }), resolveBranch: () => ({ ok: true, folder: "/tmp/proj" }) }));
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "codex",
      discoverSessions: ({ limit, offset }: { limit: number; offset: number }) => {
        const all = sessions.map((sessionId, i) => ({
          sessionId,
          folder: "/tmp/proj",
          displayFolder: "/tmp/proj",
          filePath: `/logs/rollout-${sessionId}.jsonl`,
          createdAt: new Date(2026, 0, 1, 0, sessions.length - i),
          updatedAt: new Date(2026, 0, 1, 0, sessions.length - i),
        }));
        return { sessions: all.slice(offset, offset + limit), total: all.length };
      },
      getSessionPreview: () => null,
    },
  ],
}));

const { chatsRouter } = await import("./chats.js");

const listHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function listChats(query: Record<string, string>): Promise<any> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve(payload);
        return this;
      },
    };
    listHandler({ query: { ...query, cached: "false" } } as unknown as Request, res as unknown as Response);
  });
}

function chat(id: string, metadata: Record<string, unknown> = {}) {
  return {
    id,
    folder: "/tmp/proj",
    session_id: id,
    session_log_path: null,
    metadata: JSON.stringify({ provider: "codex", ...metadata }),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

const ROOT = "01a0767f-671a-75f0-ab44-238e2fa5785c";
const CHILD = "01a07680-3128-7461-bc19-d727bd8dc379";
const ids = (body: any) => body.chats.map((c: any) => c.id);

describe("GET /api/chats and native Codex children", () => {
  beforeEach(() => {
    fileChats = [chat(ROOT, { title: "Parent" }), chat(CHILD, { parentChatId: ROOT, chatRole: "subagent", nativeAgent: { parentThreadId: ROOT, nickname: "Ramanujan" } })];
    sessions = [CHILD, ROOT];
  });

  it("hides them under the default sidebar scope, exactly as triggered chats are hidden", async () => {
    const body = await listChats({ excludeTriggered: "true", limit: "20" });
    expect(ids(body)).toEqual([ROOT]);
    expect(body.total).toBe(1);
  });

  it("hides them from the lineage append too, so the filter is not smuggled around by the tree", async () => {
    const body = await listChats({ excludeTriggered: "true", includeLineage: "true", limit: "20" });
    expect(ids(body)).toEqual([ROOT]);
  });

  it("shows them in place when triggered chats are shown, still marked read-only", async () => {
    const body = await listChats({ limit: "20" });
    expect(ids(body)).toEqual([CHILD, ROOT]);
    const native = JSON.parse(body.chats[0].metadata).nativeAgent;
    expect(native).toMatchObject({ nickname: "Ramanujan", management: "read-only" });
  });
});
