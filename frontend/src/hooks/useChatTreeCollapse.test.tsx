// @vitest-environment jsdom
/**
 * The shared store behind the sidebar tree's per-node folds: every consumer
 * sees one toggle, and the fold survives a fresh read from storage.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getChatTreeCollapsedIds } from "../utils/localStorage";
import { resetChatTreeCollapse, useChatTreeCollapse } from "./useChatTreeCollapse";

function Consumer({ name }: { name: string }) {
  const { isCollapsed, toggle } = useChatTreeCollapse();
  return (
    <div>
      <span data-testid={`${name}-node`}>{String(isCollapsed("node"))}</span>
      <button onClick={() => toggle("node")}>toggle {name}</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  resetChatTreeCollapse();
});
afterEach(cleanup);

it("defaults to expanded, and two consumers see one toggle", () => {
  render(
    <>
      <Consumer name="a" />
      <Consumer name="b" />
    </>,
  );
  expect(screen.getByTestId("a-node").textContent).toBe("false");
  fireEvent.click(screen.getByText("toggle a"));
  expect(screen.getByTestId("a-node").textContent).toBe("true");
  expect(screen.getByTestId("b-node").textContent).toBe("true");
  fireEvent.click(screen.getByText("toggle b"));
  expect(screen.getByTestId("a-node").textContent).toBe("false");
});

it("persists the fold through a fresh read from storage", () => {
  render(<Consumer name="a" />);
  fireEvent.click(screen.getByText("toggle a"));
  expect(getChatTreeCollapsedIds().has("node")).toBe(true);
  act(() => resetChatTreeCollapse());
  expect(screen.getByTestId("a-node").textContent).toBe("true");
});
