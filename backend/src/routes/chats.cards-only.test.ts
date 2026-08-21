/**
 * Route-level tests for the `cardsOnly` filter on GET /api/chats — the
 * sidebar's "cards only" toggle. The rule under test: a chat is visible iff
 * it sits on an OPEN card, or descends from one that does.
 *
 * Same no-supertest style as cards.delete.test.ts — the handler is pulled off
 * the router stack and driven with a fake req/res. Cards come from the real
 * store (temp CALLBOARD_DATA_DIR) so lifecycle behaves as in production;
 * chats and session discovery are stubbed so the assertions are purely about
 * which chats the filter admits.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-cards-only-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

/** Chat records the stubbed file service hands back, set per test. */
let fileChats: any[] = [];
/** Session ids the stubbed provider discovers, newest first. */
let sessionIds: string[] = [];

vi.mock("../services/chat-file-service.js", () => ({
  chatFileService: {
    getAllChats: () => fileChats,
    getChat: (id: string) => fileChats.find((c) => c.id === id) ?? null,
  },
}));
vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getPendingRequest: () => null, getActiveSession: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
// Real git calls would shell out once per distinct folder.
vi.mock("../utils/git.js", () => ({ getGitInfo: () => ({ isGitRepo: false }), resolveBranch: () => ({ ok: true, folder: "/tmp/proj" }) }));
vi.mock("../agents/factory.js", () => ({
  getSessionProviders: () => [
    {
      kind: "claude-code",
      discoverSessions: ({ limit, offset }: { limit: number; offset: number }) => {
        const sessions = sessionIds.map((sessionId, i) => ({
          sessionId,
          folder: "/tmp/proj",
          displayFolder: "/tmp/proj",
          filePath: `/tmp/proj/${sessionId}.jsonl`,
          // Newest first, matching real discovery order.
          createdAt: new Date(2026, 0, 1, 0, sessionIds.length - i),
          updatedAt: new Date(2026, 0, 1, 0, sessionIds.length - i),
        }));
        return { sessions: sessions.slice(offset, offset + limit), total: sessions.length };
      },
      getSessionPreview: () => null,
    },
  ],
}));

const { chatsRouter } = await import("./chats.js");
const { createCard, updateCard } = await import("../services/card-store.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const listHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/" && layer.route.methods.get).route.stack[0].handle as (
  req: Request,
  res: Response,
) => void;

/** Invoke GET / with the given query and resolve with the JSON body. */
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
    // cached=false on every call — the route caches by query string, and these
    // tests rewrite the fixture set between assertions.
    listHandler({ query: { ...query, cached: "false" } } as unknown as Request, res as unknown as Response);
  });
}

