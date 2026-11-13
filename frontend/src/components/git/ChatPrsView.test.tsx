import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PR_REQUEST_TIMEOUT_MS } from "./timedRequest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatPr, ChatPrsResponse, FolderPrs } from "../../api";
import { getChatPrs } from "../../api";
import ChatPrsView from "./ChatPrsView";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  getChatPrs: vi.fn(),
}));

const NOW = Date.parse("2026-11-06T12:00:00.000Z");

function pr(number: number, overrides: Partial<ChatPr> = {}): ChatPr {
  return {
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    title: `PR ${number}`,
    state: "open",
    headRef: "feat/a",
    baseRef: "main",
    author: "octo",
    createdAt: "2026-11-04T12:00:00.000Z",
    updatedAt: "2026-11-06T10:00:00.000Z",
    ...overrides,
  };
}

/** A response: `current` as given; `prs` defaults to the live PR alone, as the daemon sends it without history. */
const response = (current: Partial<FolderPrs>, prs?: ChatPr[]): ChatPrsResponse => {
  const full: FolderPrs = { folder: "/src/app.feat-a", status: "no_pr", ...current };
  return { current: full, prs: prs ?? (full.pr ? [full.pr] : []), generatedAt: new Date(NOW - 30_000).toISOString() };
};

const mockPrs = vi.mocked(getChatPrs);

