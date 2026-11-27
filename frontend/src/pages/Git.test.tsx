// @vitest-environment jsdom
/**
 * The Git page: it holds the open cards for the active space, hands them to
 * the branches overview, and a chip opens that conversation's root chat.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import type { CardSummary } from "../api";
import { getGitOverview, listCards } from "../api";
import type { SpaceListItem } from "shared/types/space.js";
import { SpaceContext } from "../contexts/SpaceContext";
import { makeSpaceContext } from "../testing/spaceContext";
import Git from "./Git";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listCards: vi.fn(),
  getGitOverview: vi.fn(),
}));

vi.mock("../contexts/SessionContext", () => ({ useMetadataVersion: () => 0 }));

const SPACES: SpaceListItem[] = [
  { id: "default", name: "General", order: 0, chatCount: 0, createdAt: "", updatedAt: "" },
  { id: "sp_work", name: "Work", emoji: "💼", order: 1, chatCount: 0, createdAt: "", updatedAt: "" },
];

function card(id: string, title: string): CardSummary {
  return {
    id,
    title,
    description: "",
    emoji: "🗂️",
    lifecycle: "open",
    pinned: false,
    rollup: "idle",
    lastActivityAt: "2026-11-06T01:00:00.000Z",
    chatCount: 1,
    unread: false,
    memberChats: [],
    memberRuns: [],
    createdAt: "2026-11-06T00:00:00.000Z",
    updatedAt: "2026-11-06T00:00:00.000Z",
  };
}

const CARDS = [card("c1", "PR tracking"), card("c2", "Other work")];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  vi.mocked(listCards).mockResolvedValue({ cards: CARDS });
  vi.mocked(getGitOverview).mockResolvedValue({
    generatedAt: new Date().toISOString(),
    repos: [{ repoPath: "/src/app", name: "app", rows: [{ cwd: "/src/app", branch: "main", isMain: true, cardIds: ["c1"] }] }],
  });
});
afterEach(cleanup);

function ChatStub() {
  return <div data-testid="chat-page">{useParams().id}</div>;
}

function mount(page = <Git />) {
  render(
    <MemoryRouter initialEntries={["/git"]}>
      <Routes>
        <Route path="/git" element={page} />
        <Route path="/chat/:id" element={<ChatStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("the Git page", () => {
  it("is headed Git and shows the branches overview", async () => {
    mount();
    expect(screen.getByRole("heading", { level: 1, name: "Git" })).toBeDefined();
    expect(await screen.findByRole("heading", { level: 2, name: "app" })).toBeDefined();
    expect(getGitOverview).toHaveBeenCalled();
  });

  it("asks only for open cards, across every space when spaces are off", async () => {
    mount();
    await screen.findByRole("heading", { level: 2, name: "app" });
    expect(listCards).toHaveBeenCalledWith(false, { lifecycle: "open" });
  });

  it("scopes the cards to the active space", async () => {
    mount(
      <SpaceContext.Provider value={makeSpaceContext(SPACES, { activeSpaceId: "sp_work" })}>
        <Git />
      </SpaceContext.Provider>,
    );
    await screen.findByRole("heading", { level: 2, name: "app" });
    expect(listCards).toHaveBeenCalledWith(false, { space: "sp_work", lifecycle: "open" });
  });

  it("opens the conversation's root chat from a chip", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "PR tracking" }));
    expect(screen.getByTestId("chat-page").textContent).toBe("c1");
  });

  it("shows the error when the cards fail to load", async () => {
    vi.mocked(listCards).mockRejectedValue(new Error("daemon down"));
    mount();
    expect(await screen.findByText("daemon down")).toBeDefined();
  });
});
