/**
 * The exact `metadata` string `GET /api/chats` emits per row.
 *
 * Building a row's metadata is the chat list's per-session hot path: with
 * `excludeTriggered` (the sidebar default) it runs for every discovered
 * session, not just the page. It used to round-trip the record's metadata
 * through `JSON.stringify`/`JSON.parse` four times per session; it now carries
 * the parsed object through. These literals were captured from the
 * round-tripping version, so they pin that the change is byte-for-byte — key
 * order included — across the shapes that differ: records with and without
 * `session_ids`, malformed and non-object metadata, explicit and inferred
 * provider routing, ACP vendors, persisted Codex native-agent snapshots,
 * triggered rows, and sessions with no stored record at all.
 *
 * Same no-supertest, in-memory style as chats.pinned.test.ts.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-list-metadata-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const record = (id: string, metadata: string, extra: Record<string, unknown> = {}) => ({
  id,
  folder: "/tmp/proj",
  session_id: id,
  session_log_path: null,
  metadata,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...extra,
});

const fileChats: any[] = [
  record("plain", '{"title":"Plain","model":"opus"}'),
  record("explicit", '{"provider":"claude-code","session_ids":["explicit"],"title":"E"}'),
  record("multi", '{"title":"Multi","session_ids":["multi-old"]}', { session_id: "multi" }),
  record("broken", "{broken"),
  record("array", '["x"]'),
  record("empty", ""),
  record("acp", '{"provider":"acp","acpProviderId":"opencode"}'),
  record("acp-inferred", "{}"),
  record("triggered", '{"triggered":true,"title":"Cron"}'),
  record("native", '{"provider":"codex","nativeAgent":{"lifecycle":"running","role":"worker"},"title":"Kid"}'),
  record("bookmarked", '{"bookmarked":true,"pinned":true,"tags":["a"],"nested":{"k":[1,{"z":null}]}}'),
];

/** [sessionId, providerKind, acpProviderId?] — newest first. */
const sessions: Array<[string, string, string?]> = [
  ["plain", "claude-code"],
  ["explicit", "codex"],
  ["multi", "claude-code"],
  ["multi-old", "claude-code"],
  ["broken", "codex"],
  ["array", "claude-code"],
  ["empty", "claude-code"],
  ["acp", "acp", "other"],
  ["acp-inferred", "acp", "gemini"],
  ["triggered", "claude-code"],
  ["native", "codex"],
  ["bookmarked", "claude-code"],
  ["orphan", "claude-code"],
  ["orphan-acp", "acp", "opencode"],
];

vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getAllChats: () => fileChats.map((c) => ({ ...c })),
    getChat: (id: string) => fileChats.find((c) => c.id === id) ?? null,
  },
}));
vi.mock("../utils/chat-lookup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/chat-lookup.js")>()),
  // Resolves routing from the discovery table, the way session provenance
  // would, so attachPreview's reconciliation keeps a provider on every row.
  findChat: (id: string) => {
    const session = sessions.find(([sid]) => sid === id);
    if (!session) return null;
    const chat = fileChats.find((c) => c.id === id) ?? record(id, "{}");
    const [, provider, acpProviderId] = session;
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(chat.metadata);
    } catch {}
    const metadata = JSON.stringify({ ...meta, provider, ...(acpProviderId && { acpProviderId }) });
    return { ...chat, metadata, displayFolder: chat.folder, session_log_path: `/tmp/proj/${id}.jsonl` };
  },
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getPendingRequest: () => null, getActiveSession: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
vi.mock("../utils/git.js", () => ({ getGitInfo: () => ({ isGitRepo: false }), resolveBranch: () => ({ ok: true, folder: "/tmp/proj" }) }));
vi.mock("../agents/factory.js", () => {
  const discovered = (kind: string) =>
    sessions
      .map(([sessionId, providerKind, acpProviderId], i) => ({
        sessionId,
        providerKind,
        ...(acpProviderId && { acpProviderId }),
        folder: "/tmp/proj",
        displayFolder: "/tmp/proj",
        filePath: `/tmp/proj/${sessionId}.jsonl`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, sessions.length - i)),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, sessions.length - i)),
      }))
      .filter((s) => s.providerKind === kind);
  return {
    getSessionProviders: () =>
      ["claude-code", "codex", "acp"].map((kind) => ({
        kind,
        discoverSessions: ({ limit, offset }: { limit: number; offset: number }) => {
          const all = discovered(kind);
          return { sessions: all.slice(offset, offset + limit), total: all.length };
        },
        getSessionPreview: () => null,
      })),
  };
});

