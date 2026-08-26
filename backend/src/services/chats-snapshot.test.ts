/**
 * Tests for the stat-gated chats snapshot — the lineage corpus the board
 * rollup reads.
 *
 * The interesting half is not "does it return the records" — a plain scan does
 * that — but that reuse is gated on the file actually being unchanged, and
 * that every way a record can move (gain fields, lose them, be deleted, be
 * unreadable) reaches the next caller. Records are written directly rather
 * than through chatFileService so a test can control mtime and size, which is
 * the whole contract under test.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat } from "shared";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-chats-snapshot-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const chatsDir = join(tmpRoot, "chats");
mkdirSync(chatsDir, { recursive: true });

/**
 * Chat files the snapshot actually opened, in order. The whole point of the
 * snapshot is that this list stays short, so it is the thing worth asserting —
 * "does it return records" a plain rescan would also pass.
 */
const reads: string[] = [];
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readFileSync: (path: any, ...rest: any[]) => {
      if (typeof path === "string") reads.push(path);
      return (actual.readFileSync as any)(path, ...rest);
    },
  };
});

/** Chat filenames the snapshot opened since the last {@link beforeEach}. */
function readsInChatsDir(): string[] {
  return reads.filter((p) => p.startsWith(chatsDir)).map((p) => p.slice(chatsDir.length + 1));
}

const { listChatsSnapshot, resetChatsSnapshot } = await import("./chats-snapshot.js");

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function chat(sessionId: string, meta: Record<string, unknown>, overrides: Partial<Chat> = {}): Chat {
  return {
    id: sessionId,
    folder: "/tmp/project",
    session_id: sessionId,
    session_log_path: null,
    metadata: JSON.stringify(meta),
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as Chat;
}

/** Write a record straight to disk, as chatFileService does (same filename rule). */
function write(sessionId: string, meta: Record<string, unknown>, overrides: Partial<Chat> = {}): void {
  writeFileSync(join(chatsDir, `${sessionId}.json`), JSON.stringify(chat(sessionId, meta, overrides), null, 2));
}

/**
 * Push a record's mtime into the past, so the snapshot is willing to cache it.
 * A just-written file is inside its own mtime tick and deliberately is not
 * cacheable — see COARSE_MTIME_WINDOW_MS — which every test about *reuse* has
 * to step around, and one test below is about precisely that rule.
 */
function age(sessionId: string, secondsAgo = 3600): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(join(chatsDir, `${sessionId}.json`), when, when);
}

function snapshotIds(): string[] {
  return listChatsSnapshot()
    .map((c) => c.id)
    .sort();
}

beforeEach(() => {
  rmSync(chatsDir, { recursive: true, force: true });
  mkdirSync(chatsDir, { recursive: true });
  resetChatsSnapshot();
  reads.length = 0;
});

