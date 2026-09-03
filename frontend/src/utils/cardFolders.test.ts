import { describe, expect, it } from "vitest";
import type { CardMemberChat, CardSummary } from "../api";
import { cardFolders } from "./cardFolders";

function member(overrides: Partial<CardMemberChat> & Pick<CardMemberChat, "chatId" | "folder">): CardMemberChat {
  return {
    title: null,
    status: "stopped",
    hasSummon: false,
    unread: false,
    isTriggered: false,
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
    ...overrides,
  };
}

/** The card's id IS its root chat's id, which is how the root folder is found. */
function card(memberChats: CardMemberChat[]): CardSummary {
  return {
    id: "root-chat",
    title: "Ship the thing",
    description: "",
    emoji: "🚀",
    lifecycle: "open",
    pinned: false,
    rollup: "idle",
    lastActivityAt: "2026-08-07T11:00:00.000Z",
    chatCount: memberChats.length,
    unread: false,
    memberChats,
    memberRuns: [],
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-07T11:00:00.000Z",
  };
}

describe("cardFolders", () => {
  it("collapses every member of one folder into a single entry — the 97% case", () => {
    const folders = cardFolders(
      card([
        member({ chatId: "root-chat", folder: "/home/cybil/callboard", updatedAt: "2026-08-07T09:00:00.000Z" }),
        member({ chatId: "b", folder: "/home/cybil/callboard", updatedAt: "2026-08-07T12:00:00.000Z" }),
        member({ chatId: "c", folder: "/home/cybil/callboard", updatedAt: "2026-08-07T10:00:00.000Z" }),
      ]),
    );

    expect(folders).toEqual([{ path: "/home/cybil/callboard", chatCount: 3, lastActivityAt: "2026-08-07T12:00:00.000Z", isRoot: true }]);
  });

  it("pins the root folder first even when it is the quietest and deadest", () => {
    const folders = cardFolders(
      card([
        member({ chatId: "root-chat", folder: "/home/cybil/callboard", updatedAt: "2026-01-01T00:00:00.000Z" }),
        member({ chatId: "b", folder: "/home/cybil/callboard.feat-a", status: "ongoing", updatedAt: "2026-08-07T12:00:00.000Z" }),
        member({ chatId: "c", folder: "/home/cybil/callboard.feat-b", status: "waiting", updatedAt: "2026-08-07T11:00:00.000Z" }),
      ]),
    );

    expect(folders.map((f) => f.path)).toEqual([
      "/home/cybil/callboard",
      // waiting outranks ongoing under the root, regardless of recency.
      "/home/cybil/callboard.feat-b",
      "/home/cybil/callboard.feat-a",
    ]);
    expect(folders[0].live).toBeUndefined();
  });

  it("orders non-root folders live-first, then by recency", () => {
    const folders = cardFolders(
      card([
        member({ chatId: "root-chat", folder: "/root", updatedAt: "2026-08-07T12:00:00.000Z" }),
        member({ chatId: "stale-live", folder: "/a", status: "ongoing", updatedAt: "2026-01-01T00:00:00.000Z" }),
        member({ chatId: "recent-dead", folder: "/b", updatedAt: "2026-08-07T13:00:00.000Z" }),
        member({ chatId: "old-dead", folder: "/c", updatedAt: "2026-06-01T00:00:00.000Z" }),
      ]),
    );

    expect(folders.map((f) => f.path)).toEqual(["/root", "/a", "/b", "/c"]);
  });

  it("takes a folder's live state from its most urgent chat and its time from its most recent", () => {
    const folders = cardFolders(
      card([
        member({ chatId: "root-chat", folder: "/root" }),
        member({ chatId: "a", folder: "/shared", status: "ongoing", updatedAt: "2026-08-07T12:00:00.000Z" }),
        member({ chatId: "b", folder: "/shared", status: "waiting", updatedAt: "2026-08-07T09:00:00.000Z" }),
        member({ chatId: "c", folder: "/shared", status: "stopped", updatedAt: "2026-08-07T14:00:00.000Z" }),
      ]),
    );

    expect(folders.find((f) => f.path === "/shared")).toEqual({
      path: "/shared",
      chatCount: 3,
      live: "waiting",
      lastActivityAt: "2026-08-07T14:00:00.000Z",
      isRoot: false,
    });
  });

  // Both of the next two are real states, not defensive ones: isCardEligible
  // has no provider check but the member grouping skips retired providers, so
  // a card can outlive its own member row — or all of them.
  it("returns an empty list when the card has no member chats", () => {
    expect(cardFolders(card([]))).toEqual([]);
  });

  it("still lists the surviving folders when the root's own member row is missing", () => {
    const folders = cardFolders(
      card([
        member({ chatId: "child-a", folder: "/home/cybil/callboard.feat-a", status: "ongoing", updatedAt: "2026-08-07T12:00:00.000Z" }),
        member({ chatId: "child-b", folder: "/home/cybil/callboard.feat-b", updatedAt: "2026-08-07T11:00:00.000Z" }),
      ]),
    );

    expect(folders.map((f) => f.path)).toEqual(["/home/cybil/callboard.feat-a", "/home/cybil/callboard.feat-b"]);
    expect(folders.every((f) => !f.isRoot)).toBe(true);
  });
});
