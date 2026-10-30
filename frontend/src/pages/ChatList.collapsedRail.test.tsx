// @vitest-environment jsdom
/**
 * The collapsed rail and the open header are two renderings of one button set.
 * They were once written out separately and the rail drifted — it lost Board —
 * so this pins them against each other from the outside: same buttons, same
 * order, with the collapse/expand toggle last and nothing else after it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { listChats, listCards, getDrafts } from "../api";
import ChatList from "./ChatList";
import SidebarHeader from "../components/SidebarHeader";
import { SIDEBAR_NAV_ITEMS } from "../components/SidebarControls";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listChats: vi.fn(),
  listCards: vi.fn(),
  getDrafts: vi.fn(),
  fetchInstanceName: vi.fn().mockResolvedValue(""),
}));

vi.mock("../contexts/SessionContext", () => ({
  useSessionContext: () => ({
    activeSessions: new Map(),
    connected: true,
    metadataVersion: 0,
    summonedChatIds: new Set<string>(),
  }),
}));

vi.mock("../components/NewChatPanel", () => ({ default: () => <div data-testid="new-chat-panel" /> }));

const NAV_TITLES = SIDEBAR_NAV_ITEMS.map((item) => item.title);

/** Every button's title, in document order. */
function buttonTitles(container: HTMLElement): string[] {
  return within(container)
    .getAllByRole("button")
    .map((b) => b.getAttribute("title") ?? "");
}

function renderHeader(props: { claudeLoggedIn?: boolean; path?: string } = {}) {
  const { path = "/", ...rest } = props;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarHeader onToggleNew={() => {}} onToggleSidebar={() => {}} onShowClaudeModal={() => {}} {...rest} />
    </MemoryRouter>,
  );
}

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function renderRail(props: { claudeLoggedIn?: boolean; onToggleSidebar?: () => void; path?: string } = {}) {
  const { path = "/", onToggleSidebar = () => {}, ...rest } = props;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ChatList onRefresh={() => {}} sidebarCollapsed onToggleSidebar={onToggleSidebar} onShowClaudeModal={() => {}} {...rest} />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(listCards).mockResolvedValue({ cards: [] });
  vi.mocked(getDrafts).mockResolvedValue([]);
  vi.mocked(listChats).mockResolvedValue({ chats: [], hasMore: false, total: 0, windowRows: 0, stale: false });
});

afterEach(cleanup);

describe("collapsed sidebar rail", () => {
  it("shows Board among its nav buttons", () => {
    const { container } = renderRail();
    expect(within(container).getByTitle("Board")).toBeTruthy();
  });

  for (const claudeLoggedIn of [true, false]) {
    it(`exposes the same buttons as the open header, in the same order (claudeLoggedIn=${claudeLoggedIn})`, () => {
      const header = buttonTitles(renderHeader({ claudeLoggedIn }).container);
      cleanup();
      const rail = buttonTitles(renderRail({ claudeLoggedIn }).container);

      const strip = (titles: string[]) => titles.filter((t) => t !== "Collapse sidebar" && t !== "Expand sidebar");
      expect(strip(rail)).toEqual(strip(header));
      // The nav group appears, contiguous and in order, in both.
      const start = header.indexOf(NAV_TITLES[0]);
      expect(header.slice(start, start + NAV_TITLES.length)).toEqual(NAV_TITLES);

      // The toggle closes the top cluster in both — nothing follows it.
      expect(header.at(-1)).toBe("Collapse sidebar");
      expect(rail.at(-1)).toBe("Expand sidebar");
      const expandAt = rail.indexOf("Expand sidebar");
      for (const title of NAV_TITLES) expect(rail.indexOf(title)).toBeLessThan(expandAt);
      if (!claudeLoggedIn) expect(rail.indexOf("Claude Code login required")).toBeLessThan(expandAt);
    });
  }

  it("marks the active route with the accent background, as the header does", () => {
    const { container } = renderRail({ path: "/agents/forge" });
    const agents = within(container).getByTitle("Agents");
    expect(agents.getAttribute("aria-current")).toBe("page");
    expect(agents.style.background).toBe("var(--accent)");
    expect(within(container).getByTitle("Board").getAttribute("aria-current")).toBeNull();
  });

  it("navigates from its nav buttons", () => {
    const { container } = renderRail();
    fireEvent.click(within(container).getByTitle("Board"));
    expect(screen.getByTestId("location").textContent).toBe("/board");
  });

  it("expands the sidebar when New Chat is clicked", () => {
    const onToggleSidebar = vi.fn();
    const { container } = renderRail({ onToggleSidebar });
    fireEvent.click(within(container).getByTitle("New Chat"));
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
  });
});

/**
 * React only rewrites style properties whose values changed. With a `border`
 * shorthand that flips when the active button moves, the browser resets every
 * edge to 1px while the unchanged zeroed seam longhand is never re-applied, so
 * the seam doubles after client-side navigation. Each case lands on Board,
 * moves to Agents, and checks the seams Board and Agents share are still zero.
 */
describe("segmented nav seams survive navigation", () => {
  const cases = [
    { name: "open header (row)", mount: () => renderHeader({ path: "/board" }), boardSeam: "borderRightWidth", agentsSeams: ["borderLeftWidth", "borderRightWidth"] },
    { name: "collapsed rail (stack)", mount: () => renderRail({ path: "/board" }), boardSeam: "borderBottomWidth", agentsSeams: ["borderTopWidth", "borderBottomWidth"] },
  ] as const;

  for (const { name, mount, boardSeam, agentsSeams } of cases) {
    it(name, () => {
      const { container } = mount();
      fireEvent.click(within(container).getByTitle("Agents"));
      const board = within(container).getByTitle("Board");
      const agents = within(container).getByTitle("Agents");

      expect(agents.getAttribute("aria-current")).toBe("page");
      expect(board.style.borderStyle).toBe("solid");
      expect(board.style[boardSeam]).toBe("0px");
      for (const seam of agentsSeams) expect(agents.style[seam]).toBe("0px");
      // Board is inactive again, so its outer edges are back.
      expect(board.style.borderTopWidth || board.style.borderLeftWidth).toBe("1px");
    });
  }
});
