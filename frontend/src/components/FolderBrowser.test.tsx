// @vitest-environment jsdom
/**
 * The folder browser's "Previously used" section and where it opens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { BrowseResult, FolderSuggestion } from "shared/types/folders.js";
import { browseDirectory, getFolderSuggestions } from "../api";
import FolderBrowser from "./FolderBrowser";

let mobile = false;
vi.mock("../hooks/useIsMobile", () => ({ useIsMobile: () => mobile }));

vi.mock("../api", () => ({
  browseDirectory: vi.fn(),
  getFolderSuggestions: vi.fn(),
  clearFolderCache: vi.fn(async () => {}),
}));

const EXISTING = new Set(["/", "/home", "/home/me", "/home/me/code", "/home/me/code/app", "/home/me/code/lib"]);
const listing = (path: string): BrowseResult => ({
  directories: [...EXISTING]
    .filter((p) => p !== path && p.startsWith(path === "/" ? "/" : path + "/") && !p.slice(path.length + 1).includes("/"))
    .map((p) => ({ name: p.split("/").pop()!, path: p, type: "directory" as const, isHidden: false })),
  files: [],
  parent: path === "/" ? null : path.slice(0, path.lastIndexOf("/")) || "/",
  exists: EXISTING.has(path),
  currentPath: path,
});

const SUGGESTIONS: FolderSuggestion[] = [
  { path: "/home/me", name: "Home", description: "Home", type: "user" },
  { path: "/home/me/old", name: "old", description: "Recently used", type: "recent" },
];

const browsed = () => vi.mocked(browseDirectory).mock.calls.map((c) => c[0]);

beforeEach(() => {
  mobile = false;
  localStorage.clear();
  vi.mocked(browseDirectory).mockImplementation(async (path: string) => listing(path));
  vi.mocked(getFolderSuggestions).mockResolvedValue({ suggestions: SUGGESTIONS } as never);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderBrowser(props: Partial<React.ComponentProps<typeof FolderBrowser>> = {}) {
  const onSelect = vi.fn();
  const utils = render(<FolderBrowser isOpen onClose={() => {}} onSelect={onSelect} initialPath="/home/me/code" {...props} />);
  return { onSelect, ...utils };
}

/** The "remove?" dialog — its own overlay, nested inside the browser's. */
const confirmDialog = () => screen.getByText("Remove Recent Directory").closest("[data-modal-overlay]") as HTMLElement;

const RECENT = ["/home/me/code/app", "/home/me/code/lib"];

describe("FolderBrowser — Previously used", () => {
  it("shows no section, and the server's recent suggestions, without the prop", async () => {
    renderBrowser();
    expect(await screen.findByText("old")).toBeTruthy();
    expect(screen.queryByText("Previously used")).toBeNull();
    expect(screen.queryByTestId("folder-browser-recent")).toBeNull();
  });

  it("lists each folder; click navigates, double-click selects", async () => {
    const { onSelect } = renderBrowser({ recentDirectories: RECENT, initialPath: "/" });
    const section = await screen.findByTestId("folder-browser-recent");
    expect(within(section).getByText("Previously used")).toBeTruthy();
    const row = within(section).getByTitle("/home/me/code/lib");
    fireEvent.click(row);
    await waitFor(() => expect(browsed()).toContain("/home/me/code/lib"));
    fireEvent.doubleClick(row);
    expect(onSelect).toHaveBeenCalledWith("/home/me/code/lib");
  });

  it("highlights the folder being shown", async () => {
    renderBrowser({ recentDirectories: RECENT, initialPath: "/home/me/code/app" });
    const section = await screen.findByTestId("folder-browser-recent");
    await waitFor(() => expect((within(section).getByTitle("/home/me/code/app").parentElement as HTMLElement).style.background).toBe("var(--accent)"));
    expect((within(section).getByTitle("/home/me/code/lib").parentElement as HTMLElement).style.background).not.toBe("var(--accent)");
  });

  it("hides the server's own recent suggestions while the section is shown", async () => {
    renderBrowser({ recentDirectories: RECENT });
    expect(await screen.findByText("Home")).toBeTruthy();
    expect(screen.queryByText("old")).toBeNull();
  });

  it("has no remove buttons without a remove handler", async () => {
    renderBrowser({ recentDirectories: RECENT });
    await screen.findByTestId("folder-browser-recent");
    expect(screen.queryByLabelText(/^Remove .* from recent directories$/)).toBeNull();
  });

  it("removes a folder only once the user confirms", async () => {
    const onRemove = vi.fn();
    const { onSelect } = renderBrowser({ recentDirectories: RECENT, onRemoveRecentDirectory: onRemove });
    fireEvent.click(await screen.findByLabelText("Remove /home/me/code/app from recent directories"));
    fireEvent.click(within(confirmDialog()).getByRole("button", { name: "Cancel" }));
    expect(onRemove).not.toHaveBeenCalled();
    // The browser is still open behind it.
    expect(screen.getByText("Select Folder", { selector: "h2" })).toBeTruthy();

    const callsBefore = browsed().length;
    fireEvent.click(screen.getByLabelText("Remove /home/me/code/app from recent directories"));
    fireEvent.click(within(confirmDialog()).getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledWith("/home/me/code/app");
    expect(screen.queryByText("Remove Recent Directory")).toBeNull();
    // The X neither navigated nor selected.
    expect(browsed().length).toBe(callsBefore);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("on mobile, heads the list as a collapsible block, open by default", async () => {
    mobile = true;
    renderBrowser({ recentDirectories: RECENT });
    const toggle = await screen.findByRole("button", { name: /Previously used \(2\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTitle("/home/me/code/app")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTitle("/home/me/code/app")).toBeNull();
  });
});

describe("FolderBrowser — opening at a folder that is gone", () => {
  it("walks up to the nearest folder that exists on the first browse", async () => {
    renderBrowser({ initialPath: "/home/me/gone/deeper" });
    await waitFor(() => expect(screen.getByText("code")).toBeTruthy());
    expect(browsed()).toEqual(expect.arrayContaining(["/home/me/gone/deeper", "/home/me/gone", "/home/me"]));
    expect((screen.getByRole("button", { name: "Select Folder" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("does not walk up when the user later navigates to a missing folder", async () => {
    renderBrowser({ initialPath: "/home/me", recentDirectories: ["/home/me/deleted"] });
    await screen.findByText("code");
    vi.mocked(browseDirectory).mockClear();
    fireEvent.click(screen.getByTitle("/home/me/deleted"));
    await waitFor(() => expect(browsed()).toEqual(["/home/me/deleted"]));
    await waitFor(() => expect((screen.getByRole("button", { name: "Select Folder" }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("falls back to the root once if the first browse throws", async () => {
    vi.mocked(browseDirectory).mockImplementation(async (path: string) => {
      if (path !== "/") throw new Error("boom");
      return listing(path);
    });
    renderBrowser({ initialPath: "/home/me/code" });
    await waitFor(() => expect(screen.getByText("home")).toBeTruthy());
    expect(screen.queryByText("boom")).toBeNull();
  });
});
