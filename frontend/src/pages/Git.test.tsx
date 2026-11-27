// @vitest-environment jsdom
/**
 * The Git page: it holds the open cards for the active space, hands them to
 * the branches overview, and a chip opens that conversation's root chat.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import type { CardSummary } from "../api";
import { getGitOverview, listCards } from "../api";
import type { SpaceListItem } from "shared/types/space.js";
import { SpaceContext } from "../contexts/SpaceContext";
import { makeSpaceContext } from "../testing/spaceContext";
import { clearGitRequestCache } from "../components/git/useGitRequest";
import { RELOAD_DEBOUNCE_MS } from "../components/git/BranchesView";
import Git, { clearGitPageCache } from "./Git";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listCards: vi.fn(),
  getGitOverview: vi.fn(),
}));

const session = vi.hoisted(() => ({ metadataVersion: 0 }));
vi.mock("../contexts/SessionContext", () => ({ useMetadataVersion: () => session.metadataVersion }));

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
  clearGitRequestCache();
  clearGitPageCache();
  session.metadataVersion = 0;
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
  return render(
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

describe("the Git page: painting without waiting", () => {
  const EMPTY = "No active conversation is working in a git repository.";
  const settle = () => act(async () => {});

  it("asks for the overview alongside the cards, not after them", () => {
    vi.mocked(listCards).mockReturnValue(new Promise(() => {}));
    mount();
    expect(listCards).toHaveBeenCalledTimes(1);
    expect(getGitOverview).toHaveBeenCalledTimes(1);
    expect(getGitOverview).toHaveBeenCalledWith(false, expect.any(AbortSignal));
  });

  it("does not call the page empty while the cards are still loading", async () => {
    let answer!: (value: { cards: CardSummary[] }) => void;
    vi.mocked(listCards).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    mount();
    await settle();
    // The overview has answered; the cards have not.
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.getByText("Loading branches…")).toBeDefined();
    await act(async () => answer({ cards: CARDS }));
    expect(screen.getByRole("heading", { level: 2, name: "app" })).toBeDefined();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("says the page is empty when the cards load and none has a row", async () => {
    vi.mocked(listCards).mockResolvedValue({ cards: [] });
    mount();
    expect(await screen.findByText(EMPTY)).toBeDefined();
  });

  it("paints rows and chips at once on a second visit, before anything answers", async () => {
    const first = mount();
    await screen.findByRole("button", { name: "PR tracking" });
    first.unmount();

    vi.mocked(listCards).mockReturnValue(new Promise(() => {}));
    vi.mocked(getGitOverview).mockReturnValue(new Promise(() => {}));
    mount();
    expect(screen.getByRole("heading", { level: 2, name: "app" })).toBeDefined();
    expect(screen.getByRole("button", { name: "PR tracking" })).toBeDefined();
    expect(screen.queryByText("Loading branches…")).toBeNull();
  });

  it("remembers cards per space: another space's page waits for its own", async () => {
    const first = mount();
    await screen.findByRole("button", { name: "PR tracking" });
    first.unmount();

    vi.mocked(listCards).mockReturnValue(new Promise(() => {}));
    mount(
      <SpaceContext.Provider value={makeSpaceContext(SPACES, { activeSpaceId: "sp_work" })}>
        <Git />
      </SpaceContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: "PR tracking" })).toBeNull();
    expect(screen.getByText("Loading branches…")).toBeDefined();
  });

  it("asks for the overview again shortly after a metadata change", async () => {
    vi.useFakeTimers();
    try {
      const view = mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getGitOverview).toHaveBeenCalledTimes(2);
      session.metadataVersion = 1;
      view.rerender(
        <MemoryRouter initialEntries={["/git"]}>
          <Routes>
            <Route path="/git" element={<Git />} />
          </Routes>
        </MemoryRouter>,
      );
      // The cards refetch at 300ms; the overview follows once they land.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(getGitOverview).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS);
      });
      expect(listCards).toHaveBeenCalledTimes(2);
      expect(getGitOverview).toHaveBeenCalledTimes(3);
      expect(getGitOverview).toHaveBeenLastCalledWith(false, expect.any(AbortSignal));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the Git page: one side failing", () => {
  const EMPTY = "No active conversation is working in a git repository.";

  it("cards fail, overview answers: the cards' error, and no chips to hang rows on", async () => {
    vi.mocked(listCards).mockRejectedValue(new Error("daemon down"));
    mount();
    expect(await screen.findByText("daemon down")).toBeDefined();
    // As on main: with no cards there is no row to show.
    expect(await screen.findByText(EMPTY)).toBeDefined();
    expect(screen.queryAllByTestId("branch-row")).toHaveLength(0);
    expect(screen.queryByText("Loading branches…")).toBeNull();
    expect(getGitOverview).toHaveBeenCalled();
  });

  it("cards fail on a return visit: what was remembered stays on screen beside the error", async () => {
    const first = mount();
    await screen.findByRole("button", { name: "PR tracking" });
    first.unmount();
    vi.mocked(listCards).mockRejectedValue(new Error("daemon down"));
    mount();
    expect(await screen.findByText("daemon down")).toBeDefined();
    expect(screen.getByRole("button", { name: "PR tracking" })).toBeDefined();
  });

  it("a failed card list is not remembered as an empty one", async () => {
    vi.mocked(listCards).mockRejectedValue(new Error("daemon down"));
    const first = mount();
    await screen.findByText("daemon down");
    first.unmount();
    vi.mocked(listCards).mockReturnValue(new Promise(() => {}));
    mount();
    // Nothing remembered: the page waits for its cards rather than calling itself empty.
    await act(async () => {});
    expect(screen.getByText("Loading branches…")).toBeDefined();
    expect(screen.queryByText(EMPTY)).toBeNull();
  });

  it("overview fails, cards answer: the overview's error alone", async () => {
    vi.mocked(getGitOverview).mockRejectedValue(new Error("git broke"));
    mount();
    expect(await screen.findByText("git broke")).toBeDefined();
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.queryByText("Loading branches…")).toBeNull();
  });
});

describe("the Git page: switching space while it is open", () => {
  const WORK_CARDS = [card("w1", "Work thing")];
  const inSpace = (activeSpaceId: string) => (
    <MemoryRouter initialEntries={["/git"]}>
      <SpaceContext.Provider value={makeSpaceContext(SPACES, { activeSpaceId })}>
        <Routes>
          <Route path="/git" element={<Git />} />
        </Routes>
      </SpaceContext.Provider>
    </MemoryRouter>
  );

  beforeEach(() => {
    vi.mocked(getGitOverview).mockResolvedValue({
      generatedAt: new Date().toISOString(),
      repos: [
        {
          repoPath: "/src/app",
          name: "app",
          rows: [
            { cwd: "/src/app", branch: "main", isMain: true, cardIds: ["c1"] },
            { cwd: "/src/app.work", branch: "work", isMain: false, cardIds: ["w1"] },
          ],
        },
      ],
    });
    vi.mocked(listCards).mockImplementation(async (_archived, options) => ({ cards: options?.space === "sp_work" ? WORK_CARDS : CARDS }));
  });

  it("asks for the new space's cards and swaps the chips when they land", async () => {
    const view = render(inSpace("default"));
    await screen.findByRole("button", { name: "PR tracking" });
    expect(screen.queryByRole("button", { name: "Work thing" })).toBeNull();

    let answer!: (value: { cards: CardSummary[] }) => void;
    vi.mocked(listCards).mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    view.rerender(inSpace("sp_work"));
    expect(listCards).toHaveBeenLastCalledWith(false, { space: "sp_work", lifecycle: "open" });
    // Until they land the previous space's chips stay, as on main; the page never blanks.
    expect(screen.getByRole("button", { name: "PR tracking" })).toBeDefined();
    expect(screen.queryByText("Loading branches…")).toBeNull();

    await act(async () => answer({ cards: WORK_CARDS }));
    expect(screen.getByRole("button", { name: "Work thing" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "PR tracking" })).toBeNull();
  });

  it("drops the old space's answer if it lands after the switch", async () => {
    let late!: (value: { cards: CardSummary[] }) => void;
    vi.mocked(listCards).mockReturnValueOnce(new Promise((resolve) => (late = resolve)));
    const view = render(inSpace("default"));
    view.rerender(inSpace("sp_work"));
    await screen.findByRole("button", { name: "Work thing" });
    await act(async () => late({ cards: CARDS }));
    expect(screen.getByRole("button", { name: "Work thing" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "PR tracking" })).toBeNull();
  });

  it("remembers each space's cards under its own key", async () => {
    const view = render(inSpace("default"));
    await screen.findByRole("button", { name: "PR tracking" });
    view.rerender(inSpace("sp_work"));
    await screen.findByRole("button", { name: "Work thing" });
    view.unmount();

    vi.mocked(listCards).mockReturnValue(new Promise(() => {}));
    const work = render(inSpace("sp_work"));
    expect(screen.getByRole("button", { name: "Work thing" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "PR tracking" })).toBeNull();
    work.unmount();
    render(inSpace("default"));
    expect(screen.getByRole("button", { name: "PR tracking" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Work thing" })).toBeNull();
  });

  it("asks the overview again, once, for the changed set of cards", async () => {
    vi.useFakeTimers();
    try {
      const view = render(inSpace("default"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getGitOverview).toHaveBeenCalledTimes(2);
      view.rerender(inSpace("sp_work"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RELOAD_DEBOUNCE_MS);
      });
      expect(getGitOverview).toHaveBeenCalledTimes(3);
      expect(getGitOverview).toHaveBeenLastCalledWith(false, expect.any(AbortSignal));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the Git page: one event, one overview reload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const page = () => (
    <MemoryRouter initialEntries={["/git"]}>
      <Routes>
        <Route path="/git" element={<Git />} />
      </Routes>
    </MemoryRouter>
  );
  /** Answers `cards` after `ms`, like a slow daemon. */
  const slowCards = (cards: CardSummary[], ms: number) => () => new Promise<{ cards: CardSummary[] }>((resolve) => setTimeout(() => resolve({ cards }), ms));

  it("a slow card list that brings a new card makes one request, after it lands", async () => {
    const view = render(page());
    await advance(0);
    expect(getGitOverview).toHaveBeenCalledTimes(2);

    // Slower than the reload debounce: the overview must not be asked before the cards are in.
    vi.mocked(listCards).mockImplementation(slowCards([...CARDS, card("c3", "New worktree chat")], 1_000));
    session.metadataVersion = 1;
    view.rerender(page());
    await advance(300 + 999);
    expect(getGitOverview).toHaveBeenCalledTimes(2);
    await advance(1);
    await advance(RELOAD_DEBOUNCE_MS - 1);
    expect(getGitOverview).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(getGitOverview).toHaveBeenCalledTimes(3);
    expect(getGitOverview).toHaveBeenLastCalledWith(false, expect.any(AbortSignal));
    // And nothing more follows.
    await advance(5_000);
    expect(getGitOverview).toHaveBeenCalledTimes(3);
  });

  it("a metadata change that leaves the cards as they were still makes one", async () => {
    const view = render(page());
    await advance(0);
    session.metadataVersion = 1;
    view.rerender(page());
    await advance(300);
    await advance(RELOAD_DEBOUNCE_MS);
    await advance(5_000);
    expect(getGitOverview).toHaveBeenCalledTimes(3);
  });

  it("a metadata change whose card refetch fails still asks the overview again", async () => {
    const view = render(page());
    await advance(0);
    vi.mocked(listCards).mockRejectedValue(new Error("daemon down"));
    session.metadataVersion = 1;
    view.rerender(page());
    await advance(300);
    await advance(RELOAD_DEBOUNCE_MS);
    expect(getGitOverview).toHaveBeenCalledTimes(3);
  });

  it("a burst of metadata changes makes one card refetch and one overview request", async () => {
    const view = render(page());
    await advance(0);
    for (const version of [1, 2, 3]) {
      session.metadataVersion = version;
      view.rerender(page());
      await advance(100);
    }
    await advance(300);
    await advance(RELOAD_DEBOUNCE_MS);
    expect(listCards).toHaveBeenCalledTimes(2);
    expect(getGitOverview).toHaveBeenCalledTimes(3);
  });
});

