/**
 * The Pinned/Recent split.
 *
 * Every fixture here is deliberately in the WRONG order to start with —
 * unpinned first, or interleaved. A partition test whose input already happens
 * to be bucket-ordered passes with the partition deleted, which is exactly the
 * false green this module can produce.
 */
import { describe, expect, it } from "vitest";
import type { Chat } from "../api";
import { compareSidebarFolders, isChatPinned, sectionByPinned, sectionChatRows } from "./chatSections";

const chat = (id: string, meta: Record<string, unknown> = {}): Pick<Chat, "id" | "metadata"> => ({
  id,
  metadata: JSON.stringify(meta),
});

const pinnedChat = (id: string) => chat(id, { pinned: true });
const ids = (sections: { items: Pick<Chat, "id">[] }[]) => sections.map((s) => s.items.map((i) => i.id));
const byPin = (c: Pick<Chat, "metadata">) => isChatPinned(c);

describe("sectionByPinned", () => {
  it("puts Pinned before Recent even when the input is the other way round", () => {
    // Input order is unpinned-first: if the partition were dropped and the
    // array returned as-is, this would come back reversed.
    const items = [chat("loose"), pinnedChat("kept"), chat("other")];
    const sections = sectionByPinned(items, byPin)!;

    // Keys and labels are separate strings for a reason: the headers can be
    // relabelled freely, while the keys stay "pinned"/"recent" because the
    // expand/collapse preference is stored under them and a rename would
    // forget every user's collapsed section.
    expect(sections.map((s) => s.key)).toEqual(["pinned", "recent"]);
    expect(sections.map((s) => s.label)).toEqual(["Pinned", "Recent"]);
    expect(ids(sections)).toEqual([["kept"], ["loose", "other"]]);
  });

  it("preserves the incoming order within each section", () => {
    // Interleaved on the way in; each bucket must come out in the order the
    // list handed them over — which is recency order in the sidebar.
    const items = [pinnedChat("a"), chat("b"), pinnedChat("c"), chat("d"), pinnedChat("e")];
    expect(ids(sectionByPinned(items, byPin)!)).toEqual([
      ["a", "c", "e"],
      ["b", "d"],
    ]);
  });

  it("returns null when nothing is pinned, which is the whole gate", () => {
    // The overwhelmingly common sidebar: no pins, no headers, the list exactly
    // as it rendered before this feature existed.
    expect(sectionByPinned([chat("a"), chat("b")], byPin)).toBeNull();
    expect(sectionByPinned([], byPin)).toBeNull();
    // Control: the same shape of list DOES section once one of them is pinned,
    // so the null above is "nothing pinned" and not an unsplittable fixture.
    expect(sectionByPinned([chat("a"), pinnedChat("b")], byPin)).not.toBeNull();
  });

  it("still sections when EVERYTHING is pinned, and omits the empty bucket", () => {
    // The deliberate difference from the Open/Archived split this replaced,
    // which collapsed whenever either bucket was empty. "Pinned" is the only
    // confirmation on screen that the pin took, and it is the fold control the
    // user has a stored preference for — dropping it as the last unpinned chat
    // scrolls out would flip the list between two layouts while paging.
    const sections = sectionByPinned([pinnedChat("a"), pinnedChat("b")], byPin)!;
    expect(sections.map((s) => [s.key, s.count])).toEqual([["pinned", 2]]);
    // And no "RECENT (0)" band under it — an empty bucket is omitted, never
    // rendered as a header over nothing.
    expect(sections).toHaveLength(1);
  });

  it("counts one per item by default", () => {
    const sections = sectionByPinned([pinnedChat("a"), chat("b"), chat("c")], byPin)!;
    expect(sections.map((s) => s.count)).toEqual([1, 2]);
  });

  it("counts by countOf, so a tree row can speak for its whole group", () => {
    // A row stands for a whole lineage group. Counting rows would report 1
    // for a three-chat group — the header must count chats.
    const rows = [
      { chat: chat("loose"), size: 1 },
      { chat: pinnedChat("group"), size: 3 },
      { chat: chat("pair"), size: 2 },
    ];
    const sections = sectionByPinned(
      rows,
      (row) => byPin(row.chat),
      (row) => row.size,
    )!;
    expect(sections.map((s) => [s.key, s.items.length, s.count])).toEqual([
      ["pinned", 1, 3],
      ["recent", 2, 3],
    ]);
  });

  it("files a lineage group WHOLE, by its header row, when its members straddle both buckets", () => {
    // The rule the generic exists for. A group is ONE row: pinning a member
    // that is not the header row cannot pull that member out on its own, and
    // pinning the header row takes the whole group up with it. The count
    // follows the filing, which is why 4 lands entirely under "pinned".
    const rows = [
      { rootKey: "r1", chat: chat("plain"), size: 1 },
      { rootKey: "r2", chat: pinnedChat("header-of-group"), size: 4 },
    ];
    const sections = sectionByPinned(
      rows,
      (row) => byPin(row.chat),
      (row) => row.size,
    )!;
    expect(sections.map((s) => [s.key, s.count])).toEqual([
      ["pinned", 4],
      ["recent", 1],
    ]);
    // ...and the group appears exactly once, under its header row's section.
    expect(sections.flatMap((s) => s.items.map((r) => r.rootKey))).toEqual(["r2", "r1"]);
  });

  it("sections whatever the caller's item type is, not just chats", () => {
    // The sidebar sections ROWS, each wrapping the chat that fronts a lineage
    // group — so the generic is load-bearing, not decoration.
    const rows = [
      { rootKey: "r1", chat: chat("loose") },
      { rootKey: "r2", chat: pinnedChat("kept") },
    ];
    const sections = sectionByPinned(rows, (row) => byPin(row.chat))!;
    expect(sections.map((s) => s.items.map((r) => r.rootKey))).toEqual([["r2"], ["r1"]]);
  });
});

