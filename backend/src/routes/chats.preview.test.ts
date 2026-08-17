/**
 * Route-level tests for how GET /api/chats reads session-log previews.
 *
 * The list route over-fetches on purpose: the triggered/bookmarked flags live
 * in chat-file metadata and the lineage/cards passes need the whole list, so
 * `needsPostFilter` asks discovery for everything and filters afterwards. What
 * must NOT scale with that over-fetch is file I/O — the preview is the one part
 * of building a row that opens a session log, and it belongs after filtering
 * and pagination, on the rows that actually ship.
 *
 * So these tests assert two things at once, and the pair is the point:
 *  - every returned row still carries the preview it carried before, including
 *    lineage-appended relatives and rows the cards filter admits; and
 *  - the number of files opened equals the number of rows returned, not the
 *    number of sessions discovered.
 *
 * A preview read is also routed to its owning provider rather than tried
 * against all five, so the stub registry here has three providers and counts
 * calls per provider.
 *
 * Same no-supertest style as chats.cards-only.test.ts: the handler is pulled
 * off the router stack and driven with a fake req/res.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-preview-"));

/** Chat records the stubbed file service hands back, set per test. */
let fileChats: any[] = [];
/** Sessions each stubbed provider discovers, newest first. */
let sessionsByProvider: Record<string, string[]> = {};
/** Per-provider count of getSessionPreview calls. */
let previewCalls: Record<string, string[]> = {};

vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getAllChats: () => fileChats,
    getChat: (id: string) => fileChats.find((c) => c.id === id) ?? null,
  },
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getPendingRequest: () => null, getActiveSession: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
vi.mock("../utils/git.js", () => ({ getGitInfo: () => ({ isGitRepo: false }), resolveBranch: () => ({ ok: true, folder: "/tmp/proj" }) }));
/** Cards the stubbed store hands back, set per test. */
let cards: any[] = [];
vi.mock("../services/card-store.js", () => ({
  getCard: (id: string) => cards.find((c) => c.id === id) ?? null,
  listCards: () => cards,
}));

/**
 * Three providers, each owning its own session-id prefix. Only the owner can
 * produce a preview for its files, so a walk over all three is visible in
 * `previewCalls` as calls landing on providers that return null.
 */
const PROVIDER_KINDS = ["claude-code", "codex", "cline"] as const;

function makeProvider(kind: string) {
  return {
    kind,
    discoverSessions: ({ limit, offset }: { limit: number; offset: number }) => {
      const ids = sessionsByProvider[kind] ?? [];
      const sessions = ids.map((sessionId, i) => ({
        sessionId,
        folder: "/tmp/proj",
        displayFolder: "/tmp/proj",
        filePath: `/logs/${sessionId}.jsonl`,
        createdAt: new Date(2026, 0, 1, 0, ids.length - i),
        updatedAt: new Date(2026, 0, 1, 0, ids.length - i),
      }));
      return { sessions: sessions.slice(offset, offset + limit), total: sessions.length };
    },
    getSessionPreview: (filePath: string) => {
      (previewCalls[kind] ??= []).push(filePath);
      // A provider only reads its own files — the naming convention below.
      return filePath.includes(`/${kind}-`) ? `preview of ${filePath}` : null;
    },
  };
}

vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => PROVIDER_KINDS.map(makeProvider),
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
    metadata: JSON.stringify(metadata),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

/** Total preview reads across every provider — i.e. files opened. */
const totalPreviewCalls = () => Object.values(previewCalls).reduce((n, c) => n + c.length, 0);
const previewOf = (body: any, id: string) => JSON.parse(body.chats.find((c: any) => c.id === id).metadata).preview;

/** 60 claude-code sessions, half of them triggered. */
const BULK_IDS = Array.from({ length: 60 }, (_, i) => `claude-code-${String(i).padStart(3, "0")}`);

beforeEach(() => {
  previewCalls = {};
  cards = [];
  sessionsByProvider = { "claude-code": [...BULK_IDS], codex: [], cline: [] };
  fileChats = BULK_IDS.map((id, i) => chat(id, i % 2 === 1 ? { triggered: true } : {}));
});

