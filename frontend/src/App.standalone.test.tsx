// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";

/**
 * The standalone artifact page inside the whole App: the same login as the
 * rest of the SPA, and signing in lands back on the page it was opened at —
 * the Login screen renders in place, so the URL (id, key, version) never
 * changes. And the app-wide "Claude Code needs credentials" modal stays off
 * it: the page runs no chats, and on a Codex-only install the modal would
 * otherwise cover the artifact in every new tab.
 */

const h = vi.hoisted(() => ({
  checkClaudeStatus: vi.fn(),
  getArtifact: vi.fn(),
  listStorageKeys: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...h };
});

import App from "./App";

let authed = false;

beforeEach(() => {
  authed = false;
  sessionStorage.clear();
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/auth/check") return new Response(JSON.stringify({ authenticated: authed }));
      if (url === "/api/auth/login") {
        authed = true;
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response("{}");
    }),
  );
  h.checkClaudeStatus.mockResolvedValue({ loggedIn: false });
  h.getArtifact.mockResolvedValue({
    id: "cramhouse",
    name: "Cramhouse",
    contentType: "html",
    storageAccess: "readwrite",
    currentVersion: 1,
    created: "c",
    updated: "u",
    versions: [{ version: 1, created: "c", size: 1, sha256: "a".repeat(64) }],
  });
  h.listStorageKeys.mockResolvedValue([{ key: "birds", itemCount: 1, totalSize: 1, updated: "x" }]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.history.replaceState(null, "", "/");
});

describe("App — the standalone artifact page", () => {
  it("logged out shows Login at the same URL, and signing in lands on the page with its key", async () => {
    window.history.replaceState(null, "", "/a/cramhouse?key=birds");
    render(<App />);
    const pw = await waitFor(() => {
      const el = document.querySelector('input[type="password"]');
      if (!el) throw new Error("no login");
      return el as HTMLInputElement;
    });
    expect(window.location.pathname + window.location.search).toBe("/a/cramhouse?key=birds");
    fireEvent.change(pw, { target: { value: "pw" } });
    fireEvent.submit(pw.closest("form")!);
    await screen.findByTestId("artifact-page-bar");
    expect(window.location.pathname + window.location.search).toBe("/a/cramhouse?key=birds");
    await waitFor(() => expect(document.querySelector("iframe")?.getAttribute("src")).toMatch(/^\/api\/artifacts\/cramhouse\/versions\/1\/render\?/));
  });

  it("does not open the Claude credentials modal over the page", async () => {
    authed = true;
    window.history.replaceState(null, "", "/a/cramhouse?key=birds");
    render(<App />);
    await screen.findByTestId("artifact-page-bar");
    await waitFor(() => expect(h.checkClaudeStatus).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/Needs Credentials/i)).toBeNull();
  });
});
