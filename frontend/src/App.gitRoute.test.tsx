// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { useLocation } from "react-router-dom";

/**
 * The Git tab replaced the Board, and `/board` is still in bookmarks and
 * browser history. It must land on `/git` — replacing the history entry, so
 * Back does not bounce the user straight into the redirect again.
 */

const h = vi.hoisted(() => ({ checkClaudeStatus: vi.fn() }));

vi.mock("./api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...h };
});

vi.mock("./components/SplitLayout", () => ({
  default: function SplitLayoutStub() {
    return <div data-testid="split-layout">{useLocation().pathname}</div>;
  },
}));

import App from "./App";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/check") return new Response(JSON.stringify({ authenticated: true }));
      return new Response("{}");
    }),
  );
  h.checkClaudeStatus.mockResolvedValue({ loggedIn: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("App — the Git route", () => {
  it("renders /git inside the split layout", async () => {
    window.history.replaceState(null, "", "/git");
    render(<App />);
    expect((await screen.findByTestId("split-layout")).textContent).toBe("/git");
  });

  it("redirects the old /board address to /git, replacing the history entry", async () => {
    window.history.replaceState(null, "", "/board");
    const lengthBefore = window.history.length;
    render(<App />);
    expect((await screen.findByTestId("split-layout")).textContent).toBe("/git");
    expect(window.location.pathname).toBe("/git");
    expect(window.history.length).toBe(lengthBefore);
  });
});
