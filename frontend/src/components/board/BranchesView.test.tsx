import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PR_REQUEST_TIMEOUT_MS } from "../git/timedRequest";
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
  card("c4", "Main work"),
  card("gone", "Archived", { lifecycle: "closed" }),
];

const OVERVIEW: GitOverviewResponse = {
  generatedAt: "2026-11-06T12:00:00.000Z",
  repos: [
    {
      repoPath: "/home/u/callboard",
      name: "callboard",
      // The daemon only sends rows with open cards — but in ANY space, so a
      // row can still hold nothing the board shows (old-spike). Main is last
      // here to prove the view orders it first.
      rows: [
        { cwd: "/home/u/callboard.old-spike", branch: "old-spike", isMain: false, cardIds: ["other-space"] },
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
        { cwd: "/home/u/callboard", branch: "main", isMain: true, cardIds: ["c4"] },
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
    expect(within(callboard).getAllByTestId("branch-row")).toHaveLength(3);
  });

  it("counts the rows it shows beside the repo name", async () => {
    await mount();
    const heading = screen.getByRole("heading", { level: 2, name: "callboard" });
    expect(heading.nextElementSibling!.textContent).toBe("3");
  });

  it("orders the main checkout first", async () => {
    await mount();
    const callboard = screen.getByRole("region", { name: "callboard" });
    const branches = within(callboard)
      .getAllByTestId("branch-row")
      .map((el) => el.querySelector("span")!.textContent);
    expect(branches).toEqual(["main", "feat/pr-track", "fix/scroll"]);
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

  it("hides a row none of whose cards the board shows", async () => {
    await mount();
    expect(screen.queryByTitle("/home/u/callboard.old-spike")).toBeNull();
  });

  it("copes with a repo that arrives with no rows, and with nothing to show at all", async () => {
    mockOverview.mockResolvedValue({ generatedAt: OVERVIEW.generatedAt, repos: [{ repoPath: "/r", name: "r", rows: [] }] });
    render(<BranchesView cards={CARDS} onOpenCard={vi.fn()} />);
    expect(await screen.findByText("No open card is working in a git repository.")).toBeDefined();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  it("links the PR badge with its number and state", async () => {
    await mount();
    const open = within(row("/home/u/callboard.feat-pr-track")).getByRole("link");
    expect(open.getAttribute("href")).toBe("https://github.com/acme/callboard/pull/525");
    expect(open.textContent).toContain("#525 open");
    expect(within(row("/home/u/callboard.fix-scroll")).getByRole("link").textContent).toContain("#519 merged");
    expect(within(row("/home/u/callboard")).getByText("no PR")).toBeDefined();
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

  it("badges a row with every PR the trail added, in the order sent", async () => {
    const badge = (number: number, state: "open" | "merged" | "closed") => ({
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      state,
      title: `PR ${number}`,
    });
    mockOverview.mockResolvedValue({
      generatedAt: OVERVIEW.generatedAt,
      repos: [
        {
          repoPath: "/home/u/app",
          name: "app",
          rows: [
            {
              cwd: "/home/u/app",
              branch: "feat/now",
              isMain: true,
              cardIds: ["c1"],
              pr: badge(12, "open"),
              prs: [badge(12, "open"), badge(7, "open"), badge(5, "merged")],
            },
          ],
        },
      ],
    });
    await mount();
    const links = within(row("/home/u/app")).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["#12 open", "#7 open", "#5 merged"]);
  });

  it("marks a removed worktree's row, with its PRs and chips", async () => {
    mockOverview.mockResolvedValue({
      generatedAt: OVERVIEW.generatedAt,
      repos: [
        {
          repoPath: "/home/u/app",
          name: "app",
          rows: [
            { cwd: "/home/u/app", branch: "main", isMain: true, cardIds: ["c3"] },
            {
              cwd: "/home/u/app.gone",
              branch: "feat/gone",
              isMain: false,
              removed: true,
              cardIds: ["c1"],
              prs: [{ number: 6, url: "https://github.com/acme/app/pull/6", state: "closed", title: "Gone" }],
            },
          ],
        },
      ],
    });
    await mount();
    const removed = row("/home/u/app.gone");
    expect(removed.dataset.removed).toBe("true");
    expect(within(removed).getByText("removed")).toBeDefined();
    expect(within(removed).getByTitle("feat/gone (worktree removed)")).toBeDefined();
    expect(within(removed).getByRole("link").textContent).toBe("#6 closed");
    expect(within(removed).getByRole("button", { name: "PR tracking" })).toBeDefined();
    expect(row("/home/u/app").dataset.removed).toBeUndefined();
    expect(within(row("/home/u/app")).queryByText("removed")).toBeNull();
  });

  it("names a removed row that only a PR link recorded by its directory, not as a detached HEAD", async () => {
    mockOverview.mockResolvedValue({
      generatedAt: OVERVIEW.generatedAt,
      repos: [
        {
          repoPath: "/home/u/app",
          name: "app",
          rows: [
            {
              cwd: "/home/u/app.gone",
              branch: null,
              isMain: false,
              removed: true,
              cardIds: ["c1"],
              prs: [{ number: 6, url: "https://github.com/acme/app/pull/6", state: "merged", title: "Gone" }],
            },
          ],
        },
      ],
    });
    await mount();
    const removed = row("/home/u/app.gone");
    expect(within(removed).getByTitle("/home/u/app.gone (worktree removed)").textContent).toBe("app.gone");
    expect(within(removed).queryByText("(detached)")).toBeNull();
  });

  it("hides a removed row whose cards the board does not show", async () => {
    mockOverview.mockResolvedValue({
      generatedAt: OVERVIEW.generatedAt,
      repos: [
        {
          repoPath: "/home/u/app",
          name: "app",
          rows: [
            { cwd: "/home/u/app", branch: "main", isMain: true, cardIds: ["c3"] },
            {
              cwd: "/home/u/app.gone",
              branch: "feat/gone",
              isMain: false,
              removed: true,
              cardIds: ["other-space"],
              prs: [{ number: 6, url: "https://github.com/acme/app/pull/6", state: "closed", title: "Gone" }],
            },
          ],
        },
      ],
    });
    await mount();
    expect(screen.queryByTitle("/home/u/app.gone")).toBeNull();
  });

  it("flags a repo whose PR lookup failed", async () => {
    await mount();
    expect(screen.getByLabelText("PR data unavailable: gh is not installed")).toBeDefined();
  });

  it("words the flag as the PRs tab does when the listing worked and only a by-number lookup failed", async () => {
    mockOverview.mockResolvedValue({
      generatedAt: OVERVIEW.generatedAt,
      repos: [{ repoPath: "/home/u/app", name: "app", prError: "gh timed out", prErrorPartial: true, rows: [{ cwd: "/home/u/app", branch: "main", isMain: true, cardIds: ["c3"] }] }],
    });
    await mount();
    expect(screen.getByLabelText("PR data may be incomplete or out of date — a GitHub lookup failed: gh timed out")).toBeDefined();
    expect(screen.queryByLabelText(/PR data unavailable/)).toBeNull();
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
    expect(mockOverview).toHaveBeenCalledWith(true, expect.any(AbortSignal));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh branches" }));
    });
    expect(mockOverview).toHaveBeenCalledTimes(2);
    expect(mockOverview).toHaveBeenLastCalledWith(true, expect.any(AbortSignal));
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

describe("BranchesView: refresh on load", () => {
  /** A response the test settles by hand. */
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  const button = () => screen.getByRole("button", { name: "Refresh branches" }) as HTMLButtonElement;
  const settle = () => act(async () => {});

  it("makes exactly one request on mount, forced, with the button busy until it settles", async () => {
    const first = deferred<Awaited<ReturnType<typeof mockOverview>>>();
    mockOverview.mockReturnValueOnce(first.promise);
    render(<BranchesView cards={CARDS} onOpenCard={vi.fn()} />);
    expect(mockOverview).toHaveBeenCalledTimes(1);
    expect(mockOverview).toHaveBeenCalledWith(true, expect.any(AbortSignal));
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    await act(async () => first.resolve(OVERVIEW));
    expect(button().disabled).toBe(false);
    expect(button().getAttribute("aria-busy")).toBe("false");
    expect(mockOverview).toHaveBeenCalledTimes(1);
  });

  it("re-enables the button when the forced request fails", async () => {
    const first = deferred<Awaited<ReturnType<typeof mockOverview>>>();
    mockOverview.mockReturnValueOnce(first.promise);
    render(<BranchesView cards={CARDS} onOpenCard={vi.fn()} />);
    expect(button().disabled).toBe(true);
    await act(async () => first.reject(new Error("offline")));
    expect(screen.getByText("offline")).toBeDefined();
    expect(button().disabled).toBe(false);
  });

  it("keeps the button busy through a manual refresh as well", async () => {
    render(<BranchesView cards={CARDS} onOpenCard={vi.fn()} />);
    await settle();
    const manual = deferred<Awaited<ReturnType<typeof mockOverview>>>();
    mockOverview.mockReturnValueOnce(manual.promise);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(mockOverview).toHaveBeenLastCalledWith(true, expect.any(AbortSignal));
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    await act(async () => manual.resolve(OVERVIEW));
    expect(button().disabled).toBe(false);
  });

  it("polls unforced, and not while a refresh is in flight", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    render(<BranchesView cards={CARDS} onOpenCard={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockOverview).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockOverview).toHaveBeenCalledTimes(2);
    expect(mockOverview).toHaveBeenLastCalledWith(false, expect.any(AbortSignal));

    // A manual refresh that hangs: the next poll tick must not fire, nor
    // land and re-enable the button early.
    const manual = deferred<Awaited<ReturnType<typeof mockOverview>>>();
    mockOverview.mockReturnValueOnce(manual.promise);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(mockOverview).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockOverview).toHaveBeenCalledTimes(3);
    expect(button().disabled).toBe(true);
    await act(async () => {
      manual.resolve(OVERVIEW);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(button().disabled).toBe(false);
    vi.useRealTimers();
  });
});

describe("BranchesView: a request that never settles", () => {
  /** Like fetch on a dead socket: never answers, but rejects once its signal aborts. */
  const hangUntilAborted = (...args: unknown[]) =>
    new Promise<never>((_resolve, reject) => {
      const signal = args[args.length - 1] as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const button = () => screen.getByRole("button", { name: "Refresh branches" }) as HTMLButtonElement;

  it("times out: the button is re-enabled, the timeout is shown as an error, and polls resume", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    try {
      mockOverview.mockImplementationOnce(hangUntilAborted as never);
      mockOverview.mockResolvedValue(OVERVIEW);
      render(<BranchesView cards={CARDS} onOpenCard={vi.fn()} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(button().disabled).toBe(true);
      // Within the timeout no poll starts behind the stuck refresh.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PR_REQUEST_TIMEOUT_MS - 1);
      });
      expect(mockOverview).toHaveBeenCalledTimes(1);
      expect(button().disabled).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(button().disabled).toBe(false);
      expect(button().getAttribute("aria-busy")).toBe("false");
      expect(screen.getByText("Timed out loading branches — try refreshing.")).toBeDefined();

      // The next poll tick goes out, unforced.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mockOverview.mock.calls.length).toBeGreaterThan(1);
      expect(mockOverview.mock.calls.at(-1)![0]).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts what is in flight when the view goes away", async () => {
    mockOverview.mockImplementationOnce(hangUntilAborted as never);
    const { unmount } = render(<BranchesView cards={CARDS} onOpenCard={vi.fn()} />);
    const signal = mockOverview.mock.calls[0].at(-1) as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