describe("the Git page under StrictMode", () => {
  it("paints its rows, ends idle, and leaves no error", async () => {
    render(
      <StrictMode>
        <MemoryRouter initialEntries={["/git"]}>
          <Routes>
            <Route path="/git" element={<Git />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
    expect(await screen.findByRole("button", { name: "PR tracking" })).toBeDefined();
    const refresh = screen.getByRole("button", { name: "Refresh branches" }) as HTMLButtonElement;
    await vi.waitFor(() => expect(refresh.disabled).toBe(false));
    // Unforced (aborted with the discarded mount), unforced, forced — and no reload on top.
    expect(vi.mocked(getGitOverview).mock.calls.map((c) => c[0])).toEqual([false, false, true]);
    expect((vi.mocked(getGitOverview).mock.calls[0][1] as AbortSignal).aborted).toBe(true);
    expect(screen.queryByText(/Failed|Timed out/)).toBeNull();
  });
});

describe("the Git page: remembered cards are not a current answer", () => {
  const EMPTY = "No active conversation is working in a git repository.";
  const settle = () => act(async () => {});

  /** Visit once with `cards`, leave, and come back with the card request still out. */
  async function comeBack(cards: CardSummary[]) {
    vi.mocked(listCards).mockResolvedValue({ cards });
    const first = mount();
    await settle();
    first.unmount();
    let answer!: (value: { cards: CardSummary[] }) => void;
    vi.mocked(listCards).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    mount();
    // The overview of this mount has answered; the cards have not.
    await settle();
    return answer;
  }

  it("a remembered empty card list does not call the page empty: loading until the cards land", async () => {
    const answer = await comeBack([]);
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.getByText("Loading branches…")).toBeDefined();
    // A chat started in a repo since the last visit.
    await act(async () => answer({ cards: CARDS }));
    expect(screen.getByRole("button", { name: "PR tracking" })).toBeDefined();
    expect(screen.queryByText("Loading branches…")).toBeNull();
  });

  it("nor do remembered cards none of which has a row", async () => {
    const answer = await comeBack([card("elsewhere", "Not in a repo")]);
    expect(screen.queryByText(EMPTY)).toBeNull();
    expect(screen.getByText("Loading branches…")).toBeDefined();
    await act(async () => answer({ cards: CARDS }));
    expect(screen.getByRole("button", { name: "PR tracking" })).toBeDefined();
  });

  it("says empty once the cards of this mount confirm it", async () => {
    const answer = await comeBack([]);
    await act(async () => answer({ cards: [] }));
    expect(screen.getByText(EMPTY)).toBeDefined();
    expect(screen.queryByText("Loading branches…")).toBeNull();
  });

  it("says empty beside the cards' error when the cards of this mount fail", async () => {
    vi.mocked(listCards).mockResolvedValue({ cards: [] });
    const first = mount();
    await settle();
    first.unmount();
    vi.mocked(listCards).mockRejectedValue(new Error("daemon down"));
    mount();
    expect(await screen.findByText("daemon down")).toBeDefined();
    expect(screen.getByText(EMPTY)).toBeDefined();
    expect(screen.queryByText("Loading branches…")).toBeNull();
  });
});

describe("the Git page: a card answer that arrives after the page went away", () => {
  const settle = () => act(async () => {});
  const leaveWithCardsOut = async () => {
    let late!: (value: { cards: CardSummary[] }) => void;
    vi.mocked(listCards).mockReturnValue(new Promise((resolve) => (late = resolve)));
    const page = mount();
    await settle();
    page.unmount();
    return late;
  };
  const expectNothingRemembered = async () => {
    vi.mocked(listCards).mockReturnValue(new Promise(() => {}));
    mount();
    await settle();
    expect(screen.queryByRole("button", { name: "PR tracking" })).toBeNull();
    expect(screen.getByText("Loading branches…")).toBeDefined();
  };

  it("is not remembered", async () => {
    const late = await leaveWithCardsOut();
    await act(async () => late({ cards: CARDS }));
    await expectNothingRemembered();
  });

  it("cannot refill the memory a logout cleared", async () => {
    const late = await leaveWithCardsOut();
    clearGitRequestCache();
    clearGitPageCache();
    await act(async () => late({ cards: CARDS }));
    await expectNothingRemembered();
  });
});

describe("the Git page: the overview reload a metadata change owes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  const page = () => (
    <MemoryRouter initialEntries={["/git"]}>
      <Routes>
        <Route path="/git" element={<Git />} />
      </Routes>
    </MemoryRouter>
  );

  it("is paid by the poll that superseded the metadata refetch, with the card ids unchanged", async () => {
    const view = render(page());
    await advance(0);
    expect(getGitOverview).toHaveBeenCalledTimes(2);

    // A metadata change 310ms before the 15s card poll: its refetch goes out at 14.99s and hangs.
    await advance(14_690);
    let late!: (value: { cards: CardSummary[] }) => void;
    vi.mocked(listCards).mockReturnValueOnce(new Promise((resolve) => (late = resolve)));
    session.metadataVersion = 1;
    view.rerender(page());
    await advance(300);
    expect(listCards).toHaveBeenCalledTimes(2);
    // The poll supersedes it and answers at once, with the same cards.
    await advance(10);
    expect(listCards).toHaveBeenCalledTimes(3);
    await act(async () => late({ cards: CARDS }));
    await advance(RELOAD_DEBOUNCE_MS);
    expect(getGitOverview).toHaveBeenCalledTimes(3);
    expect(getGitOverview).toHaveBeenLastCalledWith(false, expect.any(AbortSignal));
    // Once: the poll after that owes nothing.
    await advance(15_000);
    expect(getGitOverview).toHaveBeenCalledTimes(3);
  });

  it("is not paid by a card poll when no metadata changed", async () => {
    render(page());
    await advance(0);
    await advance(15_000 + RELOAD_DEBOUNCE_MS);
    expect(listCards).toHaveBeenCalledTimes(2);
    expect(getGitOverview).toHaveBeenCalledTimes(2);
  });
});
