// @vitest-environment jsdom
/**
 * The gestures behind a tree node's "split off" menu: the long press on touch
 * (with the grace period that keeps the finger's release from closing it),
 * the click a gesture leaves behind (which must not navigate), the keyboard
 * route (Shift+F10 / the Menu key), focus handling, and selection mode.
 *
 * Page-level behaviour — the API call, the refetch, the error banner — is in
 * pages/ChatList.splitOff.test.tsx.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { Chat, ChatTreeNode } from "../api";
import { getChatTree } from "../api";
import { resetChatSectionExpansion } from "../hooks/useChatSectionExpansion";
import ChatTreeList, { type RowSelection } from "./ChatTreeList";

vi.mock("../api", () => ({
  getChatTree: vi.fn(),
  dismissSummon: vi.fn().mockResolvedValue(undefined),
}));

const FOLDER = "/home/cybil/projects/callboard";
const SPLIT = "Split off as standalone chat";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  resetChatSectionExpansion();
});

function makeChat(id: string, meta: Record<string, unknown> = {}): Chat {
  return {
    id,
    folder: FOLDER,
    displayFolder: FOLDER,
    session_id: `sess-${id}`,
    created_at: "2026-07-28T10:00:00Z",
    updated_at: "2026-07-28T10:00:00Z",
    metadata: JSON.stringify(meta),
  } as Chat;
}

function makeNode(chatId: string, title: string, children: ChatTreeNode[] = []): ChatTreeNode {
  return {
    chatId,
    title,
    provider: "claude-code",
    status: "stopped",
    folder: FOLDER,
    createdAt: "2026-07-28T10:00:00Z",
    updatedAt: "2026-07-28T10:00:00Z",
    children,
  };
}

/** Renders the current path, so a navigation is observable. */
function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

async function renderExpanded(opts: { selection?: RowSelection } = {}) {
  vi.mocked(getChatTree).mockResolvedValue({
    targetChatId: "root",
    rootChatId: "root",
    ancestors: [],
    tree: makeNode("root", "Root thread", [makeNode("child", "Helper")]),
  });
  const onDetach = vi.fn();
  const props = {
    chats: [makeChat("root", { title: "Root thread" }), makeChat("child", { title: "Helper", parentChatId: "root", rootChatId: "root" })],
    onChatClick: () => {},
    onDelete: () => {},
    onToggleBookmark: () => {},
    onTogglePin: () => {},
    cardMenuFor: () => ({}),
    sessionStatusFor: () => undefined,
    onDetach,
    ...(opts.selection && { selectionFor: () => opts.selection! }),
  };
  const view = render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ChatTreeList refreshToken={0} {...props} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByTitle("Expand chat tree"));
  await screen.findByText("Helper");
  const rerender = (selection: RowSelection) =>
    view.rerender(
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <ChatTreeList refreshToken={0} {...props} selectionFor={() => selection} />
                <Where />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
  return { onDetach, rerender };
}

const nodeRow = (chatId: string) => screen.getAllByTestId("chat-tree-node").find((el) => el.dataset.chatId === chatId)!;
const where = () => screen.getByTestId("where").textContent;

describe("tree node split-off menu — gestures", () => {
  it("opens on a touch long press, and the release does not navigate or close it", async () => {
    const { onDetach } = await renderExpanded();
    vi.useFakeTimers();

    fireEvent.pointerDown(nodeRow("child"), { pointerType: "touch", clientX: 10, clientY: 20 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("menu", { name: "Actions for Helper" })).toBeTruthy();

    // The finger lifts: the browser's click lands on the row …
    fireEvent.pointerUp(nodeRow("child"), { pointerType: "touch" });
    fireEvent.click(nodeRow("child"));
    expect(where()).toBe("/");
    // … or on the backdrop that just appeared under it. Inside the grace
    // period, that does not close the menu.
    const backdrop = screen.getByRole("menu").previousElementSibling as HTMLElement;
    fireEvent.click(backdrop);
    expect(screen.getByRole("menu")).toBeTruthy();

    // Past it, a tap on the backdrop is a dismissal again.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    fireEvent.click(backdrop);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onDetach).not.toHaveBeenCalled();
  });

  it("does not navigate on the click a right-click leaves behind (macOS Ctrl+click)", async () => {
    await renderExpanded();
    fireEvent.contextMenu(nodeRow("child"), { clientX: 30, clientY: 40 });
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.click(nodeRow("child"), { ctrlKey: true });
    expect(where()).toBe("/");
  });

  it("still navigates on an ordinary click", async () => {
    await renderExpanded();
    fireEvent.click(nodeRow("child"));
    expect(where()).toBe("/chat/child");
  });

  it("opens from the keyboard, focuses the item, and returns focus to the row on Escape", async () => {
    const { onDetach } = await renderExpanded();
    const row = nodeRow("child");
    row.focus();

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    const item = screen.getByRole("menuitem", { name: SPLIT });
    expect(document.activeElement).toBe(item);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(row);

    fireEvent.keyDown(row, { key: "ContextMenu" });
    fireEvent.click(screen.getByRole("menuitem", { name: SPLIT }));
    expect(onDetach).toHaveBeenCalledWith("child", "Helper");
  });

  it("does not navigate when Enter activates the menu item", async () => {
    const { onDetach } = await renderExpanded();
    fireEvent.keyDown(nodeRow("child"), { key: "ContextMenu" });
    const item = screen.getByRole("menuitem", { name: SPLIT });
    fireEvent.keyUp(item, { key: "Enter" });
    expect(where()).toBe("/");
    fireEvent.click(item);
    expect(onDetach).toHaveBeenCalledTimes(1);
  });

  it("suppresses the iOS text-selection callout on splittable rows only", async () => {
    await renderExpanded();
    expect(nodeRow("child").style.userSelect).toBe("none");
    expect(nodeRow("root").style.userSelect).toBe("");
  });

  it("is not offered during a multi-select, and an open menu closes when one starts", async () => {
    const idle: RowSelection = { selectionMode: false, selected: false, selectable: true, onToggleSelect: () => {} };
    const { rerender } = await renderExpanded({ selection: idle });
    fireEvent.contextMenu(nodeRow("child"));
    expect(screen.getByRole("menu")).toBeTruthy();

    rerender({ ...idle, selectionMode: true });
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.contextMenu(nodeRow("child"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
