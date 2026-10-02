// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { applyStorageKeyArtifactsDelta } from "shared/types/index.js";
import StorageSettings, { previewKind, TEXT_PREVIEW_BYTES } from "./StorageSettings";

/**
 * Settings → Storage against a mocked API.
 *
 * The page is a browser over the REST routes, so what it can get wrong is
 * which call a click makes and how an item is previewed. The preview choice is
 * the security-relevant one: only raster images may load by URL (the item
 * route serves only those inline); HTML and SVG items must appear as source
 * text, never rendered.
 */

const h = vi.hoisted(() => ({
  listStorageKeys: vi.fn(),
  createStorageKey: vi.fn(),
  getStorageKey: vi.fn(),
  updateStorageKey: vi.fn(),
  deleteStorageKey: vi.fn(),
  fetchStorageItem: vi.fn(),
  putStorageItem: vi.fn(),
  deleteStorageItem: vi.fn(),
  listArtifacts: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...h };
});

const item = (name: string, mimeType: string, size = 10) => ({ name, mimeType, size, sha256: "abc123", created: "2026-09-01T00:00:00Z", updated: "2026-09-02T00:00:00Z" });

const birds = {
  key: "birds",
  description: "Birds deck",
  // One that exists and takes storage, one that takes none, one deleted since.
  artifacts: ["cramhouse", "readme", "gone-app"],
  created: "2026-09-01T00:00:00Z",
  updated: "2026-09-02T00:00:00Z",
  items: [
    item("deck.json", "application/json"),
    item("img-1.png", "image/png"),
    item("README.md", "text/markdown"),
    item("page.html", "text/html"),
    item("blob.bin", "application/octet-stream"),
  ],
};

function renderPage() {
  return render(
    <MemoryRouter>
      <StorageSettings />
    </MemoryRouter>,
  );
}

async function openBirds() {
  renderPage();
  fireEvent.click(await screen.findByText("birds"));
  return screen.findByTestId("storage-item-list");
}

