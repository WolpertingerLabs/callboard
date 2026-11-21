/**
 * card-fields over a root left carrying a child-archive flag
 * (`strandedChildArchiveAt`): an archived child whose parent went away is
 * promoted to the root of its own card, and that card reads as closed.
 *
 * The file service and the unpin are stubbed, so these are about what
 * card-fields reads and writes, not about the store.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CALLBOARD_DATA_DIR = mkdtempSync(join(tmpdir(), "callboard-card-fields-"));

let records: Record<string, { id: string; created_at: string; metadata: string }> = {};
const unpin = vi.fn();

vi.mock("./chat-file-service.js", () => ({
  chatFileService: {
    getChat: (id: string) => records[id] ?? null,
    updateChatMetadata: (id: string, fields: Record<string, unknown>) => {
      const rec = records[id];
      if (!rec) return false;
      rec.metadata = JSON.stringify({ ...JSON.parse(rec.metadata), ...fields });
      return true;
    },
  },
}));
vi.mock("./card-archive-unpin.js", () => ({ unpinArchivedCardChats: (...args: unknown[]) => unpin(...args) }));

const { cardFieldsFromChat, cardLifecycleOf, patchCardFields, strandedChildArchiveAt } = await import("./card-fields.js");
const { metaIsArchived } = await import("./chat-visibility.js");

const T = "2026-07-05T00:00:00.000Z";
const record = (id: string, meta: Record<string, unknown>) => {
  records[id] = { id, created_at: "2026-07-01T00:00:00.000Z", metadata: JSON.stringify(meta) };
  return records[id];
};
const metaOf = (id: string) => JSON.parse(records[id].metadata);

beforeEach(() => {
  records = {};
  unpin.mockClear();
});

describe("reading a stranded child-archive flag", () => {
  it("closes the card, with closedAt from childArchivedAt", () => {
    const chat = record("a", { parentChatId: "gone", childArchived: true, childArchivedAt: T });
    expect(cardLifecycleOf(chat)).toBe("closed");
    expect(cardFieldsFromChat(chat)).toMatchObject({ lifecycle: "closed", closedAt: T });
    expect(metaIsArchived(metaOf("a"), true)).toBe(true);
  });

  it("counts forkedFrom as the parent pointer, and tolerates a missing stamp", () => {
    const chat = record("a", { forkedFrom: "gone", childArchived: true });
    expect(strandedChildArchiveAt(metaOf("a"))).toBe("");
    expect(cardFieldsFromChat(chat).lifecycle).toBe("closed");
    expect(cardFieldsFromChat(chat).closedAt).toBeUndefined();
  });

  it("keeps a stored closedAt over childArchivedAt", () => {
    const chat = record("a", {
      parentChatId: "gone",
      childArchived: true,
      childArchivedAt: T,
      card: { lifecycle: "closed", closedAt: "2026-07-09T00:00:00.000Z" },
    });
    expect(cardFieldsFromChat(chat).closedAt).toBe("2026-07-09T00:00:00.000Z");
  });

  it("ignores the flag without a parent pointer", () => {
    const chat = record("a", { childArchived: true, childArchivedAt: T });
    expect(cardLifecycleOf(chat)).toBe("open");
    expect(cardFieldsFromChat(chat).closedAt).toBeUndefined();
    expect(metaIsArchived(metaOf("a"), true)).toBe(false);
  });

  it("does not change a non-card root's archive rule", () => {
    record("a", { parentChatId: "gone", childArchived: true, triggered: true });
    expect(metaIsArchived(metaOf("a"), false)).toBe(false);
  });
});

describe("patchCardFields on a stranded root", () => {
  it("reopening clears the flag in the same write", () => {
    record("a", { parentChatId: "gone", childArchived: true, childArchivedAt: T, title: "x" });
    const card = patchCardFields("a", { lifecycle: "open" });
    expect(card?.lifecycle).toBe("open");
    const meta = metaOf("a");
    expect(meta.childArchived).toBeUndefined();
    expect(meta.childArchivedAt).toBeUndefined();
    expect(meta.parentChatId).toBe("gone");
    expect(cardLifecycleOf(records.a)).toBe("open");
  });

  it("reopens a stored-closed root and clears the flag too", () => {
    record("a", { parentChatId: "gone", childArchived: true, card: { lifecycle: "closed", closedAt: T } });
    expect(patchCardFields("a", { lifecycle: "open" })?.lifecycle).toBe("open");
    expect(metaOf("a").childArchived).toBeUndefined();
    expect(metaOf("a").card.closedAt).toBeUndefined();
  });

  it("re-closing is not a transition: no new closedAt, no unpin", () => {
    record("a", { parentChatId: "gone", childArchived: true, childArchivedAt: T });
    const card = patchCardFields("a", { lifecycle: "closed" });
    expect(card).toMatchObject({ lifecycle: "closed", closedAt: T });
    expect(metaOf("a").card.lifecycle).toBeUndefined();
    expect(metaOf("a").childArchived).toBe(true);
    expect(unpin).not.toHaveBeenCalled();
  });

  it("an unrelated edit leaves it closed and does not unpin", () => {
    record("a", { parentChatId: "gone", childArchived: true, childArchivedAt: T });
    expect(patchCardFields("a", { title: "renamed" })?.lifecycle).toBe("closed");
    expect(patchCardFields("a", { hidden: true })?.lifecycle).toBe("closed");
    expect(unpin).not.toHaveBeenCalled();
    expect(metaOf("a").childArchived).toBe(true);
  });

  it("an ordinary close still unpins", () => {
    record("b", {});
    patchCardFields("b", { lifecycle: "closed" });
    expect(unpin).toHaveBeenCalledOnce();
  });
});
