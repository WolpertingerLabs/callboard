// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ArtifactsSettings, { previewAccess } from "./ArtifactsSettings";

/**
 * Settings → Artifacts against a mocked API.
 *
 * Besides the CRUD wiring, the part with teeth is the live preview's grant: it
 * is the same ArtifactRenderer the chat uses, bound to whatever key the picker
 * names, and it must default to *read* — a person looking at an artifact should
 * not mutate a key by looking. Writes need the explicit tick, and never exceed
 * what the artifact declares.
 */

const h = vi.hoisted(() => ({
  listArtifacts: vi.fn(),
  getArtifact: vi.fn(),
  createArtifact: vi.fn(),
  updateArtifact: vi.fn(),
  deleteArtifact: vi.fn(),
  saveArtifactVersion: vi.fn(),
  getArtifactVersionSource: vi.fn(),
  listStorageKeys: vi.fn(),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...h };
});

const cramhouse = {
  id: "cramhouse",
  name: "Cramhouse",
  description: "Flashcards",
  contentType: "html",
  storageAccess: "readwrite",
  currentVersion: 2,
  versions: [
    { version: 1, created: "2026-09-01T00:00:00Z", size: 10, sha256: "a", note: "first cut" },
    { version: 2, created: "2026-09-02T00:00:00Z", size: 12, sha256: "b", note: "flip animation" },
  ],
  updated: "2026-09-02T00:00:00Z",
};

const readme = { ...cramhouse, id: "readme", name: "Readme", contentType: "markdown", storageAccess: "none", currentVersion: 1, versions: [cramhouse.versions[0]] };

function renderPage() {
  return render(
    <MemoryRouter>
      <ArtifactsSettings />
    </MemoryRouter>,
  );
}

