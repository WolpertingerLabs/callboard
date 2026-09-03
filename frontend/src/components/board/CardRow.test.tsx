/**
 * The row's layout contract — the half `cardFace.parity.test.tsx` deliberately
 * leaves alone, because it is the half the two faces are *supposed* to differ
 * on.
 *
 * jsdom lays nothing out, so these assert the rules that produce the layout
 * rather than the pixels: the shared column template (the reason a list beats
 * a squashed tile), the folders column being dropped rather than blanked, and
 * the mobile fallback's touch target.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CardMemberChat, CardSummary } from "../../api";
import CardRow from "./CardRow";

function card(overrides: Partial<CardSummary> = {}): CardSummary {
  return {
    id: "card-1",
    title: "Ship the thing",
    description: "",
    emoji: "🚀",
    lifecycle: "open",
    pinned: false,
    rollup: "idle",
    lastActivityAt: "2026-08-07T11:00:00.000Z",
    chatCount: 2,
    unread: false,
    memberChats: [],
    memberRuns: [],
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-07T11:00:00.000Z",
    ...overrides,
  };
}

const FOLDER: CardMemberChat = {
  chatId: "card-1",
  folder: "/home/cybil/callboard",
  title: null,
  status: "stopped",
  hasSummon: false,
  unread: false,
  isTriggered: false,
  createdAt: "2026-08-07T10:00:00.000Z",
  updatedAt: "2026-08-07T10:00:00.000Z",
};

function setWidth(px: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
}

function surface() {
  return screen.getByRole("button", { name: /Ship the thing/ });
}

afterEach(cleanup);

describe("the desktop template", () => {
  it("drops the folders column outright when paths are off", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: [FOLDER] })} onClick={vi.fn()} />);
    const columns = surface().style.gridTemplateColumns;

    // Six columns, not seven with an empty one: with paths off the title and
    // status get that width back instead of a blank stripe down the list.
    expect(columns).toBe("18px minmax(0,2fr) minmax(0,3fr) auto auto auto");
    expect(surface().children).toHaveLength(6);
  });

  it("adds the folders column, in the middle, when paths are on", () => {
    setWidth(1024);
    render(<CardRow card={card({ memberChats: [FOLDER] })} onClick={vi.fn()} showPath />);

    expect(surface().style.gridTemplateColumns).toBe("18px minmax(0,2fr) minmax(0,3fr) minmax(0,1.5fr) auto auto auto");
    expect(surface().children).toHaveLength(7);
    expect(screen.getByTitle("/home/cybil/callboard")).toBeDefined();
  });

  it("keeps the folders column when a card has no folders to put in it", () => {
    setWidth(1024);
    // A root on a retired provider: a real card with no member rows. The
    // column stays, or every path below it would step sideways.
    render(<CardRow card={card()} onClick={vi.fn()} showPath />);

    expect(surface().children).toHaveLength(7);
    expect(document.querySelector("[title^='/']")).toBeNull();
  });
});

describe("mobile", () => {
  it("collapses to two lines with a thumb-sized target", () => {
    setWidth(500);
    render(<CardRow card={card({ status: "rebasing", memberChats: [FOLDER] })} onClick={vi.fn()} showPath />);

    // Not a grid at all: seven columns on a phone is a row of ellipses.
    expect(surface().style.display).toBe("flex");
    expect(surface().style.flexDirection).toBe("column");
    expect(surface().children).toHaveLength(2);
    // Two lines of 11-13px text do not reach the 44px a thumb can hit.
    expect(surface().style.minHeight).toBe("44px");
  });
});