const { saveIgnoredProjectDirPrefixes } = await import("../utils/paths.js");
saveIgnoredProjectDirPrefixes([]);
const { chatsRouter } = await import("./chats.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const listHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

function list(query: Record<string, string>): Promise<any> {
  return new Promise((resolve) => {
    const res = {
      status: () => res,
      json: (payload: any) => resolve(payload),
    };
    listHandler({ query: { cached: "false", limit: "50", ...query } } as unknown as Request, res as unknown as Response);
  });
}

const rows = (body: any) => body.chats.map((c: any) => [c.id, c.metadata]);

const ALL_ROWS = [
  ["plain", "{\"title\":\"Plain\",\"model\":\"opus\",\"session_ids\":[\"plain\"],\"provider\":\"claude-code\"}"],
  ["explicit", "{\"provider\":\"claude-code\",\"session_ids\":[\"explicit\"],\"title\":\"E\"}"],
  ["multi", "{\"title\":\"Multi\",\"session_ids\":[\"multi-old\",\"multi\"],\"provider\":\"claude-code\"}"],
  ["multi", "{\"title\":\"Multi\",\"session_ids\":[\"multi-old\"],\"provider\":\"claude-code\"}"],
  ["broken", "{\"session_ids\":[\"broken\"],\"provider\":\"codex\"}"],
  ["array", "{\"session_ids\":[\"array\"],\"provider\":\"claude-code\"}"],
  ["empty", "{\"session_ids\":[\"empty\"],\"provider\":\"claude-code\"}"],
  ["acp", "{\"provider\":\"acp\",\"acpProviderId\":\"other\",\"session_ids\":[\"acp\"]}"],
  ["acp-inferred", "{\"session_ids\":[\"acp-inferred\"],\"provider\":\"acp\",\"acpProviderId\":\"gemini\"}"],
  ["triggered", "{\"triggered\":true,\"title\":\"Cron\",\"session_ids\":[\"triggered\"],\"provider\":\"claude-code\"}"],
  ["native", "{\"provider\":\"codex\",\"nativeAgent\":{\"lifecycle\":\"unknown\",\"role\":\"worker\",\"management\":\"read-only\",\"controlNote\":\"Native Codex child: read-only in Callboard. Ask its parent Codex thread to send instructions, interrupt, or close it. The exec transport cannot independently control this child; direct resume could race its owner. Inherited Callboard MCP tools are bound to the owning root, not this child; do not use them to set child-local title, status, or completion.\"},\"title\":\"Kid\",\"session_ids\":[\"native\"]}"],
  ["bookmarked", "{\"bookmarked\":true,\"pinned\":true,\"tags\":[\"a\"],\"nested\":{\"k\":[1,{\"z\":null}]},\"session_ids\":[\"bookmarked\"],\"provider\":\"claude-code\"}"],
  ["orphan", "{\"session_ids\":[\"orphan\"],\"provider\":\"claude-code\"}"],
  ["orphan-acp", "{\"session_ids\":[\"orphan-acp\"],\"provider\":\"acp\",\"acpProviderId\":\"opencode\"}"],
];

describe("GET /api/chats — row metadata bytes", () => {
  it("unfiltered", async () => {
    expect(rows(await list({}))).toEqual(ALL_ROWS);
  });

  it("excludeTriggered drops triggered and native rows and changes no other byte", async () => {
    expect(rows(await list({ excludeTriggered: "true" }))).toEqual(ALL_ROWS.filter(([id]) => id !== "triggered" && id !== "native"));
  });

  it("bookmarked + excludeTriggered", async () => {
    expect(rows(await list({ bookmarked: "true", excludeTriggered: "true" }))).toEqual(ALL_ROWS.filter(([id]) => id === "bookmarked"));
  });

  it("includeLineage + includePinned + excludeTriggered", async () => {
    expect(rows(await list({ includeLineage: "true", includePinned: "true", excludeTriggered: "true" }))).toEqual(
      ALL_ROWS.filter(([id], i) => id !== "triggered" && id !== "native" && !(id === "multi" && i === 3)),
    );
  });

  it("does not mutate the stored records it read", async () => {
    const before = JSON.stringify(fileChats);
    await list({ excludeTriggered: "true" });
    expect(JSON.stringify(fileChats)).toBe(before);
  });
});
