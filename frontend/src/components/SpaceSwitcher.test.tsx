// @vitest-environment jsdom
/**
 * The sidebar's space switcher: the "elsewhere" badge is exactly the sum of
 * the rows the menu shows (archived spaces have no row, so they are not
 * counted), and the menu works from the keyboard.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CardSummary } from "shared/types/index.js";
import { SpaceContext } from "../contexts/SpaceContext";
import { makeSpaceContext, testSpace } from "../testing/spaceContext";
import SpaceSwitcher from "./SpaceSwitcher";

const SPACES = [testSpace("default", "General"), testSpace("sp_work", "Work"), testSpace("sp_home", "Home"), testSpace("sp_old", "Old", { archived: true })];

function blocked(id: string, spaceId: string): CardSummary {
  return {
    id,
    spaceId,
    title: id,
    description: "",
    emoji: "🗂",
    lifecycle: "open",
    pinned: false,
    createdAt: "",
    updatedAt: "",
    rollup: "needs_you",
    lastActivityAt: "",
    chatCount: 1,
    unread: false,
    memberChats: [],
    memberRuns: [],
  };
}

function renderSwitcher(setActiveSpace = vi.fn()) {
  const cards = [blocked("a", "sp_work"), blocked("b", "sp_home"), blocked("c", "sp_home"), blocked("d", "sp_old"), blocked("e", "default")];
  render(
    <MemoryRouter>
      <SpaceContext.Provider value={makeSpaceContext(SPACES, { activeSpaceId: "default", setActiveSpace })}>
        <SpaceSwitcher cards={cards} />
      </SpaceContext.Provider>
    </MemoryRouter>,
  );
  return setActiveSpace;
}

afterEach(cleanup);

describe("SpaceSwitcher", () => {
  it("counts blocked cards in the OTHER live spaces only — the sum of the rows it shows", () => {
    renderSwitcher();
    // Work 1 + Home 2; General is the active space and Old is archived.
    expect(screen.getByLabelText("3 cards in other spaces need you")).toBeTruthy();
    fireEvent.click(screen.getByTitle("Switch space"));
    expect(screen.queryByText("Old")).toBeNull();
  });

  it("moves focus into the menu, walks it with the arrow keys and returns focus on Escape", () => {
    const setActiveSpace = renderSwitcher();
    const trigger = screen.getByTitle("Switch space");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const items = screen.getAllByRole("menuitemradio");
    expect(document.activeElement).toBe(items[0]); // General, the selected one
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.textContent).toContain("Manage spaces");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(setActiveSpace).not.toHaveBeenCalled();
  });

  it("choosing a space switches and hands focus back to the trigger", () => {
    const setActiveSpace = renderSwitcher();
    fireEvent.click(screen.getByTitle("Switch space"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Work/ }));
    expect(setActiveSpace).toHaveBeenCalledWith("sp_work");
    expect(document.activeElement).toBe(screen.getByTitle("Switch space"));
  });

  it("compact: the closed trigger is the name alone, the menu still lists every space and All", () => {
    render(
      <MemoryRouter>
        <SpaceContext.Provider
          value={makeSpaceContext([testSpace("default", "General"), testSpace("sp_work", "Work", { emoji: "💼", color: "blue" })], { activeSpaceId: "sp_work" })}
        >
          <SpaceSwitcher cards={[]} compact />
        </SpaceContext.Provider>
      </MemoryRouter>,
    );
    const trigger = screen.getByTitle("Space: Work — switch space");
    expect(trigger.textContent).toBe("Work");
    fireEvent.click(trigger);
    const items = screen.getAllByRole("menuitemradio").map((el) => el.textContent);
    expect(items).toEqual(["General", "💼 Work", "All spaces"]);
  });
});
