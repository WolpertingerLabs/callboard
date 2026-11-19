// @vitest-environment jsdom
/**
 * The fork-point marker on a chat page with an aside panel: a lone aside
 * opens straight from the chip; in a mixed menu asides open in the panel and
 * forks navigate; hovering or focusing the marker emphasises its asides, a
 * row narrows that to its own. With no panel (no context) everything
 * navigates, as before.
 */
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChatTreeNode } from "../api";
import ForkPointMarker from "./ForkPointMarker";
import { AsideContext, type AsideActions } from "../contexts/AsideContext";

const navigate = vi.fn();
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const node = (chatId: string, role: string): ChatTreeNode => ({
  chatId,
  title: `${role} ${chatId}`,
  role,
  provider: "claude-code",
  status: "stopped",
  folder: "/tmp",
  createdAt: "",
  updatedAt: "",
  children: [],
});

function renderMarker(forks: ChatTreeNode[], actions: AsideActions | null) {
  return render(
    <AsideContext.Provider value={actions}>
      <ForkPointMarker forks={forks} align="left" />
    </AsideContext.Provider>,
  );
}
const actions = () => ({ openAside: vi.fn(), emphasizeAsides: vi.fn() });

it("opens a lone aside straight from the chip", () => {
  const a = actions();
  renderMarker([node("a1", "aside")], a);
  const chip = screen.getByRole("button", { name: "1 aside" });
  expect(chip.getAttribute("aria-haspopup")).toBeNull();
  fireEvent.click(chip);
  expect(a.openAside).toHaveBeenCalledWith("a1");
  expect(navigate).not.toHaveBeenCalled();
});

it("opens asides in the panel and navigates to forks from a mixed menu", () => {
  const a = actions();
  renderMarker([node("f1", "fork"), node("a1", "aside")], a);
  fireEvent.click(screen.getByRole("button", { name: "1 fork, 1 aside" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /aside a1/ }));
  expect(a.openAside).toHaveBeenCalledWith("a1");
  fireEvent.click(screen.getByRole("button", { name: "1 fork, 1 aside" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /fork f1/ }));
  expect(navigate).toHaveBeenCalledWith("/chat/f1");
});

it("emphasises its asides on hover and focus, a row its own, and lets go on leaving", () => {
  const a = actions();
  const { container } = renderMarker([node("f1", "fork"), node("a1", "aside"), node("a2", "aside")], a);
  const wrap = container.firstElementChild!;
  fireEvent.mouseEnter(wrap);
  expect(a.emphasizeAsides).toHaveBeenLastCalledWith(["a1", "a2"]);
  fireEvent.mouseLeave(wrap);
  expect(a.emphasizeAsides).toHaveBeenLastCalledWith(null);

  fireEvent.focus(screen.getByRole("button", { name: "1 fork, 2 asides" }));
  expect(a.emphasizeAsides).toHaveBeenLastCalledWith(["a1", "a2"]);
  fireEvent.click(screen.getByRole("button", { name: "1 fork, 2 asides" }));
  fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /aside a2/ }));
  expect(a.emphasizeAsides).toHaveBeenLastCalledWith(["a2"]);
});

it("navigates to an aside, as to any child, where the page has no panel", () => {
  renderMarker([node("a1", "aside")], null);
  fireEvent.click(screen.getByRole("button", { name: "1 aside" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /aside a1/ }));
  expect(navigate).toHaveBeenCalledWith("/chat/a1");
});
