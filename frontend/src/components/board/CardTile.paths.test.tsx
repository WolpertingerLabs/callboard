/**
 * The tile's folder line. Kept out of CardTile.test.tsx, which is the
 * no-regression control for the selection contract and should stay readable as
 * exactly that.
 *
 * The measured shape of the data is the spec here: 97.1% of cards have at most
 * one path, so the single-folder tile must show one path and *nothing* else —
 * no count, no chevron, no `+0`.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CardMemberChat, CardSummary } from "../../api";
import CardTile from "./CardTile";

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

function card(memberChats: CardMemberChat[], overrides: Partial<CardSummary> = {}): CardSummary {
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
    ...overrides,
  };
}

const SINGLE = [member({ chatId: "root-chat", folder: "/home/cybil/callboard" })];
const FANOUT = [
  member({ chatId: "root-chat", folder: "/home/cybil/callboard" }),
  member({ chatId: "a", folder: "/home/cybil/callboard.feat-a" }),
  member({ chatId: "b", folder: "/home/cybil/callboard.feat-b" }),
];

afterEach(cleanup);

describe("the folder line", () => {
  it("is absent until the board asks for it", () => {
    render(<CardTile card={card(SINGLE)} onClick={vi.fn()} />);
    expect(screen.queryByTitle("/home/cybil/callboard")).toBeNull();
  });

  it("shows the root folder and nothing else on a single-folder card", () => {
    render(<CardTile card={card(SINGLE)} onClick={vi.fn()} showPath />);
    expect(screen.getByTitle("/home/cybil/callboard")).toBeDefined();
    expect(screen.queryByText(/^\+\d/)).toBeNull();
  });

  it("counts the OTHER folders, not all of them", () => {
    render(<CardTile card={card(FANOUT)} onClick={vi.fn()} showPath />);
    expect(screen.getByTitle("/home/cybil/callboard")).toBeDefined();
    expect(screen.getByText("+2")).toBeDefined();
  });

  it("gives the +N the rollup colour when the action is in one of those other folders", () => {
    render(
      <CardTile
        card={card([FANOUT[0], member({ chatId: "a", folder: "/elsewhere", status: "waiting" })], { rollup: "needs_you" })}
        onClick={vi.fn()}
        showPath
      />,
    );
    expect(screen.getByText("+1").getAttribute("style")).toContain("--board-rollup-needs-you");
  });

  it("leaves the +N in meta colour when only the root folder is live", () => {
    render(
      <CardTile
        card={card([member({ chatId: "root-chat", folder: "/home/cybil/callboard", status: "ongoing" }), member({ chatId: "a", folder: "/elsewhere" })], {
          rollup: "active",
        })}
        onClick={vi.fn()}
        showPath
      />,
    );
    expect(screen.getByText("+1").getAttribute("style")).toContain("--board-tile-meta-text");
  });

  it("renders no line at all for a card whose member rows are gone", () => {
    // A root on a retired provider: a real card with no member chats at all.
    const { container } = render(<CardTile card={card([])} onClick={vi.fn()} showPath />);
    expect(container.querySelector("[title^='/']")).toBeNull();
  });
});