describe("GET /api/chats preview reads", () => {
  it("still puts a preview on every returned row", async () => {
    const body = await listChats({ limit: "20", offset: "0" });
    expect(body.chats).toHaveLength(20);
    for (const c of body.chats) {
      expect(JSON.parse(c.metadata).preview).toBe(`preview of /logs/${c.session_id}.jsonl`);
    }
  });

  it("reads one preview per returned row, not per session discovered", async () => {
    // excludeTriggered forces the over-fetch: all 60 sessions are augmented and
    // filtered to pick the 20 that ship. Only those 20 may be opened.
    const body = await listChats({ limit: "20", offset: "0", excludeTriggered: "true" });
    expect(body.chats).toHaveLength(20);
    expect(body.total).toBe(30);
    expect(totalPreviewCalls()).toBe(20);
  });

  it("does not read previews for pages the caller skipped past", async () => {
    const body = await listChats({ limit: "5", offset: "20", excludeTriggered: "true" });
    expect(body.chats).toHaveLength(5);
    expect(body.chats.map((c: any) => c.id)).toEqual(["claude-code-040", "claude-code-042", "claude-code-044", "claude-code-046", "claude-code-048"]);
    expect(totalPreviewCalls()).toBe(5);
  });

  it("keeps total, hasMore and windowRows measured over the filtered set", async () => {
    const first = await listChats({ limit: "20", offset: "0", excludeTriggered: "true" });
    expect(first).toMatchObject({ total: 30, hasMore: true, windowRows: 20 });
    const second = await listChats({ limit: "20", offset: "20", excludeTriggered: "true" });
    expect(second).toMatchObject({ total: 30, hasMore: false, windowRows: 10 });
    // The two pages together are the whole non-triggered set, no overlap.
    const ids = [...first.chats, ...second.chats].map((c: any) => c.id);
    expect(new Set(ids).size).toBe(30);
  });

  it("routes the read to the owning provider instead of trying all of them", async () => {
    sessionsByProvider = { "claude-code": ["claude-code-a"], codex: ["codex-a"], cline: ["cline-a"] };
    fileChats = [chat("claude-code-a"), chat("codex-a", { provider: "codex" }), chat("cline-a", { provider: "cline" })];

    const body = await listChats({ limit: "10", offset: "0" });
    expect(body.chats).toHaveLength(3);
    for (const c of body.chats) {
      expect(JSON.parse(c.metadata).preview).toBe(`preview of /logs/${c.session_id}.jsonl`);
    }
    // Three rows, three reads — one each, none speculative.
    expect(totalPreviewCalls()).toBe(3);
    expect(previewCalls["codex"]).toEqual(["/logs/codex-a.jsonl"]);
    expect(previewCalls["cline"]).toEqual(["/logs/cline-a.jsonl"]);
  });

  it("falls back to walking every provider when the record names none", async () => {
    // No metadata.provider, and discovery says cline owns it — a session whose
    // record predates the provider field must not lose its preview.
    sessionsByProvider = { "claude-code": [], codex: [], cline: ["cline-orphan"] };
    fileChats = [];
    const body = await listChats({ limit: "10", offset: "0" });
    expect(previewOf(body, "cline-orphan")).toBe("preview of /logs/cline-orphan.jsonl");
  });

  it("falls back to walking every provider when the record names the wrong one", async () => {
    sessionsByProvider = { "claude-code": [], codex: [], cline: ["cline-mislabelled"] };
    fileChats = [chat("cline-mislabelled", { provider: "codex" })];
    const body = await listChats({ limit: "10", offset: "0" });
    expect(previewOf(body, "cline-mislabelled")).toBe("preview of /logs/cline-mislabelled.jsonl");
  });

  it("preserves the rest of a chat's metadata alongside the preview", async () => {
    sessionsByProvider = { "claude-code": ["claude-code-meta"], codex: [], cline: [] };
    fileChats = [chat("claude-code-meta", { agentAlias: "forge", cardId: "card-1", triggered: false })];
    const body = await listChats({ limit: "10", offset: "0" });
    expect(JSON.parse(body.chats[0].metadata)).toEqual({
      agentAlias: "forge",
      cardId: "card-1",
      triggered: false,
      session_ids: ["claude-code-meta"],
      preview: "preview of /logs/claude-code-meta.jsonl",
    });
  });

  it("lets a freshly read preview win over one stored in the record", async () => {
    sessionsByProvider = { "claude-code": ["claude-code-stale"], codex: [], cline: [] };
    fileChats = [chat("claude-code-stale", { preview: "an old preview" })];
    const body = await listChats({ limit: "10", offset: "0" });
    expect(previewOf(body, "claude-code-stale")).toBe("preview of /logs/claude-code-stale.jsonl");
  });

  it("leaves a stored preview in place when the log yields nothing", async () => {
    // "pi-*" matches no provider's naming convention, so every provider
    // declines and the record's own preview is what the client sees.
    sessionsByProvider = { "claude-code": ["pi-unreadable"], codex: [], cline: [] };
    fileChats = [chat("pi-unreadable", { preview: "recorded at spawn" })];
    const body = await listChats({ limit: "10", offset: "0" });
    expect(previewOf(body, "pi-unreadable")).toBe("recorded at spawn");
  });
});

