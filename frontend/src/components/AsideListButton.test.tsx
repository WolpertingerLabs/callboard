import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionContext } from "../contexts/SessionContext";
import AsideListButton from "./AsideListButton";
import type { AsideEntry } from "../utils/asideHighlights";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const aside = (chatId: string, extra: Partial<AsideEntry> = {}): AsideEntry => ({
  chatId,
  title: `Aside ${chatId}`,
  status: "stopped",
  provider: "claude-code",
  quotes: [],
  createdAt: "",
  updatedAt: "2026-01-01T10:00:00.000Z",
  ...extra,
});

function renderButton(active: string[], onOpen = vi.fn(), onEmphasize = vi.fn(), asides = [aside("a1"), aside("a2")]) {
  const value = {
    activeSessions: new Map(active.map((id) => [id, { type: "web" as const, startedAt: 1 }])),
    connected: true,
    metadataVersion: 0,
    summonedChatIds: new Set<string>(),
    awaitingChatIds: new Set<string>(),
    staleBuildId: null,
  };
  const ui = (
    <SessionContext.Provider value={value as never}>
      <AsideListButton asides={asides} openId="a1" onOpen={onOpen} onEmphasize={onEmphasize} />
    </SessionContext.Provider>
  );
  return { ...render(ui), onOpen, onEmphasize };
}

it("lists the asides, opens the one picked and emphasises the one hovered", () => {
  const { onOpen, onEmphasize } = renderButton([]);
  const button = screen.getByRole("button", { name: "2 asides in this chat" });
  expect(within(button).queryByTestId("running-dot")).toBeNull();
  fireEvent.click(button);
  const menu = screen.getByRole("menu", { name: "Asides of this chat" });
  expect(
    within(menu)
      .getByRole("menuitem", { name: /Aside a1/ })
      .getAttribute("aria-current"),
  ).toBe("true");
  fireEvent.mouseEnter(within(menu).getByRole("menuitem", { name: /Aside a2/ }));
  expect(onEmphasize).toHaveBeenLastCalledWith(["a2"]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: /Aside a2/ }));
  // With the button, for focus to return to: the row goes with the menu.
  expect(onOpen).toHaveBeenCalledWith("a2", button);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("carries the running dot while an aside has a live session, and drops it when it ends", async () => {
  const { rerender, onOpen, onEmphasize } = renderButton(["a2"]);
  const button = await screen.findByRole("button", { name: "2 asides in this chat, 1 running" });
  expect(within(button).getByTestId("running-dot")).toBeTruthy();
  const idle = {
    activeSessions: new Map(),
    connected: true,
    metadataVersion: 0,
    summonedChatIds: new Set<string>(),
    awaitingChatIds: new Set<string>(),
    staleBuildId: null,
  };
  await act(async () => {
    rerender(
      <SessionContext.Provider value={idle as never}>
        <AsideListButton asides={[aside("a1"), aside("a2")]} openId="a1" onOpen={onOpen} onEmphasize={onEmphasize} />
      </SessionContext.Provider>,
    );
  });
  expect(screen.getByRole("button", { name: "2 asides in this chat" })).toBeTruthy();
});

it("says when an aside is calling, waiting for an answer, or has an unread reply — on the button and its row", () => {
  renderButton([], vi.fn(), vi.fn(), [
    aside("a1", { summon: { urgency: "normal", createdAt: "2026-01-01T10:00:00.000Z" } }),
    aside("a2", { status: "waiting" }),
    aside("a3", { lastReadAt: "2026-01-01T09:00:00.000Z" }),
    aside("a4", { lastReadAt: "2026-01-01T11:00:00.000Z" }),
  ]);
  const button = screen.getByRole("button", { name: "4 asides in this chat, 1 calling for you, 1 waiting for an answer, 1 unread" });
  // The most pressing one colours the button's dot.
  expect(within(button).getByTestId("aside-attention-summoned")).toBeTruthy();
  fireEvent.click(button);
  const menu = screen.getByRole("menu");
  expect(within(within(menu).getByRole("menuitem", { name: /Aside a1/ })).getByRole("img", { name: "calling for you" })).toBeTruthy();
  expect(within(within(menu).getByRole("menuitem", { name: /Aside a2/ })).getByRole("img", { name: "waiting for an answer" })).toBeTruthy();
  expect(within(within(menu).getByRole("menuitem", { name: /Aside a3/ })).getByRole("img", { name: "unread" })).toBeTruthy();
  expect(within(within(menu).getByRole("menuitem", { name: /Aside a4/ })).queryByRole("img")).toBeNull();
});

it("portals the menu out of its row so a scrolling action bar cannot clip it, and closes on a press outside", () => {
  const { container, onEmphasize } = renderButton([]);
  fireEvent.click(screen.getByRole("button", { name: "2 asides in this chat" }));
  const menu = screen.getByRole("menu");
  expect(container.contains(menu)).toBe(false);
  expect(menu.style.position).toBe("fixed");
  // A press inside the portalled menu is not "outside".
  fireEvent.mouseDown(within(menu).getByRole("menuitem", { name: /Aside a2/ }));
  expect(screen.getByRole("menu")).toBeTruthy();
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  expect(onEmphasize).toHaveBeenLastCalledWith(null);
});

it("shows the menu and focuses its first row on the very first open", () => {
  // A browser will not focus an element under visibility: hidden, and jsdom
  // does not model that, so record what the menu looked like when its row
  // was focused rather than after every re-render has settled.
  const original = HTMLElement.prototype.focus;
  const visibilityAtFocus: string[] = [];
  const spy = vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    const menu = this.closest<HTMLElement>('[role="menu"]');
    if (menu) visibilityAtFocus.push(menu.style.visibility);
    original.call(this, options);
  });
  try {
    renderButton([]);
    fireEvent.click(screen.getByRole("button", { name: "2 asides in this chat" }));
    const menu = screen.getByRole("menu");
    expect(visibilityAtFocus).toEqual([""]);
    expect(menu.style.visibility).not.toBe("hidden");
    expect(document.activeElement).toBe(within(menu).getAllByRole("menuitem")[0]);
  } finally {
    spy.mockRestore();
  }
});

it("closes on Escape while focus is still on the button, and keeps focus there", () => {
  renderButton([]);
  const button = screen.getByRole("button", { name: "2 asides in this chat" });
  fireEvent.click(button);
  button.focus();
  fireEvent.keyDown(button, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(button);
});

it("holds its position across scroll and resize events when the button has not moved", () => {
  renderButton([]);
  const button = screen.getByRole("button", { name: "2 asides in this chat" });
  // Near the left edge of a phone: the clamp, not the button, sets `right`.
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue({
    top: 40,
    bottom: 72,
    left: 16,
    right: 100,
    width: 84,
    height: 32,
    x: 16,
    y: 40,
    toJSON: () => ({}),
  });
  fireEvent.click(button);
  const menu = screen.getByRole("menu");
  // A rendered width past minWidth must not feed back into the placement.
  Object.defineProperty(menu, "offsetWidth", { configurable: true, value: 300 });
  const placed = { top: menu.style.top, right: menu.style.right };
  expect(placed).toEqual({ top: "76px", right: `${390 - 260 - 8}px` });
  for (let i = 0; i < 5; i++) {
    fireEvent.scroll(window);
    fireEvent(window, new Event("resize"));
  }
  expect({ top: menu.style.top, right: menu.style.right }).toEqual(placed);
});
