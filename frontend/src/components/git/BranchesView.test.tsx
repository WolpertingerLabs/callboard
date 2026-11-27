import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { PR_REQUEST_TIMEOUT_MS } from "./timedRequest";
import { clearGitRequestCache } from "./useGitRequest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CardSummary, GitOverviewResponse } from "../../api";
import { getGitOverview } from "../../api";
import BranchesView, { RELOAD_DEBOUNCE_MS } from "./BranchesView";

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
      // row can still hold nothing the page shows (old-spike). Main is last
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
          // `gone` is archived: it must not produce a chip.
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
    // Only cards the page does not hold: the whole repo stays off screen.
    { repoPath: "/home/u/elsewhere", name: "elsewhere", rows: [{ cwd: "/home/u/elsewhere", branch: "main", isMain: true, cardIds: ["other-space"] }] },
  ],
};

const mockOverview = vi.mocked(getGitOverview);

async function mount(onOpenChat = vi.fn()) {
  render(<BranchesView cards={CARDS} onOpenChat={onOpenChat} />);
  await screen.findAllByRole("heading", { level: 2 });
  return onOpenChat;
}

const row = (cwd: string) => screen.getAllByTestId("branch-row").find((el) => el.querySelector(`[title="${cwd}"]`))!;

beforeEach(() => {
  vi.clearAllMocks();
  clearGitRequestCache();
  mockOverview.mockResolvedValue(OVERVIEW);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});
afterEach(cleanup);

