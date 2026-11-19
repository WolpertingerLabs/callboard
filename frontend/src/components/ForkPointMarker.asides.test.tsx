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
const actions = (openAsideId: string | null = null) => ({ openAside: vi.fn(), emphasizeAsides: vi.fn(), openAsideId, closeAside: vi.fn() });

it("opens a lone aside straight from the chip", () => {
  const a = actions();
  renderMarker([node("a1", "aside")], a);
  const chip = screen.getByRole("button", { name: "1 aside" });
  expect(chip.getAttribute("aria-haspopup")).toBeNull();
  fireEvent.click(chip);
  // With the chip to give focus back to when the panel closes.
  expect(a.openAside).toHaveBeenCalledWith("a1", { returnFocus: chip });
  expect(navigate).not.toHaveBeenCalled();
});

it("opens asides in the panel and navigates to forks from a mixed menu", () => {
  const a = actions();
  renderMarker([node("f1", "fork"), node("a1", "aside")], a);
  fireEvent.click(screen.getByRole("button", { name: "1 fork, 1 aside" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /aside a1/ }));
  // The row goes with the menu: focus comes back to the chip.
  expect(a.openAside).toHaveBeenCalledWith("a1", { returnFocus: screen.getByRole("button", { name: "1 fork, 1 aside" }) });
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

it("closes its lone aside again when that aside is the one open", () => {
  const a = actions("a1");
  renderMarker([node("a1", "aside")], a);
  const chip = screen.getByRole("button", { name: "1 aside" });
  expect(chip.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(chip);
  expect(a.closeAside).toHaveBeenCalled();
  expect(a.openAside).not.toHaveBeenCalled();
});

it("ends the emphasis on a fork row, and when it unmounts mid-hover", () => {
  const a = actions();
  const { container, unmount } = renderMarker([node("f1", "fork"), node("a1", "aside")], a);
  fireEvent.click(screen.getByRole("button", { name: "1 fork, 1 aside" }));
  fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /aside a1/ }));
  expect(a.emphasizeAsides).toHaveBeenLastCalledWith(["a1"]);
  fireEvent.mouseEnter(screen.getByRole("menuitem", { name: /fork f1/ }));
  expect(a.emphasizeAsides).toHaveBeenLastCalledWith(null);
  fireEvent.mouseEnter(container.firstElementChild!);
  expect(a.emphasizeAsides).toHaveBeenLastCalledWith(["a1"]);
  unmount();
  expect(a.emphasizeAsides).toHaveBeenLastCalledWith(null);
});

it("does not end another marker's emphasis when it unmounts", () => {
  const a = actions();
  const view = render(
    <AsideContext.Provider value={a}>
      <div key="m1" data-testid="m1">
        <ForkPointMarker forks={[node("a1", "aside")]} align="left" />
      </div>
      <div key="m2" data-testid="m2">
        <ForkPointMarker forks={[node("a2", "aside")]} align="left" />
      </div>
    </AsideContext.Provider>,
  );
  const [first, second] = [view.getByTestId("m1").firstElementChild!, view.getByTestId("m2").firstElementChild!];
  fireEvent.mouseEnter(first);
  fireEvent.mouseLeave(first);
  fireEvent.mouseEnter(second);
  expect(a.emphasizeAsides).toHaveBeenLastCalledWith(["a2"]);
  // The first marker goes (the transcript re-rendered): the second's emphasis stays.
  view.rerender(
    <AsideContext.Provider value={a}>
      <div key="m2" data-testid="m2">
        <ForkPointMarker forks={[node("a2", "aside")]} align="left" />
      </div>
    </AsideContext.Provider>,
  );
  expect(a.emphasizeAsides).toHaveBeenLastCalledWith(["a2"]);
});

it("emphasises all of its asides again when the pointer comes back to the chip from a row", () => {
  const a = actions();
  renderMarker([node("f1", "fork"), node("a1", "aside"), node("a2", "aside")], a);
  const chip = screen.getByRole("button", { name: "1 fork, 2 asides" });
  fireEvent.click(chip);
  const row = screen.getByRole("menuitem", { name: /aside a2/ });
  fireEvent.mouseEnter(row);
  expect(a.emphasizeAsides).toHaveBeenLastCalledWith(["a2"]);
  // The pointer moves from the row to the chip: inside the marker all along,
  // so its wrapper is not entered again — only the chip is.
  fireEvent.mouseOut(row, { relatedTarget: chip });
  fireEvent.mouseOver(chip, { relatedTarget: row });
  expect(a.emphasizeAsides).toHaveBeenLastCalledWith(["a1", "a2"]);
});
