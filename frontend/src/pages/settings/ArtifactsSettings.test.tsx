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
    { version: 1, created: "2026-09-01T00:00:00Z", size: 10, sha256: "a".repeat(64), note: "first cut" },
    { version: 2, created: "2026-09-02T00:00:00Z", size: 12, sha256: "b".repeat(64), note: "flip animation" },
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

/** The preview frame, once the renderer has checked the artifact and mounted it. */
async function frameNow(ok: (f: HTMLIFrameElement) => boolean = () => true): Promise<HTMLIFrameElement> {
  return waitFor(() => {
    const f = document.querySelector("iframe");
    if (!f || !ok(f)) throw new Error("no frame yet");
    return f;
  });
}

/** Say hello as the served shim would (token from the frame's src, a port to answer on) and return the init it gets. */
async function initFor(frame: HTMLIFrameElement): Promise<unknown> {
  const token = /\?bridge=([0-9a-f]{32})&sha256=/.exec(frame.getAttribute("src") ?? "")?.[1];
  const port = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
  const ev = new MessageEvent("message", { data: { __callboard: "artifact-bridge-hello", token }, source: frame.contentWindow });
  Object.defineProperty(ev, "ports", { value: [port] });
  window.dispatchEvent(ev);
  return waitFor(() => {
    const init = port.postMessage.mock.calls[0]?.[0];
    if (!init) throw new Error("no init");
    return init;
  });
}

async function openCramhouse() {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Cramhouse" }));
  await screen.findByText("Details");
}

beforeEach(() => {
  // The write opt-in is remembered in localStorage; each test starts from a browser that never ticked it.
  localStorage.clear();
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
    const frame = await frameNow();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toMatch(/^\/api\/artifacts\/cramhouse\/versions\/2\/render\?bridge=[0-9a-f]{32}&sha256=[0-9a-f]{64}$/);
    fireEvent.click(within(screen.getByTestId("artifact-versions")).getByText("first cut"));
    await waitFor(() => expect(document.querySelector("iframe")?.getAttribute("src")).toMatch(/^\/api\/artifacts\/cramhouse\/versions\/1\/render\?bridge=/));
  });

  it("preview binds read by default and readwrite only after 'allow writes'", async () => {
    await openCramhouse();
    const picker = await screen.findByLabelText("Storage key");
    await within(picker).findByText("birds");
    fireEvent.change(picker, { target: { value: "birds" } });
    expect(screen.getByText(/Read-only preview of "birds"/)).toBeTruthy();

    expect(await initFor(await frameNow((f) => f.contentWindow !== null))).toMatchObject({ storageKey: "birds", access: "read" });

    const readFrame = document.querySelector("iframe");
    fireEvent.click(screen.getByLabelText("Allow writes"));
    expect(screen.getByText(/can change or delete items in "birds"/)).toBeTruthy();
    expect(await initFor(await frameNow((f) => f !== readFrame))).toMatchObject({ storageKey: "birds", access: "readwrite" });
  });

  it("'allow writes' is remembered per (artifact, key) across visits, and unticking revokes with a fresh frame", async () => {
    await openCramhouse();
    const picker = await screen.findByLabelText("Storage key");
    await within(picker).findByText("birds");
    fireEvent.change(picker, { target: { value: "birds" } });
    fireEvent.click(screen.getByLabelText("Allow writes"));
    await waitFor(() => expect(screen.getByTestId("artifact-key-badge").textContent).toBe("birds · rw"));
    cleanup();

    // A later visit: the picker starts unbound (opening the preview binds nothing), but picking the key restores the tick.
    await openCramhouse();
    expect((screen.getByLabelText("Allow writes") as HTMLInputElement).checked).toBe(false);
    fireEvent.change(await screen.findByLabelText("Storage key"), { target: { value: "birds" } });
    expect((screen.getByLabelText("Allow writes") as HTMLInputElement).checked).toBe(true);
    const rwFrame = await frameNow();
    expect(await initFor(rwFrame)).toMatchObject({ storageKey: "birds", access: "readwrite" });

    fireEvent.click(screen.getByLabelText("Allow writes"));
    expect(await initFor(await frameNow((f) => f !== rwFrame))).toMatchObject({ storageKey: "birds", access: "read" });
    expect(localStorage.getItem("claude-code-settings")).not.toMatch(/cramhouse\/birds/);
  });

  it("links to the standalone page with the picked key and no access; pins v only for a non-current version", async () => {
    await openCramhouse();
    fireEvent.change(await screen.findByLabelText("Storage key"), { target: { value: "birds" } });
    fireEvent.click(screen.getByLabelText("Allow writes"));
    const link = (await screen.findByTestId("artifact-standalone-link")) as HTMLAnchorElement;
    await waitFor(() => expect(link.getAttribute("href")).toBe("/a/cramhouse?key=birds"));
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
    fireEvent.click(within(screen.getByTestId("artifact-versions")).getByText("first cut"));
    await waitFor(() => expect(screen.getByTestId("artifact-standalone-link").getAttribute("href")).toBe("/a/cramhouse?key=birds&v=1"));
    expect(screen.getByTestId("artifact-standalone-link").getAttribute("href")).not.toMatch(/access|write|rw/i);
  });

  it("lowering the artifact to storage access none drops the picked key: no badge, no binding", async () => {
    await openCramhouse();
    const picker = await screen.findByLabelText("Storage key");
    await within(picker).findByText("birds");
    fireEvent.change(picker, { target: { value: "birds" } });
    await waitFor(() => expect(screen.getByTestId("artifact-key-badge").textContent).toBe("birds · read"));

    h.updateArtifact.mockResolvedValue({ ...cramhouse, storageAccess: "none" });
    h.getArtifact.mockResolvedValue({ ...cramhouse, storageAccess: "none" });
    fireEvent.change(screen.getByLabelText("Storage access (maximum)"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(screen.queryByLabelText("Storage key")).toBeNull());
    await waitFor(() => expect(screen.queryByTestId("artifact-key-badge")).toBeNull());
    expect(await initFor(await frameNow())).toMatchObject({ storageKey: null, access: "none" });
  });

  it("lowering to none also forgets this browser's remembered write opt-ins for the artifact (every key), not others'", async () => {
    const { saveArtifactWriteGrant, getArtifactWriteGrant } = await import("../../utils/localStorage");
    saveArtifactWriteGrant("cramhouse", "birds", true);
    saveArtifactWriteGrant("cramhouse", "trees", true);
    saveArtifactWriteGrant("other-app", "birds", true);
    await openCramhouse();
    h.updateArtifact.mockResolvedValue({ ...cramhouse, storageAccess: "none" });
    h.getArtifact.mockResolvedValue({ ...cramhouse, storageAccess: "none" });
    fireEvent.change(screen.getByLabelText("Storage access (maximum)"), { target: { value: "none" } });
    fireEvent.click(screen.getByRole("button", { name: "Save details" }));
    await waitFor(() => expect(getArtifactWriteGrant("cramhouse", "birds")).toBe(false));
    expect(getArtifactWriteGrant("cramhouse", "trees")).toBe(false);
    expect(getArtifactWriteGrant("other-app", "birds")).toBe(true);
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
