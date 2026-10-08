// @vitest-environment jsdom
/**
 * Where a tab's active space comes from, and the one automatic switch: opening
 * `/chat/:id` for a chat that lives in another space moves the tab there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { getChatSpace, listSpaces } from "../api";
import { SpaceProvider, initialSpaceId, useSpaces } from "./SpaceContext";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  listSpaces: vi.fn(),
  getChatSpace: vi.fn(),
}));
vi.mock("./SessionContext", () => ({ useSessionContext: () => ({ metadataVersion: 0 }) }));

const SPACES = [
  { id: "default", name: "General", order: 0, chatCount: 0, createdAt: "", updatedAt: "" },
  { id: "sp_work", name: "Work", order: 1, chatCount: 0, createdAt: "", updatedAt: "" },
];

const nav: { to: (path: string) => void } = { to: () => {} };
const navigateTo = (path: string) => nav.to(path);
function Probe() {
  const { activeSpaceId, notice } = useSpaces();
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    nav.to = navigate;
  }, [navigate]);
  return (
    <>
      <div data-testid="active">{activeSpaceId}</div>
      <div data-testid="search">{location.search}</div>
      <div data-testid="notice">{notice ?? ""}</div>
    </>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SpaceProvider>
        <Probe />
      </SpaceProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(listSpaces).mockResolvedValue(SPACES);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("initialSpaceId", () => {
  it("prefers the URL, then this tab, then the browser's last space, then General", () => {
    expect(initialSpaceId("")).toBe("default");
    localStorage.setItem("claude-code-settings", JSON.stringify({ lastSpace: "sp_last" }));
    expect(initialSpaceId("")).toBe("sp_last");
    sessionStorage.setItem("callboard-active-space", "sp_tab");
    expect(initialSpaceId("")).toBe("sp_tab");
    expect(initialSpaceId("?space=sp_url")).toBe("sp_url");
    expect(initialSpaceId("?space=../bad")).toBe("sp_tab");
  });
});

describe("SpaceProvider", () => {
  it("follows a ?space= link", async () => {
    renderAt("/?space=sp_work");
    expect(screen.getByTestId("active").textContent).toBe("sp_work");
  });

  it("falls back to General when the stored space no longer exists", async () => {
    sessionStorage.setItem("callboard-active-space", "sp_gone");
    renderAt("/");
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("default"));
  });

  it("switches to a chat's space when the chat is opened, and says so", async () => {
    vi.mocked(getChatSpace).mockResolvedValue("sp_work");
    renderAt("/");
    await waitFor(() => expect(listSpaces).toHaveBeenCalled());
    await act(async () => navigateTo("/chat/abc"));
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("sp_work"));
    expect(screen.getByTestId("search").textContent).toBe("?space=sp_work");
    expect(screen.getByTestId("notice").textContent).toContain("Work");
  });

  it("still switches when the space list lands while the lookup is in flight", async () => {
    // The live bug: the list arriving re-ran the effect, cancelled the answer
    // and — the chat already marked as asked — never asked again.
    let resolveSpaces: (v: typeof SPACES) => void = () => {};
    let resolveChat: (v: string) => void = () => {};
    vi.mocked(listSpaces).mockReturnValue(new Promise((r) => (resolveSpaces = r)));
    vi.mocked(getChatSpace).mockReturnValue(new Promise((r) => (resolveChat = r)));
    renderAt("/chat/abc");
    await act(async () => resolveSpaces(SPACES));
    await act(async () => resolveChat("sp_work"));
    await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("sp_work"));
  });

  it("never switches away from the All view", async () => {
    vi.mocked(getChatSpace).mockResolvedValue("sp_work");
    renderAt("/?space=all");
    await act(async () => navigateTo("/chat/abc?space=all"));
    expect(getChatSpace).not.toHaveBeenCalled();
    expect(screen.getByTestId("active").textContent).toBe("all");
  });
});
