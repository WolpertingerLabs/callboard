/**
 * Route-level tests for the `cardsOnly` filter on GET /api/chats — the
 * sidebar's "cards only" toggle. The rule under test: a chat is visible iff
 * its lineage root is an OPEN, visible card — a non-triggered, non-job-step
 * top-level chat. Membership is derived from the tree (parent pointers and
 * job-step chats' stamped rootChatId), so descendants follow their root's
 * lifecycle and hidden flag.
 *
 * Same no-supertest style as cards.metadata.test.ts — the handler is pulled off
 * the router stack and driven with a fake req/res. Chats live in memory (the
 * file service is stubbed) so the assertions are purely about which chats the
 * filter admits; session discovery is stubbed likewise.
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
    // The close/reopen test drives the real card-fields writer, which lands
    // here — mutate the in-memory record like the file-backed service would.
    updateChatMetadata: (id: string, fields: Record<string, unknown>) => {
      const chat = fileChats.find((c) => c.id === id);
      if (!chat) return false;
      const meta = JSON.parse(chat.metadata || "{}");
      chat.metadata = JSON.stringify({ ...meta, ...fields });
      return true;
    },
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
const { patchCardFields } = await import("../services/card-fields.js");

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

beforeEach(() => {
  fileChats = [
    // An open card root with an explicit card object, its child chain, and a
    // triggered member (e.g. a cron/job chat) stamped with the root.
    chat("member", { card: { lifecycle: "open" } }),
    chat("member-child", { parentChatId: "member" }),
    chat("member-grandchild", { parentChatId: "member-child" }),
    chat("member-triggered", { rootChatId: "member", triggered: true }),
    // A closed card's tree: admitted by neither lifecycle nor descent.
    chat("closed-root", { card: { lifecycle: "closed" } }),
    chat("closed-child", { parentChatId: "closed-root" }),
    // A hidden card opted out of the board; the filter is the board's sibling.
    chat("hidden-root", { card: { hidden: true } }),
    // Roots that are NOT cards: a triggered top-level chat and a job-step chat.
    chat("triggered-root", { triggered: true }),
    chat("job-root", { jobRunId: "run-1" }),
    // A plain top-level chat with NO card object: all-defaults means OPEN —
    // every non-triggered top-level chat is a card in the new model.
    chat("plain-root", {}),
    chat("plain-child", { parentChatId: "plain-root" }),
  ];
  // "orphan-session" has no stored record, so it can carry no membership.
  sessionIds = [...fileChats.map((c) => c.id), "orphan-session"];
});

const idsOf = (body: any) => body.chats.map((c: any) => c.id).sort();

describe("GET /api/chats?cardsOnly=true", () => {
  it("returns chats whose root is an open card, and nothing else", async () => {
    const body = await listChats({ cardsOnly: "true", limit: "50" });
    expect(idsOf(body)).toEqual([
      "member",
      "member-child",
      "member-grandchild",
      "member-triggered",
      "plain-child",
      "plain-root",
    ]);
    expect(body.total).toBe(6);
  });

  it("drops a card's chats as soon as the card is closed, and restores them on reopen", async () => {
    patchCardFields("member", { lifecycle: "closed" });
    expect(idsOf(await listChats({ cardsOnly: "true", limit: "50" }))).toEqual(["plain-child", "plain-root"]);

    patchCardFields("member", { lifecycle: "open" });
    expect(idsOf(await listChats({ cardsOnly: "true", limit: "50" }))).toContain("member");
  });

  it("includes a descendant even when it carries no card metadata of its own", async () => {
    // Membership is the tree: a child spawned before anyone edited the root's
    // card has no card fields anywhere, and still shares its root's view.
    const body = await listChats({ cardsOnly: "true", limit: "50" });
    const child = body.chats.find((c: any) => c.id === "member-child");
    expect(child).toBeDefined();
    expect(JSON.parse(child.metadata).card).toBeUndefined();
  });

  it("promotes a surviving descendant when its stored parent was deleted", async () => {
    fileChats.push(
      chat("promoted-root", { parentChatId: "deleted-root", rootChatId: "deleted-root" }),
      chat("promoted-child", { parentChatId: "promoted-root", rootChatId: "deleted-root" }),
    );
    sessionIds.push("promoted-root", "promoted-child");

    const body = await listChats({ cardsOnly: "true", limit: "50" });
    expect(idsOf(body)).toEqual(expect.arrayContaining(["promoted-root", "promoted-child"]));
  });

  it("composes with excludeTriggered", async () => {
    const body = await listChats({ cardsOnly: "true", excludeTriggered: "true", limit: "50" });
    expect(idsOf(body)).toEqual(["member", "member-child", "member-grandchild", "plain-child", "plain-root"]);
  });

  it("paginates over the filtered set, not the raw session list", async () => {
    const first = await listChats({ cardsOnly: "true", limit: "3", offset: "0" });
    expect(first.chats).toHaveLength(3);
    expect(first.total).toBe(6);
    expect(first.hasMore).toBe(true);

    const second = await listChats({ cardsOnly: "true", limit: "3", offset: "3" });
    expect(second.chats).toHaveLength(3);
    expect(second.hasMore).toBe(false);
    // No overlap — the two pages together are the whole filtered set.
    expect([...idsOf(first), ...idsOf(second)].sort()).toEqual(
      ["member", "member-child", "member-grandchild", "member-triggered", "plain-child", "plain-root"].sort(),
    );
  });

  /**
   * The shape the sidebar actually sends: `cardsOnly` and `includeLineage`
   * together, across a page boundary. The pair above it tests the same filter
   * in CHAT units, which is still a valid API request but no longer one the UI
   * makes — so without this, the units the sidebar paginates in were pinned
   * only at the `paginateTreeRows` unit level, never through the route.
   *
   * The distinction that matters: `limit: 1` returns FOUR chats, because a
   * page is a page of rows and the member/child/grandchild/triggered chain is
   * one row. A regression that reverted to chat units would return one chat
   * here and quietly cut three chats off the sidebar's first page.
   */
  it("paginates the card-filtered set in tree rows when includeLineage is on", async () => {
    const first = await listChats({ cardsOnly: "true", includeLineage: "true", limit: "1", offset: "0" });
    // Rows are recency-ordered: the member family (newest members first in
    // discovery order) then the plain family. Two rows fold two chats each.
    expect(idsOf(first)).toEqual(["member", "member-child", "member-grandchild", "member-triggered"]);
    expect(first).toMatchObject({ total: 2, windowRows: 1, hasMore: true });

    const second = await listChats({ cardsOnly: "true", includeLineage: "true", limit: "1", offset: "1" });
    expect(idsOf(second)).toEqual(["plain-child", "plain-root"]);
    expect(second).toMatchObject({ total: 2, windowRows: 1, hasMore: false });
  });

  it("keeps tree-layout lineage appending inside the filter", async () => {
    const body = await listChats({ cardsOnly: "true", includeLineage: "true", limit: "50" });
    // No chat outside the card scope may be appended back in — not the closed
    // tree, not the hidden root, not the non-card roots.
    expect(idsOf(body)).toEqual(["member", "member-child", "member-grandchild", "member-triggered", "plain-child", "plain-root"]);
  });

  it("returns every chat when the filter is off", async () => {
    const body = await listChats({ limit: "50" });
    expect(body.chats.length).toBe(sessionIds.length);
    expect(idsOf(body)).toContain("orphan-session");
  });
});
