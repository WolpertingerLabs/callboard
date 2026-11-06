import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const response = (current: Partial<FolderPrs>, card?: ChatPrsResponse["card"]): ChatPrsResponse => ({
  current: { folder: "/src/app.feat-a", status: "no_pr", ...current },
  ...(card && { card }),
  generatedAt: new Date(NOW - 30_000).toISOString(),
});

const mockPrs = vi.mocked(getChatPrs);

async function mount({ chatId }: { chatId?: string } = { chatId: "c1" }) {
  render(<ChatPrsView folder="/src/app.feat-a" chatId={chatId} />);
  await screen.findByRole("heading", { level: 2, name: "This chat" });
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
  it("shows this chat's PR with its detail, linked to GitHub", async () => {
    mockPrs.mockResolvedValue(response({ status: "found", branch: "feat/a", repoName: "app", pr: pr(42, { title: "Add PR tracking" }) }));
    await mount();
    expect(mockPrs).toHaveBeenCalledWith("/src/app.feat-a", "c1", false);
    const card = within(screen.getByRole("region", { name: "This chat" })).getByTestId("pr-card");
    expect(within(card).getByRole("link", { name: "Add PR tracking" }).getAttribute("href")).toBe("https://github.com/acme/app/pull/42");
    expect(within(card).getByLabelText("PR #42 open: Add PR tracking")).toBeDefined();
    expect(card.textContent).toContain("feat/a → main");
    expect(card.textContent).toContain("by octo");
    expect(card.textContent).toContain("opened 2d ago");
    expect(card.textContent).toContain("updated 2h ago");
    expect(screen.getByText("updated 30s ago")).toBeDefined();
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

  it("flags a PR shown from a refresh that failed", async () => {
    mockPrs.mockResolvedValue(response({ status: "found", pr: pr(1), prError: "gh timed out" }));
    await mount();
    expect(screen.getByText(/Last known PR — refreshing failed: gh timed out/)).toBeDefined();
  });

  it("lists the card's other chats' PRs with the chats they came from", async () => {
    mockPrs.mockResolvedValue(
      response(
        { status: "found", pr: pr(1) },
        {
          cardId: "root",
          title: "PR tracking",
          prs: [
            {
              pr: pr(2, { headRef: "feat/b", title: "Second" }),
              repoName: "app",
              branch: "feat/b",
              sources: [
                { chatId: "c2", title: "Backend work", folder: "/src/app.feat-b" },
                { chatId: "c3", title: null, folder: "/src/app.feat-b/docs" },
              ],
            },
          ],
        },
      ),
    );
    await mount();
    const other = screen.getByRole("region", { name: "Other chats on this card" });
    const card = within(other).getByTestId("pr-card");
    expect(card.textContent).toContain("feat/b → main");
    expect(card.textContent).toContain("· app");
    expect(within(card).getByTitle("/src/app.feat-b").textContent).toBe("Backend work · /src/app.feat-b");
    expect(within(card).getByTitle("/src/app.feat-b/docs").textContent).toBe("Untitled chat · /src/app.feat-b/docs");
  });

  it("lists three source chats and folds the rest behind 'and N more'", async () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({ chatId: `s${i}`, title: `Source ${i}`, folder: `/src/app.feat-b/${i}` }));
    mockPrs.mockResolvedValue(
      response({ status: "no_pr", branch: "feat/a" }, { cardId: "root", title: "t", prs: [{ pr: pr(2), repoName: "app", branch: "feat/b", sources }] }),
    );
    await mount();
    const card = screen.getByTestId("pr-card");
    const shown = () =>
      within(card)
        .queryAllByText(/^Source \d$/)
        .map((el) => el.textContent);
    expect(shown()).toEqual(["Source 0", "Source 1", "Source 2"]);

    fireEvent.click(within(card).getByRole("button", { name: "and 2 more" }));
    expect(shown()).toEqual(["Source 0", "Source 1", "Source 2", "Source 3", "Source 4"]);
    fireEvent.click(within(card).getByRole("button", { name: "show fewer" }));
    expect(shown()).toHaveLength(3);
  });

  it("has no toggle for three sources or fewer", async () => {
    const sources = Array.from({ length: 3 }, (_, i) => ({ chatId: `s${i}`, title: `Source ${i}`, folder: `/f/${i}` }));
    mockPrs.mockResolvedValue(
      response({ status: "no_pr", branch: "feat/a" }, { cardId: "root", title: "t", prs: [{ pr: pr(2), repoName: "app", branch: "feat/b", sources }] }),
    );
    await mount();
    expect(within(screen.getByTestId("pr-card")).queryByRole("button")).toBeNull();
  });

  it("says so when the card's other chats have no PRs", async () => {
    mockPrs.mockResolvedValue(response({ status: "no_pr", branch: "feat/a" }, { cardId: "root", title: "t", prs: [] }));
    await mount();
    expect(screen.getByText("No PRs for the card's other chats.")).toBeDefined();
  });

  it("has no card section without a card, and asks for none for a new chat", async () => {
    mockPrs.mockResolvedValue(response({ status: "no_pr", branch: "feat/a" }));
    await mount({});
    expect(mockPrs).toHaveBeenCalledWith("/src/app.feat-a", undefined, false);
    expect(screen.queryByRole("region", { name: "Other chats on this card" })).toBeNull();
  });

  it("refetches with refresh=true from the refresh button", async () => {
    mockPrs.mockResolvedValue(response({ status: "no_pr", branch: "feat/a" }));
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh PRs" }));
    });
    expect(mockPrs).toHaveBeenLastCalledWith("/src/app.feat-a", "c1", true);
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
