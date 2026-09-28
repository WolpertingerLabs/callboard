// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...h };
});

const item = (name: string, mimeType: string, size = 10) => ({ name, mimeType, size, sha256: "abc123", created: "2026-09-01T00:00:00Z", updated: "2026-09-02T00:00:00Z" });

const birds = {
  key: "birds",
  description: "Birds deck",
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
    await waitFor(() => expect(h.updateStorageKey).toHaveBeenCalledWith("birds", "Updated"));
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