/**
 * The flag is JSON on the chat, so it can be anything a hand edit, an older
 * build or a truncated write left behind. A throw here would take the whole
 * sidebar down, and a truthy non-`true` would file a row the user never pinned.
 */
describe("isChatPinned", () => {
  it("reads metadata.pinned", () => {
    expect(isChatPinned(chat("a", { pinned: true }))).toBe(true);
    expect(isChatPinned(chat("b", { pinned: false }))).toBe(false);
    expect(isChatPinned(chat("c"))).toBe(false);
  });

  it("is not the bookmark, in either direction", () => {
    // The two flags are independent by decision, not by accident: a bookmark
    // is a filter you go looking through, a pin is a position you put a chat
    // in. Reading one for the other would file every bookmark at the top.
    expect(isChatPinned(chat("a", { bookmarked: true }))).toBe(false);
    expect(isChatPinned(chat("b", { pinned: true, bookmarked: false }))).toBe(true);
  });

  it("demands the boolean, not merely something truthy", () => {
    expect(isChatPinned(chat("a", { pinned: "yes" }))).toBe(false);
    expect(isChatPinned(chat("b", { pinned: 1 }))).toBe(false);
  });

  it("answers false for unparseable metadata rather than throwing", () => {
    expect(isChatPinned({ metadata: "{not json" } as Pick<Chat, "metadata">)).toBe(false);
    expect(isChatPinned({ metadata: null } as unknown as Pick<Chat, "metadata">)).toBe(false);
  });
});

