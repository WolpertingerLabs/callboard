// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";

/**
 * Logging out does not reload the page, so what the Git page and the PRs tab
 * remember for the tab has to be forgotten by hand: the next login in the same
 * tab must start from the daemon's answer, not from what the last one saw.
 */

const h = vi.hoisted(() => ({ checkClaudeStatus: vi.fn(), listCards: vi.fn(), getGitOverview: vi.fn() }));

vi.mock("./api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...h };
});

vi.mock("./components/SplitLayout", () => ({
  default: function SplitLayoutStub({ onLogout }: { onLogout: () => void }) {
    return (
      <button data-testid="logout" onClick={onLogout}>
        log out
      </button>
    );
  },
}));

vi.mock("./contexts/SessionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./contexts/SessionContext")>()),
  useMetadataVersion: () => 0,
}));

import { MemoryRouter } from "react-router-dom";
import type { CardSummary, GitOverviewResponse } from "./api";
import App from "./App";
import Git from "./pages/Git";
import { useGitRequest } from "./components/git/useGitRequest";

const CARD = { id: "c1", title: "PR tracking", lifecycle: "open", rollup: "idle", memberChats: [], memberRuns: [] } as unknown as CardSummary;
const OVERVIEW: GitOverviewResponse = {
  generatedAt: "2026-11-06T12:00:00.000Z",
  repos: [{ repoPath: "/src/app", name: "app", rows: [{ cwd: "/src/app", branch: "main", isMain: true, cardIds: ["c1"] }] }],
};

const gitPage = () =>
  render(
    <MemoryRouter>
      <Git />
    </MemoryRouter>,
  );
const prsMemory = () =>
  renderHook(() =>
    useGitRequest<{ v: string }>({ cacheKey: "prs\0/src/app\0c1", fetch: () => new Promise(() => {}), timeoutMessage: "timed out", failureMessage: "failed" }),
  );

let logoutFails = false;

beforeEach(() => {
  logoutFails = false;
  sessionStorage.clear();
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/check") return new Response(JSON.stringify({ authenticated: true }));
      if (url === "/api/auth/logout" && logoutFails) throw new Error("offline");
      return new Response("{}");
    }),
  );
  h.checkClaudeStatus.mockResolvedValue({ loggedIn: true });
  h.listCards.mockResolvedValue({ cards: [CARD] });
  h.getGitOverview.mockResolvedValue(OVERVIEW);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/** Visit the Git page and a PRs answer so the tab remembers both, then leave them. */
async function rememberSomething() {
  const page = gitPage();
  await screen.findByRole("button", { name: "PR tracking" });
  page.unmount();
  const answered = renderHook(() =>
    useGitRequest<{ v: string }>({ cacheKey: "prs\0/src/app\0c1", fetch: async () => ({ v: "a PR" }), timeoutMessage: "timed out", failureMessage: "failed" }),
  );
  await act(async () => {});
  answered.unmount();

  // Both are remembered: a return visit paints before anything answers.
  h.listCards.mockReturnValue(new Promise(() => {}));
  h.getGitOverview.mockReturnValue(new Promise(() => {}));
  const again = gitPage();
  expect(screen.getByRole("button", { name: "PR tracking" })).toBeDefined();
  again.unmount();
  const prs = prsMemory();
  expect(prs.result.current.data).toEqual({ v: "a PR" });
  prs.unmount();
}

async function logOut() {
  const app = render(<App />);
  fireEvent.click(await screen.findByTestId("logout"));
  await act(async () => {});
  expect(screen.queryByTestId("logout")).toBeNull();
  app.unmount();
}

function expectForgotten() {
  gitPage();
  expect(screen.queryByRole("button", { name: "PR tracking" })).toBeNull();
  expect(screen.queryAllByTestId("branch-row")).toHaveLength(0);
  expect(screen.getByText("Loading branches…")).toBeDefined();
  expect(prsMemory().result.current.data).toBeNull();
}

describe("App — logout forgets what the git views remembered", () => {
  it("forgets the overview, the cards and the PR answers", async () => {
    await rememberSomething();
    await logOut();
    expectForgotten();
  });

  it("forgets them when the logout request itself fails, too", async () => {
    await rememberSomething();
    logoutFails = true;
    await logOut();
    expectForgotten();
  });
});
