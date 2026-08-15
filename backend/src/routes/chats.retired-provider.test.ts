/**
 * Phase 4 of plans/remove-openrouter-engine.md — the drop-old-chats decision,
 * pinned rather than described.
 *
 * The fixture is the state the decision creates: chat records that name the
 * removed `openrouter` harness and have NO discoverable session file, sitting
 * in every structure that reads records instead of discovery. One of them is on
 * an open card; one is the parent of a surviving claude-code chat. Nothing
 * writes to `~/.callboard` — the records are in-memory and the card store runs
 * against a temp CALLBOARD_DATA_DIR.
 *
 * The invariant under test is single: **filesystem discovery decides what is
 * live, and every path that bypasses it re-applies its verdict.** Three paths
 * bypass it — the card rollup, the sidebar's lineage-append pass, and the chat
 * tree — and they are not meant to answer the same way. The first two feed
 * lists of live chats and drop a retired one; the tree is explicitly a walk
 * over stored records (`buildChatTree`), so it keeps the ancestor and reports
 * its real provider rather than relabelling it claude-code.
 *
 * No-supertest style, matching chats.cards-only.test.ts: the handler comes off
 * the router stack and is driven with a fake req/res.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";
import type { Card, Chat } from "shared";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-retired-provider-"));
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
vi.mock("../utils/git.js", () => ({ getGitInfo: () => ({ isGitRepo: false }), resolveBranch: () => ({ ok: true, folder: "/tmp/proj" }) }));
// The registry after Phase 3: no openrouter session provider. `or-*` session
// ids resolve to nothing here exactly as they do in production.
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
          createdAt: new Date(2026, 0, 1, 0, sessionIds.length - i),
          updatedAt: new Date(2026, 0, 1, 0, sessionIds.length - i),
        }));
        return { sessions: sessions.slice(offset, offset + limit), total: sessions.length };
      },
      resolveSession: (sessionId: string) => (sessionIds.includes(sessionId) ? { logPath: `/tmp/proj/${sessionId}.jsonl`, folder: "/tmp/proj", displayFolder: "/tmp/proj" } : null),
      getSessionPreview: () => null,
    },
  ],
}));

const { chatsRouter } = await import("./chats.js");
const { createCard } = await import("../services/card-store.js");
const { buildCardSummaries } = await import("../services/card-rollup.js");
const { buildChatTree, buildLineageIndex } = await import("../services/chat-lineage.js");
type RollupDeps = import("../services/card-rollup.js").RollupDeps;

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

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

const IDLE_DEPS: RollupDeps = {
  isSessionActive: () => false,
  pendingKindOf: () => undefined,
  activityOf: () => undefined,
  awaitingChildrenOf: () => 0,
  previewOf: () => null,
};

const openCard = createCard({ title: "Ticket with a legacy member" });

beforeEach(() => {
  fileChats = [
    // On the card, still runnable — the control.
    chat("live-member", { cardId: openCard.id, provider: "codex" }),
    // On the same card, harness removed, no session file anywhere.
    chat("or-member", { cardId: openCard.id, provider: "openrouter", title: "Legacy OR chat" }),
    // A tree: an OR parent whose claude-code child outlived the harness.
    chat("or-parent", { provider: "openrouter", title: "Legacy OR parent" }),
    chat("cc-child", { parentChatId: "or-parent", rootChatId: "or-parent" }),
  ];
  // Only the two non-OR chats have session logs. This is the whole fixture:
  // deregistering the OR session provider is exactly this absence.
  sessionIds = ["live-member", "cc-child"];
});

const idsOf = (body: any) => body.chats.map((c: any) => c.id).sort();

describe("the chat list drops chats on a removed harness", () => {
  it("returns only discovered sessions — the OR records are simply absent", async () => {
    const body = await listChats({ limit: "50" });
    expect(idsOf(body)).toEqual(["cc-child", "live-member"]);
    expect(body.total).toBe(2);
  });

  it("keeps the surviving child of an OR parent, and does not append the parent as a tree row", async () => {
    // The append pass reaches out of the pagination window by FILE RECORD, so
    // it is the one path that could put a chat discovery dropped back on the
    // list — rendered as a live row that opens to an empty transcript.
    const body = await listChats({ includeLineage: "true", limit: "50" });
    expect(idsOf(body)).toContain("cc-child");
    expect(idsOf(body)).not.toContain("or-parent");
    const child = body.chats.find((c: any) => c.id === "cc-child");
    expect(child._lineage_appended).toBeUndefined();
  });

  it("excludes an OR chat from the cards-only view even though it holds a cardId", async () => {
    const body = await listChats({ cardsOnly: "true", limit: "50" });
    expect(idsOf(body)).toEqual(["live-member"]);
  });
});

describe("card rollups agree with the chat list", () => {
  const cardFixture: Card = {
    id: openCard.id,
    title: openCard.title,
    description: "",
    emoji: "🗂️",
    lifecycle: "open",
    pinned: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("counts only the members that still exist, and does not crash on the one that does not", () => {
    // Rollups scan chat RECORDS (routes/cards.ts passes getAllChats()), never
    // discovery — so without an explicit rule the board would report a member
    // count the sidebar cannot reproduce.
    const summary = buildCardSummaries([cardFixture], fileChats as unknown as Chat[], [], IDLE_DEPS)[0];
    expect(summary.chatCount).toBe(1);
    expect(summary.memberChats.map((c) => c.chatId)).toEqual(["live-member"]);
    expect(summary.rollup).toBe("idle");
  });

  it("renders an empty card rather than a card of ghosts when every member was OR-backed", () => {
    const orOnly = fileChats.filter((c) => c.id === "or-member");
    const summary = buildCardSummaries([cardFixture], orOnly as unknown as Chat[], [], IDLE_DEPS)[0];
    expect(summary.chatCount).toBe(0);
    expect(summary.memberChats).toEqual([]);
    expect(summary.rollup).toBe("idle");
    // The card itself survives with its own timestamp — an empty card is a
    // rendering state the board already has, not a missing one.
    expect(summary.lastActivityAt).toBe(cardFixture.updatedAt);
  });
});

describe("lineage tolerates a parent that can no longer be opened", () => {
  it("indexes the child under the OR parent without dropping it", () => {
    const index = buildLineageIndex(fileChats);
    expect(index.parentIdOf("cc-child")).toBe("or-parent");
    expect(index.childrenByParent.get("or-parent")?.map((c) => c.id)).toEqual(["cc-child"]);
    // Both sides of the fold key on the same root, so the client groups the
    // orphan exactly where the server counted it.
    expect(index.rootKeyOf("cc-child")).toBe("or-parent");
  });

  it("builds the tree from the OR root and reports its real provider", () => {
    // buildChatTree is documented as a walk over stored records, so unlike the
    // list it KEEPS the ancestor: the tree is how you see where a chat came
    // from. What it must not do is relabel it — `provider` defaults to
    // "claude-code" for anything unstamped, and an OR chat is stamped.
    const tree = buildChatTree("cc-child")!;
    expect(tree).not.toBeNull();
    expect(tree.rootChatId).toBe("or-parent");
    expect(tree.tree.provider).toBe("openrouter");
    expect(tree.tree.children.map((c) => c.chatId)).toEqual(["cc-child"]);
    expect(tree.tree.children[0].provider).toBe("claude-code");
    expect(tree.ancestors.map((a) => a.chatId)).toEqual(["or-parent"]);
  });

  it("still resolves the tree when the OR parent's record is gone entirely", () => {
    // The other half of the drop decision: deleting the unreferenced records is
    // optional housekeeping, so both states have to work.
    fileChats = fileChats.filter((c) => c.id !== "or-parent");
    const tree = buildChatTree("cc-child")!;
    expect(tree.rootChatId).toBe("cc-child");
    expect(tree.ancestors).toEqual([]);
    expect(buildLineageIndex(fileChats).rootKeyOf("cc-child")).toBe("or-parent");
  });
});
