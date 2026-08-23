// @vitest-environment jsdom
/**
 * The seams, asserted where they actually are.
 *
 * `ErrorBoundary.test.tsx` proves the component contains a throw. This proves
 * the boundaries are mounted at the two places that make containment worth
 * having: a crash in the main pane must leave the sidebar usable, and a crash
 * in the sidebar must leave the chat you are typing into alone. A boundary that
 * passes its own unit test while sitting at the wrong depth is the exact failure
 * this PR is about — one bad row taking the whole screen with it.
 *
 * The pages are mocked to stubs so the test is about SplitLayout's structure and
 * nothing else; the thrower reproduces #364's shape (a read off `undefined`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SplitLayout from "./SplitLayout";

const crash = () => {
  const workspace = {} as { removability?: { removable: boolean } };
  const { removable } = workspace.removability as { removable: boolean };
  return <div>{String(removable)}</div>;
};

let chatThrows = false;
let listThrows = false;

vi.mock("../pages/Chat", () => ({
  default: () => (chatThrows ? crash() : <div>Chat pane</div>),
}));
vi.mock("../pages/ChatList", () => ({
  default: () => (listThrows ? crash() : <div>Chat list</div>),
}));
vi.mock("../pages/FolderList", () => ({ default: () => <div>Folder list</div> }));
vi.mock("../pages/Board", () => ({ default: () => <div>Board</div> }));
vi.mock("../pages/Settings", () => ({ default: () => <div>Settings</div> }));
vi.mock("../pages/agents/AgentList", () => ({ default: () => <div>Agents</div> }));
vi.mock("../pages/agents/CreateAgent", () => ({ default: () => <div>New agent</div> }));
vi.mock("../pages/agents/AgentDashboard", () => ({ default: () => <div>Agent dashboard</div> }));

beforeEach(() => {
  chatThrows = false;
  listThrows = false;
  // See ErrorBoundary.test.tsx: cancels jsdom's stderr dump of the dev-build
  // re-throw so a real failure here is legible.
  const swallow = (e: ErrorEvent) => e.preventDefault();
  window.addEventListener("error", swallow);
  vi.spyOn(console, "error").mockImplementation(() => {});
  return () => window.removeEventListener("error", swallow);
});

// jsdom's default 1024px width means useIsMobile resolves to desktop, which is
// the split view these seams belong to.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SplitLayout onLogout={() => {}} />
    </MemoryRouter>,
  );
}

describe("the two columns fail independently", () => {
  it("a crash in the main pane leaves the sidebar rendered", () => {
    chatThrows = true;
    renderAt("/chat/abc");

    expect(screen.getByText("This page stopped working")).toBeTruthy();
    expect(screen.getByText("Chat list")).toBeTruthy();
  });

  it("a crash in the sidebar leaves the chat pane rendered", () => {
    listThrows = true;
    renderAt("/chat/abc");

    expect(screen.getByText("The sidebar stopped working")).toBeTruthy();
    expect(screen.getByText("Chat pane")).toBeTruthy();
  });

  it("keeps the root populated either way", () => {
    chatThrows = true;
    const { container } = renderAt("/chat/abc");
    expect(container.innerHTML.length).toBeGreaterThan(0);
    // The layout itself survives: a fallback nested inside the split, not
    // painted over it.
    expect(container.querySelector(".split-layout")).toBeTruthy();
    expect(container.querySelector(".split-sidebar")).toBeTruthy();
  });

  it("recovers the pane on 'Try again' without disturbing the sidebar", () => {
    chatThrows = true;
    renderAt("/chat/abc");

    chatThrows = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("Chat pane")).toBeTruthy();
    expect(screen.getByText("Chat list")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