describe("BranchesView", () => {
  it("groups rows under their repository, hiding a repo none of whose cards the page shows", async () => {
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
    const onOpenChat = await mount();
    const scroll = row("/home/u/callboard.fix-scroll");
    expect(
      within(scroll)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Scroll latch"]);

    fireEvent.click(within(row("/home/u/callboard.feat-pr-track")).getByRole("button", { name: "PR tracking" }));
    expect(onOpenChat).toHaveBeenCalledWith("c1");
  });

  it("hides a row none of whose cards the page shows", async () => {
    await mount();
    expect(screen.queryByTitle("/home/u/callboard.old-spike")).toBeNull();
  });

  it("copes with a repo that arrives with no rows, and with nothing to show at all", async () => {
    mockOverview.mockResolvedValue({ generatedAt: OVERVIEW.generatedAt, repos: [{ repoPath: "/r", name: "r", rows: [] }] });
    render(<BranchesView cards={CARDS} onOpenChat={vi.fn()} />);
    expect(await screen.findByText("No active conversation is working in a git repository.")).toBeDefined();
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

  it("hides a removed row whose cards the page does not show", async () => {
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
    render(<BranchesView cards={many} onOpenChat={vi.fn()} />);
    await screen.findByRole("heading", { level: 2 });
    expect(screen.getAllByRole("button", { name: /^Card / })).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "+2 more" }));
    expect(screen.getAllByRole("button", { name: /^Card / })).toHaveLength(6);
  });

  it("refetches with refresh=true from the refresh button", async () => {
    await mount();
    // The mount's two requests have settled once the button is idle again.
    const refresh = screen.getByRole("button", { name: "Refresh branches" }) as HTMLButtonElement;
    await waitFor(() => expect(refresh.disabled).toBe(false));
    expect(mockOverview).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.click(refresh);
    });
    expect(mockOverview).toHaveBeenCalledTimes(3);
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
    render(<BranchesView cards={CARDS} onOpenChat={vi.fn()} />);
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

  it("asks unforced on mount and paints that, then forced, with the button busy until the forced one settles", async () => {
    const first = deferred<Awaited<ReturnType<typeof mockOverview>>>();
    const second = deferred<Awaited<ReturnType<typeof mockOverview>>>();
    mockOverview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(<BranchesView cards={CARDS} onOpenChat={vi.fn()} />);
    expect(mockOverview).toHaveBeenCalledTimes(1);
    expect(mockOverview).toHaveBeenCalledWith(false, expect.any(AbortSignal));
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Loading branches…")).toBeDefined();

    await act(async () => first.resolve(OVERVIEW));
    // Painted from the unforced answer; the forced one is now out.
    expect(screen.queryByText("Loading branches…")).toBeNull();
    expect(mockOverview).toHaveBeenCalledTimes(2);
    expect(mockOverview).toHaveBeenLastCalledWith(true, expect.any(AbortSignal));
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");

    await act(async () => second.resolve(OVERVIEW));
    expect(button().disabled).toBe(false);
    expect(button().getAttribute("aria-busy")).toBe("false");
    expect(mockOverview).toHaveBeenCalledTimes(2);
  });

  it("re-enables the button when the forced request fails, keeping what the unforced one painted", async () => {
    const second = deferred<Awaited<ReturnType<typeof mockOverview>>>();
    mockOverview.mockResolvedValueOnce(OVERVIEW).mockReturnValueOnce(second.promise);
    render(<BranchesView cards={CARDS} onOpenChat={vi.fn()} />);
    await settle();
    expect(button().disabled).toBe(true);
    await act(async () => second.reject(new Error("offline")));
    expect(screen.getByText("offline")).toBeDefined();
    expect(screen.getByText(/^updated /)).toBeDefined();
    expect(button().disabled).toBe(false);
  });

  it("paints what it showed last at once when it is mounted again, and still asks again", async () => {
    const { unmount } = render(<BranchesView cards={CARDS} onOpenChat={vi.fn()} />);
    await settle();
    unmount();
    const again = deferred<Awaited<ReturnType<typeof mockOverview>>>();
    mockOverview.mockReturnValue(again.promise);
    mockOverview.mockClear();
    render(<BranchesView cards={CARDS} onOpenChat={vi.fn()} />);
    // No request has answered, yet there is no loading state.
    expect(screen.queryByText("Loading branches…")).toBeNull();
    expect(screen.getByText(/^updated /)).toBeDefined();
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(mockOverview).toHaveBeenCalledTimes(1);
    expect(mockOverview).toHaveBeenCalledWith(false, expect.any(AbortSignal));
  });

  it("keeps the button busy through a manual refresh as well", async () => {
    render(<BranchesView cards={CARDS} onOpenChat={vi.fn()} />);
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
    render(<BranchesView cards={CARDS} onOpenChat={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockOverview).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockOverview).toHaveBeenCalledTimes(3);
    expect(mockOverview).toHaveBeenLastCalledWith(false, expect.any(AbortSignal));

    // A manual refresh that hangs: the next poll tick must not fire, nor
    // land and re-enable the button early.
    const manual = deferred<Awaited<ReturnType<typeof mockOverview>>>();
    mockOverview.mockReturnValueOnce(manual.promise);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(mockOverview).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockOverview).toHaveBeenCalledTimes(4);
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

  it("times out: the button is re-enabled and polls resume; a refresh from the button that times out says so", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    try {
      // The mount's unforced request answers; its forced one never does.
      mockOverview.mockResolvedValueOnce(OVERVIEW);
      mockOverview.mockImplementationOnce(hangUntilAborted as never);
      mockOverview.mockResolvedValue(OVERVIEW);
      render(<BranchesView cards={CARDS} onOpenChat={vi.fn()} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(button().disabled).toBe(true);
      // Within the timeout no poll starts behind the stuck refresh.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PR_REQUEST_TIMEOUT_MS - 1);
      });
      expect(mockOverview).toHaveBeenCalledTimes(2);
      expect(button().disabled).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(button().disabled).toBe(false);
      expect(button().getAttribute("aria-busy")).toBe("false");
      // Given up without a banner: the unforced answer of this same mount is on screen.
      expect(screen.queryByText("Timed out loading branches — try refreshing.")).toBeNull();
      expect(screen.getByText(/^updated /)).toBeDefined();

      // The next poll tick goes out, unforced.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mockOverview.mock.calls.length).toBeGreaterThan(2);
      expect(mockOverview.mock.calls.at(-1)![0]).toBe(false);

      // A refresh from the button that never answers is shown as timed out.
      mockOverview.mockImplementationOnce(hangUntilAborted as never);
      await act(async () => {
        fireEvent.click(button());
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PR_REQUEST_TIMEOUT_MS);
      });
      expect(button().disabled).toBe(false);
      expect(screen.getByText("Timed out loading branches — try refreshing.")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts what is in flight when the view goes away", async () => {
    mockOverview.mockImplementationOnce(hangUntilAborted as never);
    const { unmount } = render(<BranchesView cards={CARDS} onOpenChat={vi.fn()} />);
    const signal = mockOverview.mock.calls[0].at(-1) as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe("BranchesView: before the cards arrive", () => {
  const settle = () => act(async () => {});

  it("asks for the overview without waiting for the cards", () => {
    render(<BranchesView cards={[]} cardsLoaded={false} onOpenChat={vi.fn()} />);
    expect(mockOverview).toHaveBeenCalledTimes(1);
  });

  it("stays on the loading line rather than calling the page empty, then joins the rows when the cards land", async () => {
    const { rerender } = render(<BranchesView cards={[]} cardsLoaded={false} onOpenChat={vi.fn()} />);
    await settle();
    expect(screen.getByText("Loading branches…")).toBeDefined();
    expect(screen.queryByText("No active conversation is working in a git repository.")).toBeNull();
    expect(screen.queryAllByTestId("branch-row")).toHaveLength(0);

    rerender(<BranchesView cards={CARDS} cardsLoaded onOpenChat={vi.fn()} />);
    expect(screen.queryByText("Loading branches…")).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["callboard", "drawlatch"]);
  });

  it("says the page is empty once the cards have loaded and none has a row", async () => {
    const { rerender } = render(<BranchesView cards={[]} cardsLoaded={false} onOpenChat={vi.fn()} />);
    await settle();
    rerender(<BranchesView cards={[]} cardsLoaded onOpenChat={vi.fn()} />);
    expect(screen.getByText("No active conversation is working in a git repository.")).toBeDefined();
    expect(screen.queryByText("Loading branches…")).toBeNull();
  });

  it("shows an overview failure, not the loading line, while the cards are still out", async () => {
    mockOverview.mockRejectedValue(new Error("boom"));
    render(<BranchesView cards={[]} cardsLoaded={false} onOpenChat={vi.fn()} />);
    expect(await screen.findByText("boom")).toBeDefined();
    expect(screen.queryByText("Loading branches…")).toBeNull();
  });
});

describe("BranchesView: keeping in step with the cards", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const flush = (ms = 0) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const view = (cards: CardSummary[], props: { cardsLoaded?: boolean; reloadToken?: number } = {}) => (
    <BranchesView cards={cards} onOpenChat={vi.fn()} {...props} />
  );

  it("asks again, unforced and debounced, when a card opens", async () => {
    const { rerender } = render(view(CARDS));
    await flush();
    expect(mockOverview).toHaveBeenCalledTimes(2);

    rerender(view([...CARDS, card("c5", "New worktree chat")]));
    await flush(RELOAD_DEBOUNCE_MS - 1);
    expect(mockOverview).toHaveBeenCalledTimes(2);
    await flush(1);
    expect(mockOverview).toHaveBeenCalledTimes(3);
    expect(mockOverview).toHaveBeenLastCalledWith(false, expect.any(AbortSignal));
  });

  it("shows the new card's row from that request", async () => {
    const { rerender } = render(view(CARDS));
    await flush();
    mockOverview.mockResolvedValue({
      ...OVERVIEW,
      repos: [{ repoPath: "/home/u/new", name: "new", rows: [{ cwd: "/home/u/new.wt", branch: "feat/new", isMain: false, cardIds: ["c5"] }] }],
    });
    rerender(view([...CARDS, card("c5", "New worktree chat")]));
    expect(screen.queryByRole("button", { name: "New worktree chat" })).toBeNull();
    await flush(RELOAD_DEBOUNCE_MS);
    expect(screen.getByRole("button", { name: "New worktree chat" })).toBeDefined();
  });

  it("asks again when a card closes, but not when the same open cards come back", async () => {
    const { rerender } = render(view(CARDS));
    await flush();
    // The page's 15s card poll: new objects, another order, a changed rollup — the same open ids.
    rerender(view([...CARDS].reverse().map((c) => ({ ...c, rollup: "active" as const }))));
    await flush(RELOAD_DEBOUNCE_MS);
    expect(mockOverview).toHaveBeenCalledTimes(2);

    rerender(view(CARDS.map((c) => (c.id === "c1" ? { ...c, lifecycle: "closed" as const } : c))));
    await flush(RELOAD_DEBOUNCE_MS);
    expect(mockOverview).toHaveBeenCalledTimes(3);
  });

  it("asks again when the reload token is bumped, once for a burst", async () => {
    const { rerender } = render(view(CARDS, { reloadToken: 1 }));
    await flush();
    rerender(view(CARDS, { reloadToken: 2 }));
    await flush(RELOAD_DEBOUNCE_MS - 1);
    // The card list the bump produced lands inside the debounce: still one request.
    rerender(view([...CARDS, card("c5", "New")], { reloadToken: 3 }));
    await flush(RELOAD_DEBOUNCE_MS - 1);
    expect(mockOverview).toHaveBeenCalledTimes(2);
    await flush(1);
    expect(mockOverview).toHaveBeenCalledTimes(3);
    expect(mockOverview).toHaveBeenLastCalledWith(false, expect.any(AbortSignal));
  });

  it("does not count the cards' first arrival as a change", async () => {
    const { rerender } = render(view([], { cardsLoaded: false }));
    await flush();
    rerender(view(CARDS, { cardsLoaded: true }));
    await flush(RELOAD_DEBOUNCE_MS);
    expect(mockOverview).toHaveBeenCalledTimes(2);
  });

  it("does not ask under a refresh in flight, but after it", async () => {
    let release!: (value: GitOverviewResponse) => void;
    const { rerender } = render(view(CARDS));
    await flush();
    mockOverview.mockReturnValueOnce(new Promise<GitOverviewResponse>((resolve) => (release = resolve)));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh branches" }));
    });
    expect(mockOverview).toHaveBeenCalledTimes(3);
    rerender(view([...CARDS, card("c5", "New")]));
    await flush(RELOAD_DEBOUNCE_MS);
    expect(mockOverview).toHaveBeenCalledTimes(3);
    await act(async () => {
      release(OVERVIEW);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockOverview).toHaveBeenCalledTimes(4);
    expect(mockOverview).toHaveBeenLastCalledWith(false, expect.any(AbortSignal));
  });

  it("drops a pending reload when the view goes away", async () => {
    const { rerender, unmount } = render(view(CARDS));
    await flush();
    rerender(view([...CARDS, card("c5", "New")]));
    unmount();
    await flush(RELOAD_DEBOUNCE_MS);
    expect(mockOverview).toHaveBeenCalledTimes(2);
  });
});

describe("BranchesView: a remembered answer with nothing to show", () => {
  const EMPTY = "No active conversation is working in a git repository.";
  const settle = () => act(async () => {});
  const NO_ROWS: GitOverviewResponse = { generatedAt: OVERVIEW.generatedAt, repos: [] };

  /** Mount once with `first` answered, leave, and come back with `second` still out. */
  async function comeBack(first: GitOverviewResponse, cards: CardSummary[] = CARDS) {
    mockOverview.mockResolvedValue(first);
    const one = render(<BranchesView cards={cards} onOpenChat={vi.fn()} />);
    await settle();
    one.unmount();
    let answer!: (value: GitOverviewResponse) => void;
    let fail!: (error: unknown) => void;
    mockOverview.mockReset();
    mockOverview.mockReturnValueOnce(
      new Promise<GitOverviewResponse>((resolve, reject) => {
        answer = resolve;
        fail = reject;
      }),
    );
    // The forced request that follows stays out.
    mockOverview.mockReturnValue(new Promise(() => {}));
    render(<BranchesView cards={cards} onOpenChat={vi.fn()} />);
    return { answer, fail };
  }

  it("says the page is empty on the first visit once the answer lands", async () => {
    mockOverview.mockResolvedValue(NO_ROWS);
    render(<BranchesView cards={CARDS} onOpenChat={vi.fn()} />);
    await settle();
    expect(screen.getByText(EMPTY)).toBeDefined();
  });

  it("does not present a remembered empty overview as the current state: loading until an answer lands", async () => {
    const { answer } = await comeBack(NO_ROWS);
    // A chat may have started in a repo since: what was remembered cannot say.
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.getByText("Loading branches…")).toBeDefined();
    await act(async () => answer(OVERVIEW));
    expect(screen.queryByText("Loading branches…")).toBeNull();
    expect(screen.getAllByTestId("branch-row").length).toBeGreaterThan(0);
  });

  it("says empty again as soon as an answer of this mount confirms it", async () => {
    const { answer } = await comeBack(NO_ROWS);
    await act(async () => answer(NO_ROWS));
    expect(screen.getByText(EMPTY)).toBeDefined();
    expect(screen.queryByText("Loading branches…")).toBeNull();
  });

  it("treats remembered rows none of which joins a card the same way", async () => {
    // Rows exist, but only for cards this page does not hold.
    const { answer } = await comeBack(OVERVIEW, [card("elsewhere", "Not in the overview")]);
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.getByText("Loading branches…")).toBeDefined();
    await act(async () => answer(OVERVIEW));
    expect(screen.getByText(EMPTY)).toBeDefined();
  });

  it("still paints remembered rows at once", async () => {
    await comeBack(OVERVIEW);
    expect(screen.queryByText("Loading branches…")).toBeNull();
    expect(screen.getAllByTestId("branch-row").length).toBeGreaterThan(0);
  });

  it("shows the error alone, neither loading nor empty, when no answer can be had", async () => {
    const { fail } = await comeBack(NO_ROWS);
    mockOverview.mockRejectedValue(new Error("offline"));
    await act(async () => fail(new Error("offline")));
    expect(screen.getByText("offline")).toBeDefined();
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.queryByText("Loading branches…")).toBeNull();
  });
});
