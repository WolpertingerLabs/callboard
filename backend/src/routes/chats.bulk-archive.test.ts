/**
 * POST /api/chats/bulk-archive — the sidebar's archive, for card and card-less
 * trees alike.
 *
 * Drives the real chat file service over a temp data dir, so the assertions
 * are about what lands on disk: which representation a root gets (card
 * lifecycle vs. the chat-level `treeArchived` flag), that a member id archives its
 * root, that the write is quiet, and that every requested id is reported once.
 *
 * Same no-supertest style as cards.patch-unpin.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Request, Response } from "express";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-chats-bulk-archive-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

/** Sessions the stubbed lookup reports as on disk with no stored record. */
const filesystemOnly = new Map<string, any>();
/**
 * Ids the lineage index resolves to a root it knows only from discovery — a
 * native Codex root with no stored record. Real discovery needs Codex rollouts
 * on disk; this file is about the route, so the context is told directly.
 */
const discoveryOnly = new Map<string, string>();
/** Agent-setting overrides, per test. */
let settingsOverride: Record<string, unknown> = {};
const findChatSpy = vi.fn();

vi.mock("../services/claude.js", () => ({ hasPendingRequest: () => false, getActiveSession: () => null, getPendingRequest: () => null }));
vi.mock("../services/session-registry.js", () => ({ sessionRegistry: { has: () => false, notifyMetadata: () => {} } }));
// The real findChat would go looking through every provider's session store on
// this machine for the ids the tests invent.
vi.mock("../utils/chat-lookup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/chat-lookup.js")>();
  const { chatFileService } = await import("../services/chat-file-service.js");
  return {
    ...actual,
    // Honours the real contract for the hint: `null` means "no stored record,
    // do not look" — which the route now always passes.
    findChat: (id: string, _git?: boolean, storedRecord?: unknown) => {
      findChatSpy(id, storedRecord);
      return (storedRecord === undefined ? chatFileService.getChat(id) : storedRecord) ?? filesystemOnly.get(id) ?? null;
    },
  };
});
vi.mock("../services/agent-settings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-settings.js")>();
  return { ...actual, getAgentSettings: () => ({ ...actual.getAgentSettings(), ...settingsOverride }) };
});
vi.mock("../services/card-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/card-context.js")>();
  return {
    ...actual,
    createCardContext: (...args: Parameters<typeof actual.createCardContext>) => {
      const context = actual.createCardContext(...args);
      return {
        ...context,
        resolveLineageRoot: (id: string) => {
          const rootChatId = discoveryOnly.get(id);
          return rootChatId ? { rootChatId, isCard: false, stored: undefined } : context.resolveLineageRoot(id);
        },
      };
    },
  };
});

const { chatsRouter } = await import("./chats.js");
const { chatFileService } = await import("../services/chat-file-service.js");
const { patchCardFields } = await import("../services/card-fields.js");
const { loadComputerUsePolicy } = await import("../services/computer-use.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  settingsOverride = {};
  discoveryOnly.clear();
  findChatSpy.mockClear();
});

const bulkHandler = (chatsRouter as any).stack.find((layer: any) => layer.route?.path === "/bulk-archive" && layer.route.methods.post).route.stack[0]
  .handle as (req: Request, res: Response) => void;

function bulkArchive(body: unknown): Promise<{ code: number; body: any }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ code: this.statusCode, body: payload });
        return this;
      },
    };
    bulkHandler({ body } as unknown as Request, res as unknown as Response);
  });
}

let seq = 0;
const make = (meta: Record<string, unknown>) => chatFileService.createChat("/tmp/proj", `bulk-archive-${seq++}`, JSON.stringify(meta)).id;
const metaOf = (id: string) => JSON.parse(chatFileService.getChat(id)!.metadata || "{}");

