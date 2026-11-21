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

/** A row of the main directory listing (not the Previously used section), by folder name. */
const listedRow = async (name: string) => {
  await waitFor(() => expect(screen.getAllByText(name).some((el) => !el.closest('[data-testid="folder-browser-recent"]'))).toBe(true));
  const label = screen.getAllByText(name).find((el) => !el.closest('[data-testid="folder-browser-recent"]'))!;
  return label.parentElement!.parentElement as HTMLElement;
};

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

  it("highlights the folder being shown once the user goes into it", async () => {
    // As FolderSelector opens it: above the last-used folder.
    renderBrowser({ recentDirectories: RECENT, initialPath: "/home/me/code", focusPath: "/home/me/code/app" });
    const section = await screen.findByTestId("folder-browser-recent");
    await listedRow("lib");
    const appRow = within(section).getByTitle("/home/me/code/app");
    expect(appRow.getAttribute("aria-current")).toBeNull();
    fireEvent.click(appRow);
    await waitFor(() => expect(appRow.getAttribute("aria-current")).toBe("location"));
    expect((appRow.parentElement as HTMLElement).style.background).toBe("var(--accent)");
    expect((within(section).getByTitle("/home/me/code/lib").parentElement as HTMLElement).style.background).not.toBe("var(--accent)");
  });

  it("opened above a folder, marks that folder in the listing and in Previously used", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    renderBrowser({ recentDirectories: RECENT, initialPath: "/home/me/code", focusPath: "/home/me/code/app" });
    const listed = await listedRow("app");
    expect(listed.getAttribute("aria-current")).toBe("true");
    // An outline and a visible tag, not the "selected"-looking accent fill.
    expect(listed.style.border).toBe("1px solid var(--accent)");
    expect(listed.style.background).not.toBe("var(--accent)");
    expect(within(listed).getByTestId("focus-tag").textContent).toBe("last used");
    expect((await listedRow("lib")).getAttribute("aria-current")).toBeNull();
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView.mock.contexts[0]).toBe(listed);
    const section = screen.getByTestId("folder-browser-recent");
    const tags = within(section).getAllByTestId("focus-tag");
    expect(tags).toHaveLength(1);
    expect(tags[0].textContent).toBe("last used");
    expect(within(section).getByTitle("/home/me/code/app").contains(tags[0])).toBe(true);
    // @ts-expect-error -- jsdom has no scrollIntoView; remove the stub again.
    delete Element.prototype.scrollIntoView;
  });

  it("tags the folder 'current' when it came from the caller's field", async () => {
    renderBrowser({ recentDirectories: RECENT, initialPath: "/home/me/code", focusPath: "/home/me/code/lib", focusKind: "current" });
    const listed = await listedRow("lib");
    expect(within(listed).getByTestId("focus-tag").textContent).toBe("current");
    const section = screen.getByTestId("folder-browser-recent");
    expect(within(within(section).getByTitle("/home/me/code/lib")).getByTestId("focus-tag").textContent).toBe("current");
  });

  it("hides the server's own recent suggestions while the section is shown", async () => {
    renderBrowser({ recentDirectories: RECENT });
    expect(await screen.findByText("Home")).toBeTruthy();
    expect(screen.queryByText("old")).toBeNull();
  });

  it("has no remove buttons without a remove handler", async () => {
    renderBrowser({ recentDirectories: RECENT });
    await screen.findByTestId("folder-browser-recent");
    expect(screen.queryByLabelText(/^Remove .* from previously used folders$/)).toBeNull();
  });

  it("removes a folder only once the user confirms", async () => {
    const onRemove = vi.fn();
    const { onSelect } = renderBrowser({ recentDirectories: RECENT, onRemoveRecentDirectory: onRemove });
    fireEvent.click(await screen.findByLabelText("Remove /home/me/code/app from previously used folders"));
    fireEvent.click(within(confirmDialog()).getByRole("button", { name: "Cancel" }));
    expect(onRemove).not.toHaveBeenCalled();
    // The browser is still open behind it.
    expect(screen.getByText("Select Folder", { selector: "h2" })).toBeTruthy();

    const callsBefore = browsed().length;
    fireEvent.click(screen.getByLabelText("Remove /home/me/code/app from previously used folders"));
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

describe("FolderBrowser — start path is read on open only", () => {
  it("ignores a changed initialPath while open (a recent folder removed, a space refresh)", async () => {
    const props = { isOpen: true, onClose: () => {}, onSelect: () => {}, recentDirectories: RECENT };
    const { rerender } = render(<FolderBrowser {...props} initialPath="/home/me/code" focusPath="/home/me/code/app" />);
    fireEvent.click(await screen.findByTitle("/home/me/code/lib"));
    await waitFor(() => expect(browsed()).toContain("/home/me/code/lib"));
    vi.mocked(browseDirectory).mockClear();
    rerender(<FolderBrowser {...props} recentDirectories={["/home/me/code/lib"]} initialPath="/home/me" focusPath="/home/me/code" />);
    await new Promise((r) => setTimeout(r, 20));
    expect(browsed()).toEqual([]);
    expect(screen.getByTitle("/home/me/code/lib").getAttribute("aria-current")).toBe("location");
    // ...but the next open does use it.
    rerender(<FolderBrowser {...props} isOpen={false} initialPath="/home/me" />);
    rerender(<FolderBrowser {...props} initialPath="/home/me" />);
    await waitFor(() => expect(browsed()).toContain("/home/me"));
  });
});

/** A promise resolved from outside, for responses that arrive out of order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("FolderBrowser — browse responses", () => {
  it("ignores a response that arrives after the user has moved on", async () => {
    renderBrowser({ initialPath: "/home/me", recentDirectories: RECENT });
    await screen.findByText("code");
    const slow = deferred<BrowseResult>();
    vi.mocked(browseDirectory).mockImplementation(async (path: string) => (path === "/home/me/code/app" ? slow.promise : listing(path)));
    fireEvent.click(screen.getByTitle("/home/me/code/app"));
    fireEvent.click(screen.getByTitle("/home/me/code/lib"));
    await waitFor(() => expect(screen.getByTitle("/home/me/code/lib").getAttribute("aria-current")).toBe("location"));
    slow.resolve({ ...listing("/home/me/code"), currentPath: "/home/me/code/app" });
    await new Promise((r) => setTimeout(r, 20));
    // Still lib: app's late listing (which would list app & lib) was dropped.
    expect(screen.getByTitle("/home/me/code/lib").getAttribute("aria-current")).toBe("location");
    expect(screen.getByText("This directory is empty")).toBeTruthy();
  });

  it("does not stick on Loading when hidden files are toggled on and back off mid-fetch", async () => {
    renderBrowser({ initialPath: "/home/me" });
    await listedRow("code");
    const pending = deferred<BrowseResult>();
    vi.mocked(browseDirectory).mockImplementation(async (path: string, showHidden?: boolean) => (showHidden ? pending.promise : listing(path)));
    fireEvent.click(screen.getByTitle("Show hidden files"));
    await screen.findByText("Loading...");
    fireEvent.click(screen.getByTitle("Hide hidden files"));
    await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());
    expect(await listedRow("code")).toBeTruthy();
    expect((screen.getByTitle("Refresh directory listing") as HTMLButtonElement).disabled).toBe(false);
    pending.resolve(listing("/home/me"));
  });

  it("does not stick on Loading after navigating away and back mid-fetch", async () => {
    renderBrowser({ initialPath: "/home/me", recentDirectories: RECENT });
    await listedRow("code");
    const pending = deferred<BrowseResult>();
    vi.mocked(browseDirectory).mockImplementation(async (path: string) => (path === "/home/me/code/app" ? pending.promise : listing(path)));
    fireEvent.click(screen.getByTitle("/home/me/code/app"));
    await screen.findByText("Loading...");
    // Back to the folder whose listing is still the one held.
    fireEvent.click(screen.getByRole("button", { name: "me" }));
    await waitFor(() => expect(screen.queryByText("Loading...")).toBeNull());
    expect(await listedRow("code")).toBeTruthy();
    pending.resolve(listing("/home/me/code/app"));
  });

  it("drops a refresh that lands after the user has navigated on", async () => {
    renderBrowser({ initialPath: "/home/me" });
    await listedRow("code");
    const slowRefresh = deferred<BrowseResult>();
    vi.mocked(browseDirectory).mockImplementationOnce(() => slowRefresh.promise);
    fireEvent.click(screen.getByTitle("Refresh directory listing"));
    await waitFor(() => expect(browsed().filter((p) => p === "/home/me").length).toBeGreaterThanOrEqual(2));
    fireEvent.click(await listedRow("code"));
    await listedRow("app");
    slowRefresh.resolve(listing("/home/me"));
    await new Promise((r) => setTimeout(r, 20));
    // Still in /home/me/code: the stale refresh did not put /home/me back.
    expect(await listedRow("app")).toBeTruthy();
    expect(screen.queryAllByText("code").filter((el) => !el.closest("button"))).toHaveLength(0);
  });

  it("fetches the folder it walked up to once, not again for the resolved path", async () => {
    renderBrowser({ initialPath: "/home/me/gone" });
    await screen.findByText("code");
    await new Promise((r) => setTimeout(r, 20));
    expect(browsed().filter((p) => p === "/home/me")).toHaveLength(1);
  });

  it("stops walking up once the user has navigated away", async () => {
    const slow = deferred<BrowseResult>();
    vi.mocked(browseDirectory).mockImplementation(async (path: string) => (path === "/home/me/gone/deeper" ? slow.promise : listing(path)));
    renderBrowser({ initialPath: "/home/me/gone/deeper", recentDirectories: RECENT });
    fireEvent.click(await screen.findByTitle("/home/me/code/lib"));
    await waitFor(() => expect(browsed()).toContain("/home/me/code/lib"));
    slow.resolve(listing("/home/me/gone/deeper"));
    await new Promise((r) => setTimeout(r, 20));
    expect(browsed()).not.toContain("/home/me/gone");
    expect(screen.getByTitle("/home/me/code/lib").getAttribute("aria-current")).toBe("location");
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