async function openCramhouse() {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Cramhouse" }));
  await screen.findByText("Details");
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  h.listArtifacts.mockResolvedValue([cramhouse, readme]);
  h.getArtifact.mockImplementation(async (id: string) => (id === "readme" ? readme : cramhouse));
  h.getArtifactVersionSource.mockImplementation(async (_id: string, v: number) => `<html>source v${v}</html>`);
  h.listStorageKeys.mockResolvedValue([{ key: "birds", itemCount: 1, totalSize: 1, updated: "x" }]);
  h.createArtifact.mockResolvedValue({ ...cramhouse, id: "new-app" });
  h.updateArtifact.mockResolvedValue(cramhouse);
  h.saveArtifactVersion.mockResolvedValue({ ...cramhouse, currentVersion: 3 });
  h.deleteArtifact.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ArtifactsSettings", () => {
  it("lists artifacts with id, type, access and version", async () => {
    renderPage();
    const table = await screen.findByTestId("artifact-list");
    const row = within(table).getByText("cramhouse").closest("tr")!;
    expect(within(row).getByText("html")).toBeTruthy();
    expect(within(row).getByText("Read/write")).toBeTruthy();
    expect(within(row).getByText("v2")).toBeTruthy();
    expect(within(within(table).getByText("readme").closest("tr")!).getByText("No storage")).toBeTruthy();
  });

  it("creates an artifact", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /New artifact/ }));
    fireEvent.change(screen.getByLabelText("Artifact id"), { target: { value: "new-app" } });
    fireEvent.change(screen.getByLabelText("Artifact name"), { target: { value: "New app" } });
    fireEvent.change(screen.getByLabelText("Artifact storage access"), { target: { value: "read" } });
    fireEvent.change(screen.getByLabelText("Artifact source"), { target: { value: "<p>hi</p>" } });
    fireEvent.click(screen.getByRole("button", { name: "Create artifact" }));
    await waitFor(() =>
      expect(h.createArtifact).toHaveBeenCalledWith({
        id: "new-app",
        name: "New app",
        description: undefined,
        contentType: "html",
        storageAccess: "read",
        content: "<p>hi</p>",
      }),
    );
  });

  it("refuses an invalid id before calling the API", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /New artifact/ }));
    fireEvent.change(screen.getByLabelText("Artifact id"), { target: { value: "Bad Id" } });
    fireEvent.change(screen.getByLabelText("Artifact name"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Artifact source"), { target: { value: "x" } });
    expect((screen.getByRole("button", { name: "Create artifact" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("detail shows versions with notes and the current version's source", async () => {
    await openCramhouse();
    const versions = screen.getByTestId("artifact-versions");
    expect(within(versions).getByText("flip animation")).toBeTruthy();
    expect(within(versions).getByText("first cut")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("artifact-source").textContent).toBe("<html>source v2</html>"));
    fireEvent.click(within(versions).getByText("first cut"));
    await waitFor(() => expect(screen.getByTestId("artifact-source").textContent).toBe("<html>source v1</html>"));
  });

  it("previews through ArtifactRenderer, sandboxed, from the render route of the selected version", async () => {
    await openCramhouse();
    const frame = document.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("/api/artifacts/cramhouse/versions/2/render");
    fireEvent.click(within(screen.getByTestId("artifact-versions")).getByText("first cut"));
    await waitFor(() => expect(document.querySelector("iframe")!.getAttribute("src")).toBe("/api/artifacts/cramhouse/versions/1/render"));
  });

  it("preview binds read by default and readwrite only after 'allow writes'", async () => {
    await openCramhouse();
    const picker = await screen.findByLabelText("Storage key");
    await within(picker).findByText("birds");
    fireEvent.change(picker, { target: { value: "birds" } });
    expect(screen.getByText(/Read-only preview of "birds"/)).toBeTruthy();

    let frame = document.querySelector("iframe")!;
    let post = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    expect(post.mock.calls[0][0]).toMatchObject({ storageKey: "birds", access: "read" });

    fireEvent.click(screen.getByLabelText("Allow writes"));
    expect(screen.getByText(/can change or delete items in "birds"/)).toBeTruthy();
    frame = document.querySelector("iframe")!;
    post = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    expect(post.mock.calls[0][0]).toMatchObject({ storageKey: "birds", access: "readwrite" });
  });

  it("no storage picker for an artifact declared storageAccess none", async () => {
    h.getArtifactVersionSource.mockResolvedValue("# Hello");
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Readme" }));
    await screen.findByText("Details");
    expect(screen.queryByLabelText("Storage key")).toBeNull();
    expect(h.listStorageKeys).not.toHaveBeenCalled();
  });

  it("saves metadata edits with PATCH semantics", async () => {
    await openCramhouse();
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Study app" } });
    fireEvent.change(screen.getByLabelText("Storage access (maximum)"), { target: { value: "read" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(h.updateArtifact).toHaveBeenCalledWith("cramhouse", { name: "Cramhouse", description: "Study app", storageAccess: "read" }));
  });

  it("saves a new version with a note", async () => {
    await openCramhouse();
    fireEvent.click(screen.getByRole("button", { name: /New version/ }));
    fireEvent.change(screen.getByLabelText("New version source"), { target: { value: "<p>v3</p>" } });
    fireEvent.change(screen.getByLabelText("Version note"), { target: { value: "third" } });
    fireEvent.click(screen.getByRole("button", { name: "Save version" }));
    await waitFor(() => expect(h.saveArtifactVersion).toHaveBeenCalledWith("cramhouse", "<p>v3</p>", "third"));
  });

  it("deletes only after confirmation", async () => {
    await openCramhouse();
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect(h.deleteArtifact).not.toHaveBeenCalled();
    const dialog = screen.getByText(/and all 2 version\(s\)/).parentElement!;
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.deleteArtifact).toHaveBeenCalledWith("cramhouse"));
    await screen.findByTestId("artifact-list");
  });
});

describe("previewAccess", () => {
  it.each([
    ["readwrite", "birds", false, "read"],
    ["readwrite", "birds", true, "readwrite"],
    ["read", "birds", true, "read"],
    ["none", "birds", true, "none"],
    ["readwrite", "", true, "none"],
  ] as const)("declared %s, key %s, allowWrites %s → %s", (declared, key, allow, expected) => {
    expect(previewAccess(declared, key, allow)).toBe(expected);
  });
});