describe("listChatsSnapshot", () => {
  it("returns every chat record — card roots and members alike", () => {
    // Unlike its cardId-filtered predecessor, the snapshot keeps all records:
    // the lineage model has no membership key to filter on, and any record
    // can be a root or a member of any root's tree.
    write("root", { title: "A card root" });
    write("child", { parentChatId: "root", rootChatId: "root" });
    write("triggered", { triggered: true });
    write("job-step", { jobRunId: "run-1" });

    expect(snapshotIds()).toEqual(["child", "job-step", "root", "triggered"]);
  });

  it("picks up a chat that gains card fields after the first scan", () => {
    write("later", { title: "Loose" });
    expect(snapshotIds()).toEqual(["later"]);

    write("later", { title: "Loose", card: { lifecycle: "closed" } });
    const chat = listChatsSnapshot().find((c) => c.id === "later")!;
    expect(JSON.parse(chat.metadata).card).toEqual({ lifecycle: "closed" });
  });

  it("drops a chat whose file is deleted", () => {
    write("doomed", { title: "Doomed" });
    write("kept", { title: "Kept" });
    expect(snapshotIds()).toEqual(["doomed", "kept"]);

    unlinkSync(join(chatsDir, "doomed.json"));
    expect(snapshotIds()).toEqual(["kept"]);
  });

  it("re-reads a same-length rewrite, because the timestamp moved", () => {
    // Both blobs are the same byte length, so size alone would say "unchanged".
    write("swap", { card: { title: "aaa" } });
    expect(JSON.parse(listChatsSnapshot().find((c) => c.id === "swap")!.metadata).card.title).toBe("aaa");

    const before = statSync(join(chatsDir, "swap.json")).size;
    write("swap", { card: { title: "bbb" } });
    expect(statSync(join(chatsDir, "swap.json")).size).toBe(before);

    expect(JSON.parse(listChatsSnapshot().find((c) => c.id === "swap")!.metadata).card.title).toBe("bbb");
  });

  it("opens each record once and then only the ones that moved", () => {
    // The performance claim, stated as behaviour: a second scan of an
    // untouched directory reads nothing, and a third reads exactly the file
    // that changed. Without this, every assertion above would still pass
    // against a plain rescan.
    write("a", { title: "One" });
    write("b", { title: "Two" });
    write("c", { title: "Three" });
    ["a", "b", "c"].forEach((id) => age(id));

    listChatsSnapshot();
    expect(readsInChatsDir().sort()).toEqual(["a.json", "b.json", "c.json"]);

    reads.length = 0;
    expect(snapshotIds()).toEqual(["a", "b", "c"]);
    expect(readsInChatsDir()).toEqual([]);

    reads.length = 0;
    write("b", { title: "Two edited" });
    age("b");
    expect(snapshotIds()).toEqual(["a", "b", "c"]);
    expect(readsInChatsDir()).toEqual(["b.json"]);
  });

  it("skips an unreadable record without caching the failure", () => {
    write("good", { title: "Good" });
    writeFileSync(join(chatsDir, "corrupt.json"), "{ not json");
    ["good", "corrupt"].forEach((id) => age(id));
    expect(snapshotIds()).toEqual(["good"]);

    // The rule, asserted directly rather than inferred: a failed read is NOT
    // remembered, so the file is opened again on an otherwise-warm scan. This
    // is what stops a transient failure (EMFILE, a record caught mid-rewrite)
    // latching a chat off the board until something happens to touch it —
    // repairing the file would move its mtime and force a re-read either way,
    // so only the read count can tell the two designs apart.
    reads.length = 0;
    expect(snapshotIds()).toEqual(["good"]);
    expect(readsInChatsDir()).toEqual(["corrupt.json"]);

    // And a repaired file comes back.
    write("corrupt", { title: "Repaired" });
    expect(snapshotIds()).toEqual(["corrupt", "good"]);
  });

  it("does not cache a record still inside its own mtime tick", () => {
    // A just-written file could be written again in the same tick, so its
    // (mtime, size) is not yet evidence of anything. Two warm scans in a row
    // both open it.
    write("fresh", { title: "Fresh" });
    expect(snapshotIds()).toEqual(["fresh"]);

    reads.length = 0;
    expect(snapshotIds()).toEqual(["fresh"]);
    expect(readsInChatsDir()).toEqual(["fresh.json"]);

    // And once the tick has closed it becomes cacheable, so this is a delay
    // rather than an opt-out.
    age("fresh");
    listChatsSnapshot();
    reads.length = 0;
    expect(snapshotIds()).toEqual(["fresh"]);
    expect(readsInChatsDir()).toEqual([]);
  });

  it("sees a rewrite that a whole-second clock would have hidden", () => {
    // ext3, HFS+ and FAT report mtime in whole seconds or worse, so two writes
    // to one record inside a tick present the *same* (mtime, size) — and these
    // rewrites are equal-length by nature. Simulated by pinning both writes to
    // the same recent second, which is what such a filesystem would report.
    const filepath = join(chatsDir, "coarse.json");
    const tick = new Date(Math.floor(Date.now() / 1000) * 1000);

    write("coarse", { card: { title: "aaa" } });
    utimesSync(filepath, tick, tick);
    expect(JSON.parse(listChatsSnapshot().find((c) => c.id === "coarse")!.metadata).card.title).toBe("aaa");

    write("coarse", { card: { title: "bbb" } });
    utimesSync(filepath, tick, tick);
    expect(statSync(filepath).size).toBeGreaterThan(0);

    expect(JSON.parse(listChatsSnapshot().find((c) => c.id === "coarse")!.metadata).card.title).toBe("bbb");
  });

  it("reuses an entry whose tick closed, even if the timestamp is then restored", () => {
    // The residual bound, stated rather than hoped about: once a record's tick
    // has closed the pair IS taken as evidence, so a rewrite that restores the
    // old timestamp is invisible. Nothing does that — writeFileSync always
    // moves mtime forward — but the window above is the whole of the guarantee,
    // and this is the other side of it.
    const filepath = join(chatsDir, "settled.json");
    write("settled", { card: { title: "aaa" } });
    age("settled");
    const { atime, mtime } = statSync(filepath);
    expect(JSON.parse(listChatsSnapshot().find((c) => c.id === "settled")!.metadata).card.title).toBe("aaa");

    write("settled", { card: { title: "bbb" } });
    utimesSync(filepath, atime, mtime);
    expect(JSON.parse(listChatsSnapshot().find((c) => c.id === "settled")!.metadata).card.title).toBe("aaa");
  });
});