async function mount({ chatId }: { chatId?: string } = { chatId: "c1" }) {
  render(<ChatPrsView folder="/src/app.feat-a" chatId={chatId} />);
  await screen.findByText("updated 30s ago");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ChatPrsView", () => {
  it("shows the PR with its detail, linked to GitHub", async () => {
    mockPrs.mockResolvedValue(response({ status: "found", branch: "feat/a", repoName: "app", pr: pr(42, { title: "Add PR tracking" }) }));
    await mount();
    expect(mockPrs).toHaveBeenCalledWith("/src/app.feat-a", "c1", true, expect.any(AbortSignal));
    const card = screen.getByTestId("pr-card");
    expect(within(card).getByRole("link", { name: "Add PR tracking" }).getAttribute("href")).toBe("https://github.com/acme/app/pull/42");
    expect(within(card).getByLabelText("PR #42 open: Add PR tracking")).toBeDefined();
    expect(card.textContent).toContain("feat/a → main");
    expect(card.textContent).toContain("by octo");
    expect(card.textContent).toContain("opened 2d ago");
    expect(card.textContent).toContain("updated 2h ago");
  });

  it("shows a PR known only from the chat's history as a bare link, beside the reason GitHub was not asked", async () => {
    const unknown = pr(30, { state: "unknown", title: "acme/app#30", headRef: "", baseRef: "", author: null, createdAt: "" });
    mockPrs.mockResolvedValue(response({ status: "found", pr: pr(42), prError: "gh is not installed" }, [pr(42), unknown]));
    await mount();
    const card = screen.getAllByTestId("pr-card")[1];
    expect(within(card).getByRole("link", { name: "acme/app#30" }).getAttribute("href")).toBe("https://github.com/acme/app/pull/30");
    expect(within(card).getByLabelText("PR #30: acme/app#30").textContent).toBe("#30");
    expect(card.textContent).not.toContain("→");
    expect(card.textContent).not.toContain("updated");
    expect(screen.getByTestId("pr-lookup-warning").textContent).toContain("a GitHub lookup failed: gh is not installed");
  });

  it("says a lookup failed when the live branch has no PR of its own, under the list", async () => {
    const unknown = pr(30, { state: "unknown", title: "acme/app#30", headRef: "", baseRef: "", author: null, createdAt: "" });
    mockPrs.mockResolvedValue(response({ status: "default_branch", branch: "main", prError: "gh is not installed" }, [unknown]));
    await mount();
    expect(screen.getByTestId("pr-status-line").textContent).toContain("This is main, the default branch");
    const warning = screen.getByTestId("pr-lookup-warning");
    // Never claimed for a by-number lookup: nothing was "refreshed", and nothing shown is "stale".
    expect(warning.textContent).toBe("PR data may be incomplete or out of date — a GitHub lookup failed: gh is not installed");
    expect(screen.getByTestId("pr-card").compareDocumentPosition(warning) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says a lookup failed under an empty list too, but not twice when the failure is the status itself", async () => {
    mockPrs.mockResolvedValue(response({ status: "not_git", prError: "gh timed out" }));
    await mount();
    expect(screen.getByTestId("pr-empty").textContent).toContain("not in a git repository");
    expect(screen.getByTestId("pr-lookup-warning").textContent).toContain("gh timed out");
    cleanup();

    mockPrs.mockResolvedValue(response({ status: "error", branch: "feat/a", prError: "gh: API rate limit exceeded" }));
    await mount();
    expect(screen.getByTestId("pr-empty").textContent).toContain("Couldn't look up PRs: gh: API rate limit exceeded");
    expect(screen.queryByTestId("pr-lookup-warning")).toBeNull();
  });

  it("says when it merged rather than when it was updated", async () => {
    mockPrs.mockResolvedValue(
      response({ status: "found", pr: pr(7, { state: "merged", mergedAt: "2026-11-05T12:00:00.000Z", closedAt: "2026-11-05T12:00:00.000Z" }) }),
    );
    await mount();
    const card = screen.getByTestId("pr-card");
    expect(card.textContent).toContain("merged 1d ago");
    expect(card.textContent).not.toContain("updated");
  });

  it("does not link a title whose URL is not github.com", async () => {
    mockPrs.mockResolvedValue(response({ status: "found", pr: pr(9, { url: "javascript:alert(1)", title: "Sneaky" }) }));
    await mount();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Sneaky")).toBeDefined();
  });

  it.each([
    ["not_git", {}, "not in a git repository"],
    ["not_github", { branch: "feat/a" }, "not on GitHub"],
    ["detached", { branch: null }, "detached HEAD"],
    ["default_branch", { branch: "main" }, "This is main, the default branch"],
    ["no_pr", { branch: "feat/a" }, "No PR found for feat/a."],
    ["error", { branch: "feat/a", prError: "gh: API rate limit exceeded" }, "Couldn't look up PRs: gh: API rate limit exceeded"],
  ] as const)("explains %s", async (status, extra, text) => {
    mockPrs.mockResolvedValue(response({ status, ...extra }));
    await mount();
    const empty = screen.getByTestId("pr-empty");
    expect(empty.dataset.status).toBe(status);
    expect(empty.textContent).toContain(text);
    expect(screen.queryByTestId("pr-card")).toBeNull();
  });

  it("renders the one list in the order sent, with no section headings and no source-chat lines", async () => {
    const live = pr(11, { state: "merged", headRef: "feat/b", mergedAt: "2026-11-05T12:00:00.000Z", title: "Live" });
    const earlierOpen = pr(10, { headRef: "feat/a", title: "Earlier open" });
    const fromCard = pr(3, { state: "draft", headRef: "fix/lib", title: "From the card" });
    const earlierClosed = pr(6, { state: "closed", headRef: "feat/gone", closedAt: "2026-11-01T00:00:00.000Z", title: "Earlier closed" });
    mockPrs.mockResolvedValue(response({ status: "found", branch: "feat/b", pr: live }, [earlierOpen, fromCard, live, earlierClosed]));
    await mount();
    const cards = screen.getAllByTestId("pr-card");
    expect(cards.map((c) => within(c).getByRole("link", { name: /^(Live|Earlier open|From the card|Earlier closed)$/ }).textContent)).toEqual([
      "Earlier open",
      "From the card",
      "Live",
      "Earlier closed",
    ]);
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    expect(screen.queryByText(/This chat|Other chats on this card|Untitled chat|and \d+ more/)).toBeNull();
    expect(screen.queryByTestId("pr-status-line")).toBeNull();
    expect(screen.queryByTestId("pr-empty")).toBeNull();
  });

  it("keeps the live branch's status as a compact line above the list when it has no PR of its own", async () => {
    mockPrs.mockResolvedValue(response({ status: "default_branch", branch: "main" }, [pr(10, { title: "From the trail" })]));
    await mount();
    const line = screen.getByTestId("pr-status-line");
    expect(line.dataset.status).toBe("default_branch");
    expect(line.textContent).toContain("This is main, the default branch");
    expect(screen.getAllByTestId("pr-card")).toHaveLength(1);
    expect(line.compareDocumentPosition(screen.getByTestId("pr-card")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId("pr-empty")).toBeNull();
  });

  it("flags a PR shown from a refresh that failed", async () => {
    mockPrs.mockResolvedValue(response({ status: "found", pr: pr(1), prError: "gh timed out" }));
    await mount();
    expect(screen.getByTestId("pr-lookup-warning").textContent).toContain("a GitHub lookup failed: gh timed out");
  });

  it("asks for the folder alone for a new chat", async () => {
    mockPrs.mockResolvedValue(response({ status: "no_pr", branch: "feat/a" }));
    await mount({});
    expect(mockPrs).toHaveBeenCalledWith("/src/app.feat-a", undefined, true, expect.any(AbortSignal));
  });

  it("refetches with refresh=true from the refresh button", async () => {
    mockPrs.mockResolvedValue(response({ status: "no_pr", branch: "feat/a" }));
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh PRs" }));
    });
    expect(mockPrs).toHaveBeenLastCalledWith("/src/app.feat-a", "c1", true, expect.any(AbortSignal));
  });

  it("shows a failed request as an error, not an empty state", async () => {
    mockPrs.mockRejectedValue(new Error("boom"));
    render(<ChatPrsView folder="/src/app.feat-a" chatId="c1" />);
    expect(await screen.findByText("boom")).toBeDefined();
    expect(screen.queryByTestId("pr-empty")).toBeNull();
  });

  it("polls every minute while shown", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    mockPrs.mockResolvedValue(response({ status: "no_pr", branch: "feat/a" }));
    render(<ChatPrsView folder="/src/app.feat-a" chatId="c1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockPrs).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockPrs).toHaveBeenCalledTimes(2);
  });
});

