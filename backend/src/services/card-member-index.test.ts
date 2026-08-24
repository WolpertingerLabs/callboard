/**
 * Tests for the stat-gated card membership index.
 *
 * The interesting half is not "does it find members" — a plain scan does that
 * — but that reuse is gated on the file actually being unchanged, and that
 * every way a record can move (gain a card, lose one, be deleted, be
 * unreadable) reaches the next caller. Records are written directly rather
 * than through chatFileService so a test can control mtime and size, which is
 * the whole contract under test.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chat } from "shared";

const tmpRoot = mkdtempSync(join(tmpdir(), "callboard-card-index-"));
process.env.CALLBOARD_DATA_DIR = tmpRoot;

const chatsDir = join(tmpRoot, "chats");
mkdirSync(chatsDir, { recursive: true });

/**
 * Chat records the index actually opened, in order. The whole point of the
 * index is that this list stays short, so it is the thing worth asserting —
 * "does it find members" a plain rescan would also pass.
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

/** Chat filenames the index opened since the last {@link beforeEach}. */
function readsInChatsDir(): string[] {
  return reads.filter((p) => p.startsWith(chatsDir)).map((p) => p.slice(chatsDir.length + 1));
}

const { listCardMemberChats, resetCardMemberIndex, chatCardId, metaCardId } = await import("./card-member-index.js");

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
 * Push a record's mtime into the past, so the index is willing to cache it.
 * A just-written file is inside its own mtime tick and deliberately is not
 * cacheable — see COARSE_MTIME_WINDOW_MS — which every test about *reuse* has
 * to step around, and one test below is about precisely that rule.
 */
function age(sessionId: string, secondsAgo = 3600): void {
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(join(chatsDir, `${sessionId}.json`), when, when);
}

function memberIds(): string[] {
  return listCardMemberChats()
    .map((c) => c.id)
    .sort();
}

beforeEach(() => {
  rmSync(chatsDir, { recursive: true, force: true });
  mkdirSync(chatsDir, { recursive: true });
  resetCardMemberIndex();
  reads.length = 0;
});

describe("metaCardId / chatCardId", () => {
  it("reads a non-empty string cardId and nothing else", () => {
    expect(metaCardId({ cardId: "card-1" })).toBe("card-1");
    // Unassign merges `cardId: null` — the key stays, membership does not.
    expect(metaCardId({ cardId: null })).toBeUndefined();
    expect(metaCardId({ cardId: "" })).toBeUndefined();
    expect(metaCardId({ cardId: 7 })).toBeUndefined();
    expect(metaCardId({})).toBeUndefined();
    expect(metaCardId(null)).toBeUndefined();
    expect(metaCardId("card-1")).toBeUndefined();
  });

  it("survives a metadata blob that is not JSON", () => {
    expect(chatCardId({ metadata: "not json {" })).toBeUndefined();
    expect(chatCardId({ metadata: "" })).toBeUndefined();
    expect(chatCardId({ metadata: JSON.stringify({ cardId: "card-9" }) })).toBe("card-9");
  });
});