beforeEach(() => {
  h.listStorageKeys.mockResolvedValue([
    { key: "birds", description: "Birds deck", itemCount: 5, totalSize: 2048, updated: "2026-09-02T00:00:00Z" },
    { key: "empty", itemCount: 0, totalSize: 0, updated: "2026-09-02T00:00:00Z" },
  ]);
  h.getStorageKey.mockResolvedValue(birds);
  h.fetchStorageItem.mockImplementation(async (_k: string, name: string) => new Response(name === "README.md" ? "# Heading" : `source of ${name}`));
  h.createStorageKey.mockResolvedValue({ ...birds, key: "new-key", items: [] });
  h.putStorageItem.mockResolvedValue(undefined);
  h.deleteStorageItem.mockResolvedValue(undefined);
  h.deleteStorageKey.mockResolvedValue(undefined);
  h.updateStorageKey.mockResolvedValue(birds);
  const summary = (id: string, name: string, storageAccess: string) => ({ id, name, contentType: "html", storageAccess, currentVersion: 1, created: "c", updated: "u" });
  h.listArtifacts.mockResolvedValue([summary("cramhouse", "Cramhouse", "readwrite"), summary("flag-deck", "Flag deck", "read"), summary("readme", "Readme", "none")]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StorageSettings", () => {
  it("lists keys with item count and size", async () => {
    renderPage();
    const list = await screen.findByTestId("storage-key-list");
    expect(within(list).getByText("birds")).toBeTruthy();
    expect(within(list).getByText(/5 items · 2\.0 KB · Birds deck/)).toBeTruthy();
    expect(within(list).getByText(/0 items · 0 B/)).toBeTruthy();
  });

  it("creates a key, validating the name first", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /New key/ }));
    const create = screen.getByRole("button", { name: "Create key" }) as HTMLButtonElement;
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "Bad/Key" } });
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "new-key" } });
    fireEvent.change(screen.getByLabelText("Key description"), { target: { value: "A new one" } });
    expect(create.disabled).toBe(false);
    fireEvent.click(create);
    await waitFor(() => expect(h.createStorageKey).toHaveBeenCalledWith("new-key", "A new one"));
  });

  it("shows a selected key's items", async () => {
    const list = await openBirds();
    expect(h.getStorageKey).toHaveBeenCalledWith("birds");
    for (const name of ["deck.json", "img-1.png", "README.md", "page.html", "blob.bin"]) expect(within(list).getByText(name)).toBeTruthy();
  });

  it("previews text/JSON in a monospace pre", async () => {
    fireEvent.click(within(await openBirds()).getByText("deck.json"));
    const preview = await screen.findByTestId("storage-preview");
    await waitFor(() => expect(preview.querySelector("pre")?.textContent).toBe("source of deck.json"));
  });

  it("previews html as source text, never rendered", async () => {
    fireEvent.click(within(await openBirds()).getByText("page.html"));
    const preview = await screen.findByTestId("storage-preview");
    await waitFor(() => expect(preview.querySelector("pre")?.textContent).toBe("source of page.html"));
    expect(preview.querySelector("iframe")).toBeNull();
  });

  it("previews images with <img> from the item route", async () => {
    fireEvent.click(within(await openBirds()).getByText("img-1.png"));
    const preview = await screen.findByTestId("storage-preview");
    expect(preview.querySelector("img")?.getAttribute("src")).toBe("/api/storage/birds/items/img-1.png");
    expect(h.fetchStorageItem).not.toHaveBeenCalled();
  });

  it("previews markdown through MarkdownRenderer", async () => {
    fireEvent.click(within(await openBirds()).getByText("README.md"));
    expect(await screen.findByRole("heading", { name: "Heading" })).toBeTruthy();
  });

  it("shows metadata and a download link for binary items", async () => {
    fireEvent.click(within(await openBirds()).getByText("blob.bin"));
    const preview = await screen.findByTestId("storage-preview");
    expect(within(preview).getByText(/No preview for application\/octet-stream/)).toBeTruthy();
    const link = within(preview).getByText("Download blob.bin") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/storage/birds/items/blob.bin");
    expect(h.fetchStorageItem).not.toHaveBeenCalled();
  });

  it("truncates text previews to the first 256 KB", async () => {
    h.fetchStorageItem.mockResolvedValue(new Response("x".repeat(TEXT_PREVIEW_BYTES + 100)));
    fireEvent.click(within(await openBirds()).getByText("deck.json"));
    const preview = await screen.findByTestId("storage-preview");
    await waitFor(() => expect(preview.querySelector("pre")?.textContent?.length).toBe(TEXT_PREVIEW_BYTES));
    expect(within(preview).getByText(/Showing the first 256\.0 KB/)).toBeTruthy();
  });

  it("creates a text item", async () => {
    await openBirds();
    fireEvent.click(screen.getByRole("button", { name: /New text item/ }));
    fireEvent.change(screen.getByLabelText("Item name"), { target: { value: "notes.txt" } });
    fireEvent.change(screen.getByLabelText("Item content"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Save item" }));
    await waitFor(() => expect(h.putStorageItem).toHaveBeenCalledWith("birds", "notes.txt", { content: "hello", mimeType: undefined }));
  });

  it("uploads multiple files as multipart, refusing invalid names", async () => {
    await openBirds();
    const input = screen.getByLabelText("Upload files") as HTMLInputElement;
    const a = new File(["a"], "a.png", { type: "image/png" });
    const b = new File(["b"], "b.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [a, b] } });
    await waitFor(() => expect(h.putStorageItem).toHaveBeenCalledTimes(2));
    expect(h.putStorageItem).toHaveBeenCalledWith("birds", "a.png", { file: a });
    expect(h.putStorageItem).toHaveBeenCalledWith("birds", "b.txt", { file: b });

    h.putStorageItem.mockClear();
    fireEvent.change(input, { target: { files: [new File(["x"], ".env")] } });
    expect(await screen.findByText(/Invalid item name: \.env/)).toBeTruthy();
    expect(h.putStorageItem).not.toHaveBeenCalled();
  });

  it("a partial upload failure names the file, reports what was saved, and still refreshes the list", async () => {
    await openBirds();
    const input = screen.getByLabelText("Upload files") as HTMLInputElement;
    const clear = vi.spyOn(input, "value", "set");
    h.putStorageItem.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Item too large"));
    const refreshesBefore = h.getStorageKey.mock.calls.length;
    fireEvent.change(input, { target: { files: [new File(["a"], "a.png"), new File(["b"], "b.txt"), new File(["c"], "c.txt")] } });
    expect(await screen.findByText('Uploading "b.txt" failed: Item too large (already saved: a.png)')).toBeTruthy();
    expect(h.putStorageItem).toHaveBeenCalledTimes(2); // c.txt is not attempted
    expect(h.getStorageKey.mock.calls.length).toBeGreaterThan(refreshesBefore);
    expect(clear).toHaveBeenCalledWith("");
  });

  it("only the latest key's detail lands: a slow response for a key no longer selected is dropped", async () => {
    let releaseBirds!: (v: typeof birds) => void;
    h.getStorageKey.mockImplementation((key: string) =>
      key === "birds" ? new Promise((r) => (releaseBirds = r)) : Promise.resolve({ ...birds, key: "empty", description: undefined, items: [item("other.txt", "text/plain")] }),
    );
    renderPage();
    fireEvent.click(await screen.findByText("birds"));
    fireEvent.click(screen.getByText("empty"));
    const list = await screen.findByTestId("storage-item-list");
    expect(within(list).getByText("other.txt")).toBeTruthy();
    releaseBirds(birds);
    await new Promise((r) => setTimeout(r, 20));
    expect(within(screen.getByTestId("storage-item-list")).queryByText("deck.json")).toBeNull();
    expect(within(screen.getByTestId("storage-item-list")).getByText("other.txt")).toBeTruthy();
  });

  it("deletes an item only after confirmation", async () => {
    await openBirds();
    fireEvent.click(screen.getByTitle("Delete item deck.json"));
    expect(h.deleteStorageItem).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete "deck\.json" from "birds"\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.deleteStorageItem).toHaveBeenCalledWith("birds", "deck.json"));
  });

  it("deletes a key only after confirmation, and cancel does nothing", async () => {
    renderPage();
    fireEvent.click(await screen.findByTitle("Delete key birds"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(h.deleteStorageKey).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle("Delete key birds"));
    expect(screen.getByText(/every item in it/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.deleteStorageKey).toHaveBeenCalledWith("birds"));
  });

  it("edits a key's description", async () => {
    await openBirds();
    fireEvent.click(screen.getByTitle("Edit description"));
    fireEvent.change(screen.getByLabelText("Edit key description"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(h.updateStorageKey).toHaveBeenCalledWith("birds", { description: "Updated" }));
  });

  it("surfaces API errors", async () => {
    h.listStorageKeys.mockRejectedValue(new Error("Storage offline"));
    renderPage();
    expect(await screen.findByText("Storage offline")).toBeTruthy();
  });
});

describe("previewKind", () => {
  it.each([
    ["a.png", "image/png", "image"],
    ["a.webp", "image/webp", "image"],
    ["a.svg", "image/svg+xml", "text"],
    ["a.html", "text/html", "text"],
    ["a.json", "application/json; charset=utf-8", "text"],
    ["a.md", "text/markdown", "markdown"],
    ["notes.md", "application/octet-stream", "markdown"],
    ["a.bmp", "image/bmp", "binary"],
    ["a.zip", "application/zip", "binary"],
  ])("%s (%s) → %s", (name, mimeType, kind) => {
    expect(previewKind({ name, mimeType })).toBe(kind);
  });
});

describe("StorageSettings — Designed for", () => {
  it("shows each listed artifact: existing ones by name with an 'Open with' link to the standalone page, deleted ones as missing", async () => {
    await openBirds();
    const cram = await screen.findByTestId("designed-for-cramhouse");
    const link = within(cram).getByRole("link", { name: /Open with Cramhouse/ });
    expect(link.getAttribute("href")).toBe("/a/cramhouse?key=birds");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toMatch(/\bnoopener\b/);
    expect(link.getAttribute("href")).not.toMatch(/access|write/i);
    // An artifact that takes no storage cannot be opened with a key.
    const readme = screen.getByTestId("designed-for-readme");
    expect(within(readme).queryByRole("link")).toBeNull();
    expect(readme.textContent).toMatch(/takes no storage/);
    const gone = screen.getByTestId("designed-for-gone-app");
    expect(gone.textContent).toMatch(/missing/);
    expect(within(gone).queryByRole("link")).toBeNull();
  });

  it("a key with no list says it binds nothing", async () => {
    h.getStorageKey.mockResolvedValue({ ...birds, artifacts: [] });
    await openBirds();
    expect((await screen.findByTestId("designed-for")).textContent).toMatch(/No artifact — none can be bound to this key/);
  });

  it("the list shows in the key list too", async () => {
    h.listStorageKeys.mockResolvedValue([{ key: "birds", artifacts: ["cramhouse"], itemCount: 5, totalSize: 2048, updated: "x" }]);
    renderPage();
    expect((await screen.findByTestId("storage-key-list")).textContent).toMatch(/for cramhouse/);
  });

  it("edits the list: pick from existing artifacts, untick a missing one; saving sends only that delta and adopts the list the server returns", async () => {
    await openBirds();
    await screen.findByTestId("designed-for-cramhouse");
    h.updateStorageKey.mockResolvedValue({ ...birds, artifacts: ["cramhouse", "readme", "flag-deck", "from-elsewhere"] });
    fireEvent.click(screen.getByTitle("Edit which artifacts this key is for"));
    const editor = screen.getByTestId("designed-for-editor");
    // Every existing artifact, plus the listed id that no longer exists (so it can be removed).
    expect(within(editor).getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual([
      "Designed for cramhouse",
      "Designed for flag-deck",
      "Designed for readme",
      "Designed for gone-app",
    ]);
    expect(within(editor).getByText("missing")).toBeTruthy();
    fireEvent.click(within(editor).getByLabelText("Designed for gone-app"));
    fireEvent.click(within(editor).getByLabelText("Designed for flag-deck"));
    // Ticked then unticked again: back to what the list says, so not part of the delta.
    fireEvent.click(within(editor).getByLabelText("Designed for readme"));
    fireEvent.click(within(editor).getByLabelText("Designed for readme"));
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(h.updateStorageKey).toHaveBeenCalledWith("birds", { addArtifacts: ["flag-deck"], removeArtifacts: ["gone-app"] }));
    expect(h.updateStorageKey.mock.calls[0][1]).not.toHaveProperty("artifacts");
    // The server's post-write list is what shows — including a change this tab never made.
    expect(await screen.findByTestId("designed-for-from-elsewhere")).toBeTruthy();
    expect(screen.queryByTestId("designed-for-gone-app")).toBeNull();
  });

  it("Save with nothing toggled sends nothing", async () => {
    await openBirds();
    await screen.findByTestId("designed-for-cramhouse");
    fireEvent.click(screen.getByTitle("Edit which artifacts this key is for"));
    fireEvent.click(within(screen.getByTestId("designed-for-editor")).getByRole("button", { name: "Save" }));
    expect(screen.queryByTestId("designed-for-editor")).toBeNull();
    expect(h.updateStorageKey).not.toHaveBeenCalled();
  });

  /**
   * The review's reproduction (PR #462): a tab opens the editor; meanwhile
   * another client narrows the list; the tab then ticks one artifact and
   * saves. Against a fake server that applies PATCHes to its stored list the
   * way the real one does, the result must be the other client's list plus
   * the tick — nothing the other client removed may come back.
   */
  it("a stale tab's save cannot re-add what another client removed while its editor was open", async () => {
    let stored = ["cramhouse", "readme", "gone-app"];
    h.getStorageKey.mockImplementation(async () => ({ ...birds, artifacts: [...stored] }));
    h.updateStorageKey.mockImplementation(async (_key: string, patch: { artifacts?: string[]; addArtifacts?: string[]; removeArtifacts?: string[] }) => {
      if (patch.artifacts) stored = [...patch.artifacts];
      else {
        const applied = applyStorageKeyArtifactsDelta(stored, patch.addArtifacts ?? [], patch.removeArtifacts ?? []);
        if (!applied.ok) throw new Error(applied.reason);
        stored = applied.artifacts;
      }
      return { ...birds, artifacts: [...stored] };
    });
    await openBirds();
    await screen.findByTestId("designed-for-cramhouse");
    fireEvent.click(screen.getByTitle("Edit which artifacts this key is for"));
    const editor = screen.getByTestId("designed-for-editor");
    await waitFor(() => expect(h.getStorageKey).toHaveBeenCalledTimes(2)); // the editor re-read the key on opening
    stored = ["cramhouse"]; // another tab or an agent, after this editor opened
    fireEvent.click(within(editor).getByLabelText("Designed for flag-deck"));
    fireEvent.click(within(editor).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(h.updateStorageKey).toHaveBeenCalledTimes(1));
    expect(stored).toEqual(["cramhouse", "flag-deck"]);
    // And the tab shows the server's list, not its own old copy.
    expect(await screen.findByTestId("designed-for-flag-deck")).toBeTruthy();
    expect(screen.queryByTestId("designed-for-readme")).toBeNull();
  });

  it("opening the editor re-reads the key: untouched rows follow the fresh list", async () => {
    await openBirds();
    await screen.findByTestId("designed-for-cramhouse");
    h.getStorageKey.mockResolvedValue({ ...birds, artifacts: ["flag-deck"] });
    fireEvent.click(screen.getByTitle("Edit which artifacts this key is for"));
    const editor = screen.getByTestId("designed-for-editor");
    await waitFor(() => expect((within(editor).getByLabelText("Designed for flag-deck") as HTMLInputElement).checked).toBe(true));
    expect((within(editor).getByLabelText("Designed for cramhouse") as HTMLInputElement).checked).toBe(false);
  });

  it("re-reads the selected key when the tab becomes visible again", async () => {
    await openBirds();
    await screen.findByTestId("designed-for-cramhouse");
    expect(h.getStorageKey).toHaveBeenCalledTimes(1);
    h.getStorageKey.mockResolvedValue({ ...birds, artifacts: ["flag-deck"] });
    const visibility = vi.spyOn(document, "visibilityState", "get");
    try {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(h.getStorageKey).toHaveBeenCalledTimes(1);
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
      expect(await screen.findByTestId("designed-for-flag-deck")).toBeTruthy();
      expect(screen.queryByTestId("designed-for-cramhouse")).toBeNull();
    } finally {
      visibility.mockRestore();
    }
  });

  it("the editor calls nothing missing while the artifact list is loading, or if it failed to load", async () => {
    h.listArtifacts.mockReturnValue(new Promise(() => {}));
    await openBirds();
    await screen.findByTestId("designed-for-cramhouse");
    fireEvent.click(screen.getByTitle("Edit which artifacts this key is for"));
    let editor = screen.getByTestId("designed-for-editor");
    expect(within(editor).queryByText("missing")).toBeNull();
    expect(within(editor).getByTestId("designed-for-artifacts-unknown").textContent).toMatch(/Loading artifacts/);
    // The listed ids are still there to untick.
    expect(within(editor).getAllByRole("checkbox").map((c) => c.getAttribute("aria-label"))).toEqual([
      "Designed for cramhouse",
      "Designed for readme",
      "Designed for gone-app",
    ]);
    cleanup();

    h.listArtifacts.mockRejectedValue(new Error("artifacts unavailable"));
    await openBirds();
    await screen.findByTestId("designed-for-cramhouse");
    fireEvent.click(screen.getByTitle("Edit which artifacts this key is for"));
    editor = screen.getByTestId("designed-for-editor");
    expect(within(editor).queryByText("missing")).toBeNull();
    expect(within(editor).getByTestId("designed-for-artifacts-unknown").textContent).toMatch(/Couldn't load the artifact list/);
  });

  it("cancel leaves the list alone; a failed save shows the server's error", async () => {
    await openBirds();
    await screen.findByTestId("designed-for-cramhouse");
    fireEvent.click(screen.getByTitle("Edit which artifacts this key is for"));
    fireEvent.click(within(screen.getByTestId("designed-for-editor")).getByRole("button", { name: "Cancel" }));
    expect(h.updateStorageKey).not.toHaveBeenCalled();
    h.updateStorageKey.mockRejectedValue(new Error("too many artifacts (max 32 per key)"));
    fireEvent.click(screen.getByTitle("Edit which artifacts this key is for"));
    fireEvent.click(within(screen.getByTestId("designed-for-editor")).getByLabelText("Designed for flag-deck"));
    fireEvent.click(within(screen.getByTestId("designed-for-editor")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("too many artifacts (max 32 per key)")).toBeTruthy();
  });
});