describe("GET /api/chats?cardsOnly=true preview reads", () => {
  beforeEach(() => {
    cards = [
      { id: "card-open", lifecycle: "open" },
      { id: "card-done", lifecycle: "closed" },
    ];
    sessionsByProvider = {
      "claude-code": ["claude-code-member", "claude-code-child", "claude-code-closed", ...BULK_IDS],
      codex: ["codex-member"],
      cline: [],
    };
    fileChats = [
      chat("claude-code-member", { cardId: "card-open" }),
      // Admitted by descent, not membership — it carries no cardId of its own.
      chat("claude-code-child", { parentChatId: "claude-code-member" }),
      chat("claude-code-closed", { cardId: "card-done" }),
      // No provider hint, so the read has to resolve its owner from the map of
      // which provider discovered which log.
      chat("codex-member", { cardId: "card-open" }),
      ...BULK_IDS.map((id) => chat(id)),
    ];
  });

  it("previews every row the filter admits and opens nothing else", async () => {
    const body = await listChats({ limit: "20", offset: "0", cardsOnly: "true" });
    expect(body.chats.map((c: any) => c.id).sort()).toEqual(["claude-code-child", "claude-code-member", "codex-member"]);
    for (const c of body.chats) {
      expect(JSON.parse(c.metadata).preview).toBe(`preview of /logs/${c.session_id}.jsonl`);
    }
    // 64 sessions were discovered to decide those three rows; three files open.
    expect(totalPreviewCalls()).toBe(3);
  });

  it("routes an admitted row to the provider that discovered it", async () => {
    // The row carries no provider hint, so owner-first routing has to come from
    // the discoverer map — and that map has to survive the filter, which runs
    // between discovery and the preview read. What pins it is the claude-code
    // list: walking every provider instead would offer it the codex log too.
    await listChats({ limit: "20", offset: "0", cardsOnly: "true" });
    expect(previewCalls["claude-code"]).toEqual(["/logs/claude-code-member.jsonl", "/logs/claude-code-child.jsonl"]);
    expect(previewCalls["codex"]).toEqual(["/logs/codex-member.jsonl"]);
    expect(previewCalls["cline"] ?? []).toEqual([]);
  });
});

describe("GET /api/chats?includeLineage=true preview reads", () => {
  beforeEach(() => {
    // Bookmarks + tree layout: the page is the bookmarked root alone, and its
    // two relatives come back through the lineage-append pass. One of them has
    // a session log; the other has only a record, which is the branch that
    // falls back to `{...fileChat}` and has nothing to read.
    sessionsByProvider = {
      "claude-code": ["claude-code-root", "claude-code-kid", ...Array.from({ length: 30 }, (_, i) => `claude-code-fill-${String(i).padStart(2, "0")}`)],
      codex: [],
      cline: [],
    };
    fileChats = [
      chat("claude-code-root", { bookmarked: true }),
      chat("claude-code-kid", { parentChatId: "claude-code-root" }),
      chat("claude-code-ghost", { parentChatId: "claude-code-root" }),
      ...Array.from({ length: 30 }, (_, i) => chat(`claude-code-fill-${String(i).padStart(2, "0")}`)),
    ];
  });

  const bookmarkedTree = () => listChats({ limit: "20", offset: "0", bookmarked: "true", includeLineage: "true" });

  it("previews lineage-appended relatives that have a session", async () => {
    const body = await bookmarkedTree();
    const kid = body.chats.find((c: any) => c.id === "claude-code-kid");
    expect(kid?._lineage_appended).toBe(true);
    expect(JSON.parse(kid.metadata).preview).toBe("preview of /logs/claude-code-kid.jsonl");
  });

  it("appends a session-less relative without inventing a preview for it", async () => {
    const body = await bookmarkedTree();
    const ghost = body.chats.find((c: any) => c.id === "claude-code-ghost");
    expect(ghost?._lineage_appended).toBe(true);
    expect(JSON.parse(ghost.metadata).preview).toBeUndefined();
    expect(previewCalls["claude-code"] ?? []).not.toContain("/logs/claude-code-ghost.jsonl");
  });

  it("returns the whole family and reads a preview only for the ones with logs", async () => {
    const body = await bookmarkedTree();
    expect(body.chats.map((c: any) => c.id).sort()).toEqual(["claude-code-ghost", "claude-code-kid", "claude-code-root"]);
    // The bookmarked page is one row; the two relatives sit outside it.
    expect(body).toMatchObject({ total: 1, windowRows: 1, hasMore: false });
    expect(totalPreviewCalls()).toBe(2);
    // 32 sessions were discovered and augmented to get here.
    expect(totalPreviewCalls()).toBeLessThan(sessionsByProvider["claude-code"].length);
  });

  it("folds a whole tree into one row and previews every member of it", async () => {
    // The other shape: root and kid share a row, so both are page members
    // rather than appended, and both must still carry a preview.
    fileChats = [chat("claude-code-root"), chat("claude-code-kid", { parentChatId: "claude-code-root" })];
    sessionsByProvider = { "claude-code": ["claude-code-root", "claude-code-kid"], codex: [], cline: [] };
    const body = await listChats({ limit: "20", offset: "0", includeLineage: "true" });
    expect(body).toMatchObject({ total: 1, windowRows: 1 });
    expect(body.chats.map((c: any) => c.id).sort()).toEqual(["claude-code-kid", "claude-code-root"]);
    expect(body.chats.every((c: any) => JSON.parse(c.metadata).preview)).toBe(true);
    expect(totalPreviewCalls()).toBe(2);
  });
});
