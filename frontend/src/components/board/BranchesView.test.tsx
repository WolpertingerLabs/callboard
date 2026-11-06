import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { CardSummary, GitOverviewResponse } from "../../api";
import { getGitOverview } from "../../api";
import BranchesView from "./BranchesView";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  getGitOverview: vi.fn(),
}));

function card(id: string, title: string, overrides: Partial<CardSummary> = {}): CardSummary {
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
    ...overrides,
  };
}

const CARDS = [
  card("c1", "PR tracking"),
  card("c2", "Scroll latch", { rollup: "needs_you" }),
  card("c3", "Lib work"),
  card("gone", "Archived", { lifecycle: "closed" }),
];

const OVERVIEW: GitOverviewResponse = {
  generatedAt: "2026-11-06T12:00:00.000Z",
  repos: [
    {
      repoPath: "/home/u/callboard",
      name: "callboard",
      rows: [
        { cwd: "/home/u/callboard", branch: "main", isMain: true, cardIds: [] },
        { cwd: "/home/u/callboard.old-spike", branch: "old-spike", isMain: false, cardIds: [] },
        {
          cwd: "/home/u/callboard.feat-pr-track",
          branch: "feat/pr-track",
          isMain: false,
          cardIds: ["c1"],
          pr: { number: 525, url: "https://github.com/acme/callboard/pull/525", state: "open", title: "PR tracking" },
        },
        {
          cwd: "/home/u/callboard.fix-scroll",
          branch: "fix/scroll",
          isMain: false,
          // `gone` is archived on the board: it must not produce a chip.
          cardIds: ["c2", "gone"],
          pr: { number: 519, url: "https://github.com/acme/callboard/pull/519", state: "merged", title: "Fix scroll" },
        },
      ],
    },
    {
      repoPath: "/home/u/drawlatch",
      name: "drawlatch",
      prError: "gh is not installed",
      rows: [{ cwd: "/home/u/drawlatch", branch: "main", isMain: true, cardIds: ["c3"] }],
    },
    // Only cards the board does not hold: the whole repo stays off screen.
    { repoPath: "/home/u/elsewhere", name: "elsewhere", rows: [{ cwd: "/home/u/elsewhere", branch: "main", isMain: true, cardIds: ["other-space"] }] },
  ],
};

const mockOverview = vi.mocked(getGitOverview);

async function mount(onOpenCard = vi.fn()) {
  render(<BranchesView cards={CARDS} onOpenCard={onOpenCard} />);
  await screen.findAllByRole("heading", { level: 2 });
  return onOpenCard;
}

const row = (cwd: string) => screen.getAllByTestId("branch-row").find((el) => el.querySelector(`[title="${cwd}"]`))!;

beforeEach(() => {
  vi.clearAllMocks();
  mockOverview.mockResolvedValue(OVERVIEW);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});
afterEach(cleanup);

describe("BranchesView", () => {
  it("groups rows under their repository, hiding a repo none of whose cards the board shows", async () => {
    await mount();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["callboard", "drawlatch"]);
    const callboard = screen.getByRole("region", { name: "callboard" });
    expect(within(callboard).getAllByTestId("branch-row")).toHaveLength(4);
  });

  it("orders the main checkout first, then the worktrees in use, then the idle ones", async () => {
    await mount();
    const callboard = screen.getByRole("region", { name: "callboard" });
    const branches = within(callboard)
      .getAllByTestId("branch-row")
      .map((el) => el.querySelector("span")!.textContent);
    expect(branches).toEqual(["main", "feat/pr-track", "fix/scroll", "old-spike"]);
  });

  it("attaches chips for open cards only, and opens the drawer from one", async () => {
    const onOpenCard = await mount();
    const scroll = row("/home/u/callboard.fix-scroll");
    expect(
      within(scroll)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Scroll latch"]);

    fireEvent.click(within(row("/home/u/callboard.feat-pr-track")).getByRole("button", { name: "PR tracking" }));
    expect(onOpenCard).toHaveBeenCalledWith("c1");
  });

  it("dims rows with no active chats", async () => {
    await mount();
    expect(row("/home/u/callboard.old-spike").dataset.dimmed).toBe("true");
    expect(row("/home/u/callboard").dataset.dimmed).toBe("true");
    expect(row("/home/u/callboard.feat-pr-track").dataset.dimmed).toBeUndefined();
    expect(within(row("/home/u/callboard.old-spike")).getByText("no active chats")).toBeDefined();
  });

  it("links the PR badge with its number and state", async () => {
    await mount();
    const open = within(row("/home/u/callboard.feat-pr-track")).getByRole("link");
    expect(open.getAttribute("href")).toBe("https://github.com/acme/callboard/pull/525");
    expect(open.textContent).toContain("#525 open");
    expect(within(row("/home/u/callboard.fix-scroll")).getByRole("link").textContent).toContain("#519 merged");
    expect(within(row("/home/u/callboard.old-spike")).getByText("no PR")).toBeDefined();
  });

  it("renders the badge without a link when the URL is not a github.com PR", async () => {
    mockOverview.mockResolvedValue({
      generatedAt: OVERVIEW.generatedAt,
      repos: [
        {
          repoPath: "/r",
          name: "r",
          rows: [{ cwd: "/r", branch: "feat", isMain: true, cardIds: ["c1"], pr: { number: 9, url: "javascript:alert(1)", state: "open", title: "x" } }],
        },
      ],
    });
    await mount();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByLabelText("PR #9 open: x").textContent).toContain("#9 open");
  });

  it("flags a repo whose PR lookup failed", async () => {
    await mount();
    expect(screen.getByLabelText("PR data unavailable: gh is not installed")).toBeDefined();
  });

  it("shows the path relative to the repo's parent, with the full path on hover", async () => {
    await mount();
    expect(row("/home/u/callboard.feat-pr-track").querySelector('[title="/home/u/callboard.feat-pr-track"]')!.textContent).toBe("callboard.feat-pr-track");
  });

  it("folds chips past four behind a +N toggle", async () => {
    const many = Array.from({ length: 6 }, (_, i) => card(`m${i}`, `Card ${i}`));
    mockOverview.mockResolvedValue({
      generatedAt: OVERVIEW.generatedAt,
      repos: [{ repoPath: "/r", name: "r", rows: [{ cwd: "/r", branch: "main", isMain: true, cardIds: many.map((c) => c.id) }] }],
    });
    render(<BranchesView cards={many} onOpenCard={vi.fn()} />);
    await screen.findByRole("heading", { level: 2 });
    expect(screen.getAllByRole("button", { name: /^Card / })).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "+2 more" }));
    expect(screen.getAllByRole("button", { name: /^Card / })).toHaveLength(6);
  });

  it("refetches with refresh=true from the refresh button", async () => {
    await mount();
    expect(mockOverview).toHaveBeenLastCalledWith(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh branches" }));
    });
    expect(mockOverview).toHaveBeenLastCalledWith(true);
  });

  it("says how fresh the data is", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T12:00:40.000Z"));
    try {
      await mount();
      expect(screen.getByText("updated 40s ago")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the error and no rows when the overview fails", async () => {
    mockOverview.mockRejectedValue(new Error("boom"));
    render(<BranchesView cards={CARDS} onOpenCard={vi.fn()} />);
    expect(await screen.findByText("boom")).toBeDefined();
    expect(screen.queryAllByTestId("branch-row")).toHaveLength(0);
  });
});