describe("POST /api/chats/bulk-archive", () => {
  it("rejects a malformed body", async () => {
    expect((await bulkArchive({ ids: [], archived: true })).code).toBe(400);
    expect((await bulkArchive({ ids: ["x"], archived: "yes" })).code).toBe(400);
  });

  it("closes a card root's card and leaves no chat-level flag on it", async () => {
    const root = make({});
    const res = await bulkArchive({ ids: [root], archived: true });

    expect(res.code).toBe(200);
    expect(res.body.updated).toEqual([{ id: root, rootChatId: root, archived: true, isCard: true }]);
    expect(metaOf(root).card.lifecycle).toBe("closed");
    expect(metaOf(root).treeArchived).toBeUndefined();
  });

  it("flags a card-less (triggered) root and writes no metadata.card onto it", async () => {
    const root = make({ triggered: true });
    const res = await bulkArchive({ ids: [root], archived: true });

    expect(res.body.updated).toEqual([{ id: root, rootChatId: root, archived: true, isCard: false }]);
    const meta = metaOf(root);
    expect(meta.treeArchived).toBe(true);
    expect(typeof meta.treeArchivedAt).toBe("string");
    expect(meta.card).toBeUndefined();

    await bulkArchive({ ids: [root], archived: false });
    expect(metaOf(root).treeArchived).toBeUndefined();
    expect(metaOf(root).treeArchivedAt).toBeUndefined();
  });

  it("treats a job-step root as card-less too", async () => {
    const root = make({ jobRunId: "run-x" });
    await bulkArchive({ ids: [root], archived: true });
    expect(metaOf(root).treeArchived).toBe(true);
    expect(metaOf(root).card).toBeUndefined();
  });

  it("resolves a child id to its root and archives the root, not the child", async () => {
    const root = make({ triggered: true });
    const child = make({ parentChatId: root, rootChatId: root, triggered: true });

    const res = await bulkArchive({ ids: [child], archived: true });

    expect(res.body.updated).toEqual([{ id: child, rootChatId: root, archived: true, isCard: false }]);
    expect(metaOf(root).treeArchived).toBe(true);
    expect(metaOf(child).treeArchived).toBeUndefined();
  });

  it("flips a shared root once and still reports every requested id", async () => {
    const root = make({ triggered: true });
    const a = make({ parentChatId: root, rootChatId: root });
    const b = make({ parentChatId: root, rootChatId: root });

    const res = await bulkArchive({ ids: [a, b, root], archived: true });
    const archivedAt = metaOf(root).treeArchivedAt;

    expect(res.body.updated.map((u: any) => u.id)).toEqual([a, b, root]);
    expect(res.body.failed).toEqual([]);
    // Re-archiving is not a transition: treeArchivedAt describes when it happened.
    await bulkArchive({ ids: [a], archived: true });
    expect(metaOf(root).treeArchivedAt).toBe(archivedAt);
  });

  it("reports a missing id as failed without stranding the rest of the batch", async () => {
    const root = make({ triggered: true });
    const res = await bulkArchive({ ids: ["no-such-chat", root], archived: true });

    expect(res.code).toBe(200);
    expect(res.body.failed).toEqual([{ id: "no-such-chat", error: "Chat not found" }]);
    expect(res.body.updated.map((u: any) => u.id)).toEqual([root]);
    expect(metaOf(root).treeArchived).toBe(true);
  });

  it("does not bump updated_at on either kind of root", async () => {
    const cardRoot = make({});
    const flagRoot = make({ triggered: true });
    const before = [chatFileService.getChat(cardRoot)!.updated_at, chatFileService.getChat(flagRoot)!.updated_at];
    await new Promise((r) => setTimeout(r, 5));

    await bulkArchive({ ids: [cardRoot, flagRoot], archived: true });
    await bulkArchive({ ids: [cardRoot, flagRoot], archived: false });

    expect([chatFileService.getChat(cardRoot)!.updated_at, chatFileService.getChat(flagRoot)!.updated_at]).toEqual(before);
  });

  it("unpins the chats of a card-less tree on archive, as a card archive does", async () => {
    const root = make({ triggered: true, pinned: true });
    const child = make({ parentChatId: root, rootChatId: root, pinned: true });

    await bulkArchive({ ids: [root], archived: true });

    expect(metaOf(root).pinned).toBe(false);
    expect(metaOf(child).pinned).toBe(false);
  });

  it("unarchiving a hidden card clears hidden too, so the row stops reading as archived", async () => {
    const root = make({});
    patchCardFields(root, { hidden: true });

    await bulkArchive({ ids: [root], archived: false });

    expect(metaOf(root).card.hidden).toBeUndefined();
    expect(metaOf(root).card.lifecycle).not.toBe("closed");
  });

  it("materialises a record-less session and closes it as the card it becomes", async () => {
    filesystemOnly.set("fs-only-session", {
      id: "fs-only-session",
      folder: "/tmp/proj",
      session_id: "fs-only-session",
      metadata: JSON.stringify({}),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      _from_filesystem: true,
    });

    const res = await bulkArchive({ ids: ["fs-only-session"], archived: true });

    expect(res.body.updated).toEqual([{ id: "fs-only-session", rootChatId: "fs-only-session", archived: true, isCard: true }]);
    expect(metaOf("fs-only-session").card.lifecycle).toBe("closed");
    expect(chatFileService.getChat("fs-only-session")!.updated_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("resolves a session id that differs from its chat id, from the snapshot and without a store lookup", async () => {
    const sessionId = `bulk-archive-${seq++}`;
    const chat = chatFileService.createChat("/tmp/proj", sessionId, JSON.stringify({ triggered: true }));
    expect(chat.id).not.toBe(sessionId);

    const res = await bulkArchive({ ids: [sessionId], archived: true });

    expect(res.body.updated).toEqual([{ id: sessionId, rootChatId: chat.id, archived: true, isCard: false }]);
    expect(metaOf(chat.id).treeArchived).toBe(true);
    // Answered by the by-session map, so findChat never ran for it.
    expect(findChatSpy).not.toHaveBeenCalled();
  });

  it("asks findChat for a record-less id with the null hint, never the store-scanning lookup", async () => {
    await bulkArchive({ ids: ["nothing-anywhere"], archived: true });
    expect(findChatSpy).toHaveBeenCalledWith("nothing-anywhere", null);
  });

  it("keeps the pins on a card-less tree when unpinChatsOnArchive is off", async () => {
    settingsOverride = { unpinChatsOnArchive: false };
    const root = make({ triggered: true, pinned: true });
    const child = make({ parentChatId: root, rootChatId: root, pinned: true });

    await bulkArchive({ ids: [root], archived: true });

    expect(metaOf(root).treeArchived).toBe(true);
    expect(metaOf(root).pinned).toBe(true);
    expect(metaOf(child).pinned).toBe(true);
  });

  /**
   * The flag is deliberately not `metadata.archived`: computer-use refuses any
   * chat carrying that ("Chat is unavailable"), so archiving a tree would have
   * revoked computer control mid-session on its root.
   */
  it("does not change the root's computer-use availability", async () => {
    const probe = (id: string) => {
      try {
        return loadComputerUsePolicy(id).signature;
      } catch (err: any) {
        return `error: ${err.message}`;
      }
    };
    // The control: the key computer-use reads really does make it refuse, so
    // this test can tell the two names apart.
    expect(probe(make({ triggered: true, archived: true }))).toBe("error: Chat is unavailable");

    const root = make({ triggered: true, defaultPermissions: { computerControl: "allow" } });
    const before = probe(root);
    expect(before).not.toContain("unavailable");

    await bulkArchive({ ids: [root], archived: true });

    expect(metaOf(root).treeArchived).toBe(true);
    expect(probe(root)).toBe(before);
  });

  /**
   * And not `metadata.archivedAt` either: that is the marker workspace-service
   * writes on every chat of an archived WORKSPACE, which an unarchive here
   * would otherwise have deleted.
   */
  it("leaves a workspace archive marker alone through archive and unarchive", async () => {
    const root = make({ triggered: true, archivedAt: "2026-02-02T00:00:00.000Z" });

    await bulkArchive({ ids: [root], archived: true });
    expect(metaOf(root).archivedAt).toBe("2026-02-02T00:00:00.000Z");
    await bulkArchive({ ids: [root], archived: false });

    expect(metaOf(root).archivedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(metaOf(root).treeArchived).toBeUndefined();
  });

  it("materialises a discovery-only root (no stored record) and flags it when it is not a card", async () => {
    // A native Codex root: the lineage index knows it, the store does not.
    discoveryOnly.set("codex-child", "codex-root");
    filesystemOnly.set("codex-root", {
      id: "codex-root",
      folder: "/tmp/proj",
      session_id: "codex-root",
      metadata: JSON.stringify({ provider: "codex", nativeAgent: { parentThreadId: "gone" } }),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      _from_filesystem: true,
    });

    const res = await bulkArchive({ ids: ["codex-child"], archived: true });

    expect(res.body.failed).toEqual([]);
    expect(res.body.updated).toEqual([{ id: "codex-child", rootChatId: "codex-root", archived: true, isCard: false }]);
    const meta = metaOf("codex-root");
    expect(meta.treeArchived).toBe(true);
    expect(meta.card).toBeUndefined();
  });

  it("fails, and overwrites nothing, when a record-less session turns out to have an unreadable record", async () => {
    // The snapshot skips a file it cannot parse, so the route believes there
    // is no record and tries to materialise one over it.
    const sessionId = `bulk-archive-unreadable-${seq++}`;
    const path = join(tmpRoot, "chats", `${sessionId}.json`);
    writeFileSync(path, "{ truncated");
    filesystemOnly.set(sessionId, {
      id: sessionId,
      folder: "/tmp/proj",
      session_id: sessionId,
      metadata: JSON.stringify({}),
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      _from_filesystem: true,
    });

    const res = await bulkArchive({ ids: [sessionId], archived: true });

    expect(res.code).toBe(200);
    expect(res.body.updated).toEqual([]);
    expect(res.body.failed).toEqual([{ id: sessionId, error: expect.stringMatching(/could not be read/) }]);
    expect(readFileSync(path, "utf8")).toBe("{ truncated");
  });
});
