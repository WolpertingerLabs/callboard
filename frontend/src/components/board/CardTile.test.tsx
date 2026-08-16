// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CardSummary } from "../../api";
import CardTile from "./CardTile";

afterEach(cleanup);

const card: CardSummary = {
  id: "card-1",
  title: "Ship the board polish",
  description: "",
  emoji: "🗂️",
  lifecycle: "open",
  pinned: false,
  createdAt: "2026-08-16T12:00:00.000Z",
  updatedAt: "2026-08-16T12:00:00.000Z",
  rollup: "idle",
  lastActivityAt: "2026-08-16T12:00:00.000Z",
  chatCount: 0,
  unread: false,
  memberChats: [],
  memberRuns: [],
};

describe("CardTile", () => {
  it("omits the default folder icon from the card face", () => {
    render(<CardTile card={card} onClick={vi.fn()} />);

    expect(screen.queryByText("🗂️")).toBeNull();
    expect(screen.getByText(card.title)).toBeTruthy();
  });

  it("keeps a card's custom emoji", () => {
    render(<CardTile card={{ ...card, emoji: "🚀" }} onClick={vi.fn()} />);

    expect(screen.getByText("🚀")).toBeTruthy();
  });
});
