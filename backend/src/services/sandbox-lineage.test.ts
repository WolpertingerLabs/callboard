/**
 * Deliverables across chats whose history was copied (review round 1, item
 * 2): read-through for Continue from / Rerun / Compress, forks, asides and
 * engine switches, each up to its copy point; none for a superseded
 * original or an ordinary child; `/api/files/serve` scoped to the same set;
 * and deletion — a chat's deliverables are deleted once no surviving chat
 * shows them.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { listenRaw } from "../routes/__fixtures__/raw-http.js";

const DATA = mkdtempSync(join(tmpdir(), "cb-sandbox-lineage-"));
process.env.CALLBOARD_DATA_DIR = DATA;
const { chatFileService } = await import("./chat-file-service.js");
const { copiedFrom, deliverySources, sourcesKeptAlive } = await import("./sandbox-lineage.js");
const { chatDeliverySources, deleteSandboxChatData, flushSandboxDeletes, getSandboxDeliveries, sweepDeletedDeliverables } =
  await import("./sandbox-desktop.js");
const { detachChatFromParent } = await import("./chat-detach.js");
const { createFilesRouter } = await import("../routes/files.js");
afterAll(() => rmSync(DATA, { recursive: true, force: true }));

describe("which chats a chat reads through to", () => {
  const metas: Record<string, Record<string, unknown>> = {
    C: {},
    N: { supersedes: { chatId: "C", kind: "continue", at: "2026-01-01T00:00:10.000Z", cutoff: "2026-01-01T00:00:20.000Z" } },
    N2: { supersedes: { chatId: "N", kind: "rerun", at: "2026-01-01T00:00:15.000Z" } },
    // The hidden original: parent and forkedAt point at N only to place it in the tree.
    Corig: { parentChatId: "N", forkedFrom: "N", forkedAt: "2026-01-01T00:00:10.000Z", chatRole: "superseded", supersededBy: { chatId: "N" } },
    F: { parentChatId: "C", forkedFrom: "C", chatRole: "fork", forkedAt: "2026-01-01T00:00:05.000Z" },
    A: { parentChatId: "C", chatRole: "aside", forkedAt: "2026-01-01T00:00:06.000Z" },
    E: { parentChatId: "C", chatRole: "engine-switch", forkedAt: "2026-01-01T00:00:07.000Z" },
    child: { parentChatId: "C", rootChatId: "C" },
    loop1: { parentChatId: "loop2", chatRole: "fork", forkedAt: "2026-01-01T00:00:01.000Z" },
    loop2: { parentChatId: "loop1", chatRole: "fork", forkedAt: "2026-01-01T00:00:01.000Z" },
    // Spawned by start_chat_session or the stream route with a reserved role label: no forkedAt, no copied history.
    spawnedFork: { parentChatId: "C", chatRole: "fork" },
    spawnedAside: { parentChatId: "C", chatRole: "aside" },
    spawnedSwitch: { parentChatId: "C", chatRole: "engine-switch" },
    badForkedAt: { parentChatId: "C", chatRole: "fork", forkedAt: "not a date" },
  };
  const metaOf = (id: string) => metas[id];
  const ms = (iso: string) => Date.parse(iso);

  it("Continue from / Rerun / Compress: the successor shows its original's files up to the cutoff; chains take the earliest point", () => {
    expect(deliverySources("N", metaOf)).toEqual([
      { chatId: "N", replaced: true },
      { chatId: "C", until: ms("2026-01-01T00:00:20.000Z"), replaced: true },
    ]);
    expect(deliverySources("N2", metaOf)).toEqual([
      { chatId: "N2", replaced: true },
      { chatId: "N", until: ms("2026-01-01T00:00:15.000Z"), replaced: true },
      { chatId: "C", until: ms("2026-01-01T00:00:15.000Z"), replaced: true },
    ]);
  });

  it("forks, asides and engine switches read through up to forkedAt, and are not 'replaced' (their parent's kept sandboxes stay the parent's)", () => {
    expect(deliverySources("F", metaOf)).toEqual([
      { chatId: "F", replaced: true },
      { chatId: "C", until: ms("2026-01-01T00:00:05.000Z"), replaced: false },
    ]);
    expect(deliverySources("A", metaOf)[1]).toMatchObject({ chatId: "C", replaced: false });
    expect(deliverySources("E", metaOf)[1]).toMatchObject({ chatId: "C", replaced: false });
  });

  it("a spawned child with a reserved role (fork, aside, engine-switch) but no forkedAt reads through nothing (review round 2)", () => {
    for (const id of ["spawnedFork", "spawnedAside", "spawnedSwitch", "badForkedAt"]) {
      expect(copiedFrom(metas[id])).toEqual([]);
      expect(deliverySources(id, metaOf)).toEqual([{ chatId: id, replaced: true }]);
    }
    // And so never keeps its parent's files alive.
    const survivors = () => ["spawnedFork", "spawnedAside", "spawnedSwitch"].map((id) => ({ id, meta: metas[id] }));
    expect(sourcesKeptAlive("C", [{ chatId: "C" }], (id) => id !== "C", survivors, metaOf)).toEqual({ remove: ["C"], keep: [] });
  });

  it("no read-through for a superseded original or an ordinary child (no copied history); cycles terminate", () => {
    expect(copiedFrom(metas.Corig)).toEqual([]);
    expect(deliverySources("Corig", metaOf)).toEqual([{ chatId: "Corig", replaced: true }]);
    expect(deliverySources("child", metaOf)).toEqual([{ chatId: "child", replaced: true }]);
    expect(deliverySources("loop1", metaOf).map((s) => s.chatId)).toEqual(["loop1", "loop2"]);
  });

  it("sourcesKeptAlive: a deleted chat's files stay while a survivor reads through to them", () => {
    const exists = (id: string) => id !== "C";
    const survivors = () => Object.entries(metas).map(([id, meta]) => ({ id, meta }));
    // Deleting the hidden original C: N, F, A, E still show it.
    expect(sourcesKeptAlive("C", [{ chatId: "C" }], exists, survivors, metaOf)).toEqual({ remove: [], keep: ["C"] });
    // Deleting N after C went, with nothing else reading C: both go.
    const nothingElse = () => [{ id: "N", meta: metas.N }];
    expect(sourcesKeptAlive("N", deliverySources("N", metaOf), exists, nothingElse, metaOf)).toEqual({ remove: ["N", "C"], keep: [] });
    // A surviving source is never a candidate.
    expect(sourcesKeptAlive("N", deliverySources("N", metaOf), () => true, nothingElse, metaOf)).toEqual({ remove: ["N"], keep: [] });
  });
});

describe("end to end, on real chat records", () => {
  const body = (text: string) => Buffer.from(text);
  const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  async function deliver(chatId: string, name: string, text: string) {
    const data = body(text);
    const report = await getSandboxDeliveries().drain(
      {
        sessionId: randomUUID(),
        chatId,
        folder: "/work/lineage",
        mode: "managed",
        source: {
          listOutbox: async () => [{ name, size: data.length, sha256: sha(data), mtimeMs: 0 }],
          downloadOutboxFile: async () => ({ name, size: data.length, sha256: sha(data), data }),
        },
      },
      AbortSignal.timeout(5_000),
    );
    await delay(5);
    return report.files[0].path;
  }
  const chat = (meta: Record<string, unknown> = {}) => chatFileService.createChat("/work/lineage", randomUUID(), JSON.stringify(meta));
  const names = async (chatId: string) =>
    (await getSandboxDeliveries().forSources(chatDeliverySources(chatId), { folder: "/work/lineage" })).flatMap((s) => s.files.map((f) => f.name)).sort();
  async function remove(chatId: string) {
    const record = chatFileService.getChat(chatId)!;
    chatFileService.deleteChat(record.session_id);
    // As deleteOneChat does: the metadata of the record it already holds.
    deleteSandboxChatData(chatId, JSON.parse(record.metadata || "{}"));
    await flushSandboxDeletes();
  }

  it("supersede: N shows C's files delivered by the cutoff, its cards serve with chat=N, and deleting either is coherent", async () => {
    const c = chat();
    const before = await deliver(c.id, "before.txt", "b");
    const cutoff = new Date().toISOString();
    await delay(5);
    const after = await deliver(c.id, "after.txt", "a");
    const n = chat({ supersedes: { chatId: c.id, kind: "continue", at: cutoff } });
    chatFileService.updateChatMetadata(c.id, {
      parentChatId: n.id,
      forkedFrom: n.id,
      chatRole: "superseded",
      forkedAt: cutoff,
      supersededBy: { chatId: n.id },
    });
    const own = await deliver(n.id, "own.txt", "o");
    expect(await names(n.id)).toEqual(["before.txt", "own.txt"]);
    // The hidden original keeps showing its own, and never N's.
    expect(await names(c.id)).toEqual(["after.txt", "before.txt"]);

    // A render_file card in N's copied history: served with chat=N; not for an unrelated chat.
    const server = express();
    server.use("/api/files", createFilesRouter({ dataDir: DATA }));
    const app = await listenRaw(server);
    try {
      const get = (path: string, chatId: string) => app.request("GET", `/api/files/serve?path=${encodeURIComponent(path)}&download=1&chat=${chatId}`);
      expect((await get(before, n.id)).status).toBe(200);
      expect((await get(own, n.id)).status).toBe(200);
      expect((await get(before, chat().id)).status).toBe(404);
    } finally {
      await app.close();
    }

    // Deleting the hidden original: N still shows (and serves) what it showed.
    await remove(c.id);
    expect(existsSync(before)).toBe(true);
    expect(await names(n.id)).toEqual(["before.txt", "own.txt"]);
    // Deleting N, the last reader: its own and the original's go.
    await remove(n.id);
    expect([before, after, own].map(existsSync)).toEqual([false, false, false]);
  });

  it("deleting the successor while the original survives deletes only the successor's own", async () => {
    const c = chat();
    const keep = await deliver(c.id, "orig.txt", "x");
    const n = chat({ supersedes: { chatId: c.id, kind: "rerun", at: new Date().toISOString() } });
    const own = await deliver(n.id, "new.txt", "y");
    await remove(n.id);
    expect(existsSync(keep)).toBe(true);
    expect(existsSync(own)).toBe(false);
  });

  it("fork: shows its parent's files by the fork point; deleting the parent keeps them for the fork; deleting the fork then deletes them", async () => {
    const p = chat();
    const early = await deliver(p.id, "early.txt", "e");
    const forkedAt = new Date().toISOString();
    await delay(5);
    await deliver(p.id, "late.txt", "l");
    const f = chat({ parentChatId: p.id, forkedFrom: p.id, chatRole: "fork", forkedAt });
    expect(await names(f.id)).toEqual(["early.txt"]);
    await remove(p.id);
    expect(existsSync(early)).toBe(true);
    expect(await names(f.id)).toEqual(["early.txt"]);
    await remove(f.id);
    expect(existsSync(early)).toBe(false);
  });

  it("a fork's cards serve its parent's files delivered by forkedAt, and 404 for later ones (review round 2)", async () => {
    const p = chat();
    const early = await deliver(p.id, "early.txt", "e");
    const forkedAt = new Date().toISOString();
    await delay(5);
    const late = await deliver(p.id, "late.txt", "l");
    const f = chat({ parentChatId: p.id, forkedFrom: p.id, chatRole: "fork", forkedAt });
    const server = express();
    server.use("/api/files", createFilesRouter({ dataDir: DATA }));
    const app = await listenRaw(server);
    try {
      const get = (path: string, chatId: string) => app.request("GET", `/api/files/serve?path=${encodeURIComponent(path)}&download=1&chat=${chatId}`);
      expect((await get(early, f.id)).status).toBe(200);
      expect((await get(late, f.id)).status).toBe(404);
      // The parent itself still serves both.
      expect((await get(late, p.id)).status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("a child spawned with role engine-switch (start_chat_session / stream route) shows and serves nothing of its parent's (review round 2)", async () => {
    const p = chat();
    const file = await deliver(p.id, "parent.txt", "p");
    for (const role of ["engine-switch", "fork", "aside"]) {
      const child = chat({ parentChatId: p.id, rootChatId: p.id, chatRole: role });
      expect(await names(child.id)).toEqual([]);
      expect(chatDeliverySources(child.id).map((s) => s.chatId)).toEqual([child.id]);
    }
    // Deleting the parent while those children survive deletes its files: none of them shows them.
    await remove(p.id);
    expect(existsSync(file)).toBe(false);
  });

  it("a detached fork no longer keeps its deleted parent's files: the detach sweeps them (review round 2)", async () => {
    const p = chat();
    const file = await deliver(p.id, "p.txt", "p");
    const f = chat({ parentChatId: p.id, forkedFrom: p.id, chatRole: "fork", forkedAt: new Date().toISOString() });
    await remove(p.id);
    expect(existsSync(file)).toBe(true);
    expect(detachChatFromParent(chatFileService.getChat(f.id)!)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(existsSync(file)).toBe(false));
  });

  it("the reaper's sweep removes stranded deliverables of deleted chats by any path, and never an untombstoned (possibly live) chat's", async () => {
    const p = chat();
    const stranded = await deliver(p.id, "s.txt", "s");
    const f = chat({ parentChatId: p.id, forkedFrom: p.id, chatRole: "fork", forkedAt: new Date().toISOString() });
    await remove(p.id);
    // Some other path drops the link (not detach).
    chatFileService.updateChatMetadata(f.id, { parentChatId: undefined, forkedFrom: undefined, chatRole: undefined, forkedAt: undefined });
    // A directory of a chat id with no record and no tombstone: e.g. a chat that exists only as a session log.
    const unknown = await deliver(randomUUID(), "u.txt", "u");
    expect(await sweepDeletedDeliverables()).toBeGreaterThanOrEqual(1);
    expect(existsSync(stranded)).toBe(false);
    expect(existsSync(unknown)).toBe(true);
  });

  it("an ordinary child chat (no copied history) shows nothing of its parent's", async () => {
    const p = chat();
    await deliver(p.id, "parent.txt", "p");
    const child = chat({ parentChatId: p.id, rootChatId: p.id });
    expect(await names(child.id)).toEqual([]);
  });
});
