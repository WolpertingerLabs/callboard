// @vitest-environment jsdom
/**
 * The inline fork-point marker under a bubble: a "N forks" chip opening a
 * menu of the forks that branched off there, each navigating to its chat.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import type { ChatTreeNode, ParsedMessage } from "../api";
import MessageBubble from "./MessageBubble";

vi.mock("../api", () => ({}));

afterEach(() => {
  cleanup();
});

const message: ParsedMessage = {
  role: "assistant",
  type: "text",
  content: "a reply that was forked",
  timestamp: "2026-01-01T00:00:00.000Z",
} as ParsedMessage;

function fork(chatId: string, title: string, overrides: Partial<ChatTreeNode> = {}): ChatTreeNode {
  return {
    chatId,
    title,
    role: "fork",
    forkedAt: message.timestamp,
    provider: "claude-code",
    status: "stopped",
    folder: "/repo",
    createdAt: "2026-01-01T00:01:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    children: [],
    ...overrides,
  };
}

function Opened() {
  return <div>opened {useParams().id}</div>;
}

function renderBubble(forks?: ChatTreeNode[]) {
  return render(
    <MemoryRouter initialEntries={["/chat/parent"]}>
      <Routes>
        <Route path="/chat/parent" element={<MessageBubble message={message} forks={forks} />} />
        <Route path="/chat/:id" element={<Opened />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MessageBubble fork-point marker", () => {
  it("renders no chip without forks", () => {
    renderBubble();
    expect(screen.queryByRole("button", { name: /fork/ })).toBeNull();
    cleanup();
    renderBubble([]);
    expect(screen.queryByRole("button", { name: /fork/ })).toBeNull();
  });

  it("counts forks in the chip label", () => {
    renderBubble([fork("f1", "Fork: one")]);
    expect(screen.getByRole("button", { name: "1 fork" })).toBeTruthy();
    cleanup();
    renderBubble([fork("f1", "Fork: one"), fork("f2", "→ Codex: two", { role: "engine-switch", provider: "codex" })]);
    expect(screen.getByRole("button", { name: "2 forks" })).toBeTruthy();
  });

  it("opens a menu of the forks and navigates to the one clicked", () => {
    renderBubble([fork("f1", "Fork: one"), fork("f2", "→ Codex: two", { role: "engine-switch", provider: "codex", status: "ongoing" })]);
    const chip = screen.getByRole("button", { name: "2 forks" });
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
    expect(chip.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["CCFork: one", "CX→ Codex: two"]);
    // Focus lands in the menu so the keyboard can walk it.
    expect(document.activeElement).toBe(items[0]);

    fireEvent.click(items[1]);
    expect(screen.getByText("opened f2")).toBeTruthy();
  });

  it("leaves row backgrounds to the stylesheet, so its hover / focus-visible highlight applies", () => {
    // jsdom cannot enter :hover, so this pins the structure index.css's
    // .fork-point-menu-item rules depend on: the class is present, and no
    // inline background outranks them.
    renderBubble([fork("f1", "Fork: one")]);
    fireEvent.click(screen.getByRole("button", { name: "1 fork" }));
    const row = screen.getByRole("menuitem");
    expect(row.classList.contains("fork-point-menu-item")).toBe(true);
    expect(row.style.background).toBe("");
  });

  it("closes on Escape, returning focus to the chip", () => {
    renderBubble([fork("f1", "Fork: one")]);
    const chip = screen.getByRole("button", { name: "1 fork" });
    fireEvent.click(chip);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(chip);
  });

  it("closes on an outside click", () => {
    renderBubble([fork("f1", "Fork: one")]);
    fireEvent.click(screen.getByRole("button", { name: "1 fork" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