describe("listCardMemberChats", () => {
  it("returns only the records carrying a cardId", () => {
    write("on-card", { cardId: "card-1" });
    write("also-on-card", { cardId: "card-2", title: "Two" });
    write("no-card", { title: "Loose" });
    write("unassigned", { cardId: null });

    expect(memberIds()).toEqual(["also-on-card", "on-card"]);
  });

  it("picks up a chat that gains membership after the first scan", () => {
    write("later", { title: "Loose" });
    expect(memberIds()).toEqual([]);

    write("later", { title: "Loose", cardId: "card-1" });
    expect(memberIds()).toEqual(["later"]);
  });

  it("drops a chat that is unassigned after the first scan", () => {
    write("filed", { cardId: "card-1" });
    expect(memberIds()).toEqual(["filed"]);

    write("filed", { cardId: null });
    expect(memberIds()).toEqual([]);
  });

  it("drops a member whose file is deleted", () => {
    write("doomed", { cardId: "card-1" });
    write("kept", { cardId: "card-1" });
    expect(memberIds()).toEqual(["doomed", "kept"]);

    unlinkSync(join(chatsDir, "doomed.json"));
    expect(memberIds()).toEqual(["kept"]);
  });

  it("re-reads a same-length rewrite, because the timestamp moved", () => {
    // Both blobs are the same byte length, so size alone would say "unchanged".
    write("swap", { cardId: "card-aaa" });
    expect(listCardMemberChats().map((c) => chatCardId(c))).toEqual(["card-aaa"]);

    const before = statSync(join(chatsDir, "swap.json")).size;
    write("swap", { cardId: "card-bbb" });
    expect(statSync(join(chatsDir, "swap.json")).size).toBe(before);

    expect(listCardMemberChats().map((c) => chatCardId(c))).toEqual(["card-bbb"]);
  });

  it("opens each record once and then only the ones that moved", () => {
    // The performance claim, stated as behaviour: a second scan of an
    // untouched directory reads nothing, and a third reads exactly the file
    // that changed. Without this, every assertion above would still pass
    // against a plain rescan.
    write("a", { cardId: "card-1" });
    write("b", { title: "Loose" });
    write("c", { cardId: "card-2" });
    ["a", "b", "c"].forEach((id) => age(id));

    listCardMemberChats();
    expect(readsInChatsDir().sort()).toEqual(["a.json", "b.json", "c.json"]);

    reads.length = 0;
    expect(memberIds()).toEqual(["a", "c"]);
    expect(readsInChatsDir()).toEqual([]);

    // Including the ~97% that are not members: `b` is remembered as a miss, so
    // it is not re-read either — that is what keeps the warm scan flat.
    reads.length = 0;
    write("b", { title: "Loose", cardId: "card-3" });
    age("b");
    expect(memberIds()).toEqual(["a", "b", "c"]);
    expect(readsInChatsDir()).toEqual(["b.json"]);
  });

  it("skips an unreadable record without caching the failure", () => {
    write("good", { cardId: "card-1" });
    writeFileSync(join(chatsDir, "corrupt.json"), "{ not json");
    ["good", "corrupt"].forEach((id) => age(id));
    expect(memberIds()).toEqual(["good"]);

    // The rule, asserted directly rather than inferred: a failed read is NOT
    // remembered, so the file is opened again on an otherwise-warm scan. This
    // is what stops a transient failure (EMFILE, a record caught mid-rewrite)
    // latching a chat off the board until something happens to touch it —
    // repairing the file would move its mtime and force a re-read either way,
    // so only the read count can tell the two designs apart.
    reads.length = 0;
    expect(memberIds()).toEqual(["good"]);
    expect(readsInChatsDir()).toEqual(["corrupt.json"]);

    // And a repaired file becomes a member.
    write("corrupt", { cardId: "card-1" });
    expect(memberIds()).toEqual(["corrupt", "good"]);
  });

  it("does not cache a record still inside its own mtime tick", () => {
    // A just-written file could be written again in the same tick, so its
    // (mtime, size) is not yet evidence of anything. Two warm scans in a row
    // both open it.
    write("fresh", { cardId: "card-1" });
    expect(memberIds()).toEqual(["fresh"]);

    reads.length = 0;
    expect(memberIds()).toEqual(["fresh"]);
    expect(readsInChatsDir()).toEqual(["fresh.json"]);

    // And once the tick has closed it becomes cacheable, so this is a delay
    // rather than an opt-out.
    age("fresh");
    listCardMemberChats();
    reads.length = 0;
    expect(memberIds()).toEqual(["fresh"]);
    expect(readsInChatsDir()).toEqual([]);
  });

  it("sees a rewrite that a whole-second clock would have hidden", () => {
    // ext3, HFS+ and FAT report mtime in whole seconds or worse, so two writes
    // to one record inside a tick present the *same* (mtime, size) — and these
    // rewrites are equal-length by nature. Simulated by pinning both writes to
    // the same recent second, which is what such a filesystem would report.
    const filepath = join(chatsDir, "coarse.json");
    const tick = new Date(Math.floor(Date.now() / 1000) * 1000);

    write("coarse", { cardId: "card-aaa" });
    utimesSync(filepath, tick, tick);
    expect(listCardMemberChats().map((c) => chatCardId(c))).toEqual(["card-aaa"]);

    write("coarse", { cardId: "card-bbb" });
    utimesSync(filepath, tick, tick);
    expect(statSync(filepath).size).toBeGreaterThan(0);

    expect(listCardMemberChats().map((c) => chatCardId(c))).toEqual(["card-bbb"]);
  });

  it("reuses an entry whose tick closed, even if the timestamp is then restored", () => {
    // The residual bound, stated rather than hoped about: once a record's tick
    // has closed the pair IS taken as evidence, so a rewrite that restores the
    // old timestamp is invisible. Nothing does that — writeFileSync always
    // moves mtime forward — but the window above is the whole of the guarantee,
    // and this is the other side of it.
    const filepath = join(chatsDir, "settled.json");
    write("settled", { cardId: "card-aaa" });
    age("settled");
    const { atime, mtime } = statSync(filepath);
    expect(listCardMemberChats().map((c) => chatCardId(c))).toEqual(["card-aaa"]);

    write("settled", { cardId: "card-bbb" });
    utimesSync(filepath, atime, mtime);
    expect(listCardMemberChats().map((c) => chatCardId(c))).toEqual(["card-aaa"]);
  });

  it("ignores files that are not .json", () => {
    write("real", { cardId: "card-1" });
    writeFileSync(join(chatsDir, "real.json.tmp"), JSON.stringify(chat("tmp", { cardId: "card-1" })));
    writeFileSync(join(chatsDir, "notes.txt"), "hello");

    expect(memberIds()).toEqual(["real"]);
  });

  it("returns an empty list when the chats directory is missing", () => {
    rmSync(chatsDir, { recursive: true, force: true });
    expect(listCardMemberChats()).toEqual([]);
    mkdirSync(chatsDir, { recursive: true });
  });

  it("keeps the whole record, not just its id", () => {
    write("full", { cardId: "card-1", title: "Titled" }, { folder: "/tmp/somewhere", updated_at: "2026-08-01T00:00:00.000Z" });
    const [member] = listCardMemberChats();
    expect(member.folder).toBe("/tmp/somewhere");
    expect(member.updated_at).toBe("2026-08-01T00:00:00.000Z");
    expect(JSON.parse(member.metadata).title).toBe("Titled");
  });
});