describe("sectionChatRows — folders", () => {
  type Item = { id: string; pinned?: boolean; folder?: string; size?: number };
  const opts = {
    isPinned: (i: Item) => i.pinned === true,
    folderOf: (i: Item) => i.folder,
    countOf: (i: Item) => i.size ?? 1,
  };
  const keys = (sections: { key: string }[] | null) => sections?.map((s) => s.key);

  it("orders Pinned, then folders alphabetically (case-insensitive), then Recent", () => {
    // Deliberately scrambled: Recent first, folders out of order, pin last.
    const items: Item[] = [
      { id: "loose" },
      { id: "w1", folder: "work" },
      { id: "a1", folder: "Alpha" },
      { id: "z1", folder: "zeta" },
      { id: "B1", folder: "beta" },
      { id: "p1", pinned: true },
    ];
    const sections = sectionChatRows(items, opts)!;
    expect(keys(sections)).toEqual(["pinned", "folder:Alpha", "folder:beta", "folder:work", "folder:zeta", "recent"]);
    expect(sections.map((s) => s.label)).toEqual(["Pinned", "Alpha", "beta", "work", "zeta", "Recent"]);
  });

  it("preserves incoming order within a folder", () => {
    const items: Item[] = [{ id: "a", folder: "F" }, { id: "x" }, { id: "b", folder: "F" }, { id: "c", folder: "F" }];
    const sections = sectionChatRows(items, opts)!;
    expect(sections.find((s) => s.key === "folder:F")!.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("returns null only when nothing is pinned AND nothing is in a folder", () => {
    expect(sectionChatRows<Item>([{ id: "a" }, { id: "b" }], opts)).toBeNull();
    expect(sectionChatRows<Item>([], opts)).toBeNull();
    // A folder alone is enough to section, with no Pinned header.
    expect(keys(sectionChatRows<Item>([{ id: "a", folder: "F" }, { id: "b" }], opts))).toEqual(["folder:F", "recent"]);
  });

  it("never emits an empty (0) section: a folder exists only while a row is in it", () => {
    const sections = sectionChatRows<Item>([{ id: "a", folder: "F" }], opts)!;
    expect(keys(sections)).toEqual(["folder:F"]);
    expect(sections.every((s) => s.items.length > 0 && s.count > 0)).toBe(true);
  });

  it("files a pinned row under Pinned only, even when it names a folder", () => {
    const sections = sectionChatRows<Item>([{ id: "both", pinned: true, folder: "F" }, { id: "other", folder: "F" }], opts)!;
    expect(keys(sections)).toEqual(["pinned", "folder:F"]);
    expect(sections.flatMap((s) => s.items.map((i) => i.id))).toEqual(["both", "other"]);
    // A pinned row that is the folder's only member leaves no folder section behind.
    expect(keys(sectionChatRows<Item>([{ id: "both", pinned: true, folder: "F" }, { id: "x" }], opts))).toEqual(["pinned", "recent"]);
  });

  it("counts chats, not rows, per folder", () => {
    const sections = sectionChatRows<Item>([{ id: "group", folder: "F", size: 4 }, { id: "lone", folder: "F" }, { id: "r" }], opts)!;
    expect(sections.map((s) => [s.key, s.count])).toEqual([
      ["folder:F", 5],
      ["recent", 1],
    ]);
  });

  it("keys a folder named like a built-in section distinctly", () => {
    const sections = sectionChatRows<Item>([{ id: "a", folder: "pinned" }, { id: "b", folder: "Recent" }, { id: "p", pinned: true }], opts)!;
    expect(keys(sections)).toEqual(["pinned", "folder:pinned", "folder:Recent"]);
  });

  it("is what sectionByPinned does when there are no folders", () => {
    const items: Item[] = [{ id: "a" }, { id: "p", pinned: true }];
    expect(sectionByPinned(items, opts.isPinned)).toEqual(sectionChatRows(items, { isPinned: opts.isPinned }));
  });
});

describe("compareSidebarFolders", () => {
  it("is case-insensitive first, then exact, so the order is total", () => {
    expect(["b", "B", "a", "A"].sort(compareSidebarFolders)).toEqual(["A", "a", "B", "b"]);
  });
});