function chat(id: string, metadata: Record<string, unknown>) {
  return {
    id,
    folder: "/tmp/proj",
    session_id: id,
    metadata: JSON.stringify(metadata),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

const openCard = createCard({ title: "Open card" });
const closedCard = createCard({ title: "Closed card" });
updateCard(closedCard.id, { lifecycle: "closed" });

beforeEach(() => {
  fileChats = [
    chat("member", { cardId: openCard.id }),
    chat("member-child", { parentChatId: "member" }),
    chat("member-grandchild", { parentChatId: "member-child" }),
    chat("member-triggered", { cardId: openCard.id, triggered: true }),
    chat("on-closed-card", { cardId: closedCard.id }),
    chat("unassigned", { cardId: null }),
    chat("no-card", {}),
    chat("no-card-child", { parentChatId: "no-card" }),
  ];
  // "orphan-session" has no stored record, so it can carry no membership.
  sessionIds = [...fileChats.map((c) => c.id), "orphan-session"];
});

const idsOf = (body: any) => body.chats.map((c: any) => c.id).sort();

describe("GET /api/chats?cardsOnly=true", () => {
  it("returns chats on an open card plus their descendants, and nothing else", async () => {
    const body = await listChats({ cardsOnly: "true", limit: "50" });
    expect(idsOf(body)).toEqual(["member", "member-child", "member-grandchild", "member-triggered"]);
    expect(body.total).toBe(4);
  });

  it("drops a card's chats as soon as the card is closed, and restores them on reopen", async () => {
    updateCard(openCard.id, { lifecycle: "closed" });
    expect(idsOf(await listChats({ cardsOnly: "true", limit: "50" }))).toEqual([]);

    updateCard(openCard.id, { lifecycle: "open" });
    expect(idsOf(await listChats({ cardsOnly: "true", limit: "50" }))).toContain("member");
  });

  it("includes a descendant even when it carries no cardId of its own", async () => {
    // The child inherits membership at creation in production, but a chat
    // spawned before its parent was filed has no cardId — the lineage walk is
    // what keeps it in the same view as its parent.
    const body = await listChats({ cardsOnly: "true", limit: "50" });
    const child = body.chats.find((c: any) => c.id === "member-child");
    expect(child).toBeDefined();
    expect(JSON.parse(child.metadata).cardId).toBeUndefined();
  });

  it("composes with excludeTriggered", async () => {
    const body = await listChats({ cardsOnly: "true", excludeTriggered: "true", limit: "50" });
    expect(idsOf(body)).toEqual(["member", "member-child", "member-grandchild"]);
  });

  it("paginates over the filtered set, not the raw session list", async () => {
    const first = await listChats({ cardsOnly: "true", limit: "2", offset: "0" });
    expect(first.chats).toHaveLength(2);
    expect(first.total).toBe(4);
    expect(first.hasMore).toBe(true);

    const second = await listChats({ cardsOnly: "true", limit: "2", offset: "2" });
    expect(second.chats).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    // No overlap — the two pages together are the whole filtered set.
    expect([...idsOf(first), ...idsOf(second)].sort()).toEqual(["member", "member-child", "member-grandchild", "member-triggered"]);
  });

  /**
   * The shape the sidebar actually sends: `cardsOnly` and `includeLineage`
   * together, across a page boundary. The pair above it tests the same filter
   * in CHAT units, which is still a valid API request but no longer one the UI
   * makes — so without this, the units the sidebar paginates in were pinned
   * only at the `paginateTreeRows` unit level, never through the route.
   *
   * The distinction that matters: `limit: 1` returns THREE chats, because a
   * page is a page of rows and the member/child/grandchild chain is one row.
   * A regression that reverted to chat units would return one chat here and
   * quietly cut two chats off the sidebar's first page.
   */
  it("paginates the card-filtered set in tree rows when includeLineage is on", async () => {
    const first = await listChats({ cardsOnly: "true", includeLineage: "true", limit: "1", offset: "0" });
    expect(idsOf(first)).toEqual(["member", "member-child", "member-grandchild"]);
    // Two rows in the filtered set: the chain, and the lineage-less triggered chat.
    expect(first).toMatchObject({ total: 2, windowRows: 1, hasMore: true });

    const second = await listChats({ cardsOnly: "true", includeLineage: "true", limit: "1", offset: "1" });
    expect(idsOf(second)).toEqual(["member-triggered"]);
    expect(second).toMatchObject({ total: 2, windowRows: 1, hasMore: false });

    // No overlap, and together the two pages are the whole filtered set.
    expect([...idsOf(first), ...idsOf(second)].sort()).toEqual(["member", "member-child", "member-grandchild", "member-triggered"]);
  });

  it("keeps tree-layout lineage appending inside the filter", async () => {
    const body = await listChats({ cardsOnly: "true", includeLineage: "true", limit: "50" });
    // "no-card-child" is a lineage relative of nothing in the page; more to the
    // point, no chat outside the card scope may be appended back in.
    expect(idsOf(body)).toEqual(["member", "member-child", "member-grandchild", "member-triggered"]);
  });

  it("returns every chat when the filter is off", async () => {
    const body = await listChats({ limit: "50" });
    expect(body.chats.length).toBe(sessionIds.length);
    expect(idsOf(body)).toContain("orphan-session");
  });
});