describe("ChatPrsView: refresh on load", () => {
  beforeEach(() => {
    mockPrs.mockResolvedValue(response({ status: "no_pr", branch: "feat/a" }));
  });

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
  const button = () => screen.getByRole("button", { name: "Refresh PRs" }) as HTMLButtonElement;
  const settle = () => act(async () => {});

  it("makes exactly one request on mount, forced, with the button busy until it settles", async () => {
    const first = deferred<Awaited<ReturnType<typeof mockPrs>>>();
    mockPrs.mockReturnValueOnce(first.promise);
    render(<ChatPrsView folder="/src/app.feat-a" chatId="c1" />);
    expect(mockPrs).toHaveBeenCalledTimes(1);
    expect(mockPrs).toHaveBeenCalledWith("/src/app.feat-a", "c1", true, expect.any(AbortSignal));
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    await act(async () => first.resolve(response({ status: "no_pr", branch: "feat/a" })));
    expect(button().disabled).toBe(false);
    expect(button().getAttribute("aria-busy")).toBe("false");
    expect(mockPrs).toHaveBeenCalledTimes(1);
  });

  it("re-enables the button when the forced request fails", async () => {
    const first = deferred<Awaited<ReturnType<typeof mockPrs>>>();
    mockPrs.mockReturnValueOnce(first.promise);
    render(<ChatPrsView folder="/src/app.feat-a" chatId="c1" />);
    expect(button().disabled).toBe(true);
    await act(async () => first.reject(new Error("offline")));
    expect(screen.getByText("offline")).toBeDefined();
    expect(button().disabled).toBe(false);
  });

  it("keeps the button busy through a manual refresh as well", async () => {
    render(<ChatPrsView folder="/src/app.feat-a" chatId="c1" />);
    await settle();
    const manual = deferred<Awaited<ReturnType<typeof mockPrs>>>();
    mockPrs.mockReturnValueOnce(manual.promise);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(mockPrs).toHaveBeenLastCalledWith("/src/app.feat-a", "c1", true, expect.any(AbortSignal));
    expect(button().disabled).toBe(true);
    expect(button().getAttribute("aria-busy")).toBe("true");
    await act(async () => manual.resolve(response({ status: "no_pr", branch: "feat/a" })));
    expect(button().disabled).toBe(false);
  });

  it("polls unforced, and not while a refresh is in flight", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    render(<ChatPrsView folder="/src/app.feat-a" chatId="c1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockPrs).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockPrs).toHaveBeenCalledTimes(2);
    expect(mockPrs).toHaveBeenLastCalledWith("/src/app.feat-a", "c1", false, expect.any(AbortSignal));

    // A manual refresh that hangs: the next poll tick must not fire, nor
    // land and re-enable the button early.
    const manual = deferred<Awaited<ReturnType<typeof mockPrs>>>();
    mockPrs.mockReturnValueOnce(manual.promise);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(mockPrs).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockPrs).toHaveBeenCalledTimes(3);
    expect(button().disabled).toBe(true);
    await act(async () => {
      manual.resolve(response({ status: "no_pr", branch: "feat/a" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(button().disabled).toBe(false);
    vi.useRealTimers();
  });
});

describe("ChatPrsView: a request that never settles", () => {
  /** Like fetch on a dead socket: never answers, but rejects once its signal aborts. */
  const hangUntilAborted = (...args: unknown[]) =>
    new Promise<never>((_resolve, reject) => {
      const signal = args[args.length - 1] as AbortSignal;
      signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const button = () => screen.getByRole("button", { name: "Refresh PRs" }) as HTMLButtonElement;

  it("times out: the button is re-enabled, the timeout is shown as an error, and polls resume", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    try {
      mockPrs.mockImplementationOnce(hangUntilAborted as never);
      mockPrs.mockResolvedValue(response({ status: "no_pr", branch: "feat/a" }));
      render(<ChatPrsView folder="/src/app.feat-a" chatId="c1" />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(button().disabled).toBe(true);
      // Within the timeout no poll starts behind the stuck refresh.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PR_REQUEST_TIMEOUT_MS - 1);
      });
      expect(mockPrs).toHaveBeenCalledTimes(1);
      expect(button().disabled).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(button().disabled).toBe(false);
      expect(button().getAttribute("aria-busy")).toBe("false");
      expect(screen.getByText("Timed out loading PRs — try refreshing.")).toBeDefined();

      // The next poll tick goes out, unforced.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(mockPrs.mock.calls.length).toBeGreaterThan(1);
      expect(mockPrs.mock.calls.at(-1)![2]).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts what is in flight when the view goes away", async () => {
    mockPrs.mockImplementationOnce(hangUntilAborted as never);
    const { unmount } = render(<ChatPrsView folder="/src/app.feat-a" chatId="c1" />);
    const signal = mockPrs.mock.calls[0].at(-1) as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
