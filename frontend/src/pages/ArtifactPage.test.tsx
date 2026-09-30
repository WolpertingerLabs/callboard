// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import ArtifactPage from "./ArtifactPage";
import { ARTIFACT_STANDALONE_ROUTE } from "../components/artifactStandalone";
import { getArtifactWriteGrant, saveArtifactWriteGrant } from "../utils/localStorage";
import type { Artifact } from "../api";

/**
 * The standalone page `/a/<id>?key=<key>&v=<n>` against a mocked API.
 *
 * The part with teeth is the grant. The URL says what to show and never what
 * it may do: no parameter can reach write. Write is only ever the user's
 * remembered "Allow saving" for this (artifact, key) in this browser, and even
 * then no more than the artifact declares *now* — as the renderer's own check
 * sees it, not as the page loaded it.
 */

const h = vi.hoisted(() => ({ getArtifact: vi.fn(), listStorageKeys: vi.fn(), getArtifactVersionSource: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, ...h };
});

const SHA1 = "1".repeat(64);
const SHA2 = "2".repeat(64);

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "cramhouse",
    name: "Cramhouse",
    contentType: "html",
    storageAccess: "readwrite",
    currentVersion: 2,
    created: "c",
    updated: "u",
    versions: [
      { version: 1, created: "c", size: 10, sha256: SHA1 },
      { version: 2, created: "c", size: 12, sha256: SHA2 },
    ],
    ...over,
  };
}

function LocationSpy() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

function visit(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path={ARTIFACT_STANDALONE_ROUTE}
          element={
            <>
              <ArtifactPage />
              <LocationSpy />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

async function frameNow(ok: (f: HTMLIFrameElement) => boolean = () => true): Promise<HTMLIFrameElement> {
  return waitFor(() => {
    const f = document.querySelector("iframe");
    if (!f || !ok(f)) throw new Error("no frame yet");
    return f;
  });
}

/** Say hello as the served shim would, and return the init — the grant the frame actually got. */
async function initFor(frame: HTMLIFrameElement): Promise<{ storageKey: string | null; access: string }> {
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

async function grantOf(url: string) {
  visit(url);
  return initFor(await frameNow());
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  h.getArtifact.mockImplementation(async (id: string) => {
    if (id === "cramhouse") return artifact();
    if (id === "other-app") return artifact({ id: "other-app", name: "Other" });
    throw new Error("Artifact not found");
  });
  h.listStorageKeys.mockResolvedValue([
    { key: "birds", itemCount: 1, totalSize: 1, updated: "x" },
    { key: "trees", itemCount: 1, totalSize: 1, updated: "x" },
  ]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ArtifactPage — rendering", () => {
  it("fills the page with the chat's sandboxed frame, pinned to the current version's sha256", async () => {
    visit("/a/cramhouse?key=birds");
    const frame = await frameNow();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe(`/api/artifacts/cramhouse/versions/2/render?bridge=${/bridge=([0-9a-f]{32})/.exec(frame.src)![1]}&sha256=${SHA2}`);
    // No chat chrome: no bubble header, no fullscreen button, no 85% box.
    expect(screen.queryByTitle("Fullscreen")).toBeNull();
    expect(screen.getByTestId("artifact-renderer").style.maxWidth).toBe("");
    expect(screen.getByTestId("artifact-page-bar").textContent).toMatch(/Cramhouse.*v2/);
  });

  it("&v=N pins version N with its own sha256", async () => {
    visit("/a/cramhouse?key=birds&v=1");
    expect((await frameNow()).getAttribute("src")).toMatch(new RegExp(`^/api/artifacts/cramhouse/versions/1/render\\?bridge=[0-9a-f]{32}&sha256=${SHA1}$`));
  });

  it("an artifact that takes no storage renders unbound whatever key the link names", async () => {
    h.getArtifact.mockResolvedValue(artifact({ storageAccess: "none" }));
    expect(await grantOf("/a/cramhouse?key=birds")).toMatchObject({ storageKey: null, access: "none" });
    expect(screen.queryByLabelText("Storage key")).toBeNull();
    expect(h.listStorageKeys).not.toHaveBeenCalled();
  });

  it("the key picker rebinds, keeps a pinned v, and drops every other parameter from the URL", async () => {
    visit("/a/cramhouse?key=birds&v=1&write=1");
    const first = await frameNow();
    fireEvent.change(await screen.findByLabelText("Storage key"), { target: { value: "trees" } });
    expect(screen.getByTestId("location").textContent).toBe("/a/cramhouse?key=trees&v=1");
    expect(await initFor(await frameNow((f) => f !== first))).toMatchObject({ storageKey: "trees", access: "read" });
  });
});

describe("ArtifactPage — errors: the readable box, no frame", () => {
  it.each([
    ["an invalid artifact id", "/a/Bad_Id?key=birds", /not a valid artifact id/],
    ["a key with ../", `/a/cramhouse?key=${encodeURIComponent("../etc")}`, /not a valid storage key/],
    ["a key with a slash", `/a/cramhouse?key=${encodeURIComponent("birds/x")}`, /not a valid storage key/],
    ["a huge v", "/a/cramhouse?key=birds&v=99999999999999999999", /not a valid version/],
    ["v=0", "/a/cramhouse?key=birds&v=0", /not a valid version/],
    ["a path under the artifact", "/a/cramhouse/x", /there is no page at "\/x" under an artifact/],
    ["a deeper path, with a key", "/a/cramhouse/x/y?key=birds", /there is no page at "\/x\/y" under an artifact/],
    ["a non-numeric v", "/a/cramhouse?key=birds&v=1e3", /not a valid version/],
  ])("%s is refused before any request", async (_label, url, reason) => {
    visit(url);
    expect((await screen.findByRole("alert")).textContent).toMatch(reason);
    expect(document.querySelector("iframe")).toBeNull();
    expect(h.getArtifact).not.toHaveBeenCalled();
    expect(h.listStorageKeys).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing artifact", "/a/nope?key=birds", /"nope" does not exist/],
    ["a version past the latest", "/a/cramhouse?key=birds&v=7", /version 7 of "Cramhouse" does not exist — the latest is v2/],
    ["a missing key", "/a/cramhouse?key=gone", /storage key "gone" does not exist/],
  ])("%s", async (_label, url, reason) => {
    visit(url);
    expect((await screen.findByRole("alert")).textContent).toMatch(reason);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("a pruned version is named as no longer kept", async () => {
    h.getArtifact.mockResolvedValue(artifact({ versions: [{ version: 2, created: "c", size: 12, sha256: SHA2 }] }));
    visit("/a/cramhouse?key=birds&v=1");
    expect((await screen.findByRole("alert")).textContent).toMatch(/version 1 of "Cramhouse" is no longer kept/);
    expect(document.querySelector("iframe")).toBeNull();
  });
});

describe("ArtifactPage — the write grant", () => {
  it("defaults to read, with 'Allow saving' unticked", async () => {
    expect(await grantOf("/a/cramhouse?key=birds")).toMatchObject({ storageKey: "birds", access: "read" });
    expect((screen.getByLabelText("Allow saving") as HTMLInputElement).checked).toBe(false);
    await waitFor(() => expect(screen.getByTestId("artifact-page-access").textContent).toBe("read-only"));
  });

  it.each([
    "/a/cramhouse?key=birds&write=1",
    "/a/cramhouse?key=birds&access=readwrite",
    "/a/cramhouse?key=birds&storage_access=readwrite&allow=1&allowWrites=true&rw=1",
    "/a/cramhouse?access=readwrite&key=birds&write=true&v=2",
  ])("no URL parameter grants write: %s", async (url) => {
    expect(await grantOf(url)).toMatchObject({ storageKey: "birds", access: "read" });
    expect(getArtifactWriteGrant("cramhouse", "c", "birds")).toBe(false);
  });

  it("ticking 'Allow saving' remounts read/write and is remembered across reloads", async () => {
    visit("/a/cramhouse?key=birds");
    const readFrame = await frameNow();
    fireEvent.click(screen.getByLabelText("Allow saving"));
    expect(await initFor(await frameNow((f) => f !== readFrame))).toMatchObject({ storageKey: "birds", access: "readwrite" });
    await waitFor(() => expect(screen.getByTestId("artifact-page-access").textContent).toBe("read/write"));
    cleanup();

    expect(await grantOf("/a/cramhouse?key=birds")).toMatchObject({ storageKey: "birds", access: "readwrite" });
    expect((screen.getByLabelText("Allow saving") as HTMLInputElement).checked).toBe(true);
  });

  it("the remembered grant is per (artifact, key): another key or another artifact starts at read", async () => {
    saveArtifactWriteGrant("cramhouse", "c", "birds", true);
    expect(await grantOf("/a/cramhouse?key=trees")).toMatchObject({ access: "read" });
    cleanup();
    expect(await grantOf("/a/other-app?key=birds")).toMatchObject({ access: "read" });
    cleanup();
    expect(await grantOf("/a/cramhouse?key=birds")).toMatchObject({ access: "readwrite" });
  });

  it("a grant left by a deleted artifact does not carry to a new one recreated under the same id, and is dropped", async () => {
    // Ticked for the artifact created at "c"; that one was deleted and a different one created as "cramhouse".
    saveArtifactWriteGrant("cramhouse", "c", "birds", true);
    h.getArtifact.mockResolvedValue(artifact({ created: "c2" }));
    expect(await grantOf("/a/cramhouse?key=birds")).toMatchObject({ storageKey: "birds", access: "read" });
    expect((screen.getByLabelText("Allow saving") as HTMLInputElement).checked).toBe(false);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("claude-code-settings")!).artifactWriteGrants).toEqual({}));
    // Ticking now grants the new artifact, bound to its own identity.
    fireEvent.click(screen.getByLabelText("Allow saving"));
    expect(getArtifactWriteGrant("cramhouse", "c2", "birds")).toBe(true);
    expect(getArtifactWriteGrant("cramhouse", "c", "birds")).toBe(false);
  });

  it("unticking revokes at once: a fresh frame with read, and the choice is forgotten", async () => {
    saveArtifactWriteGrant("cramhouse", "c", "birds", true);
    visit("/a/cramhouse?key=birds");
    const rwFrame = await frameNow();
    expect(await initFor(rwFrame)).toMatchObject({ access: "readwrite" });
    fireEvent.click(screen.getByLabelText("Allow saving"));
    expect(await initFor(await frameNow((f) => f !== rwFrame))).toMatchObject({ access: "read" });
    expect(getArtifactWriteGrant("cramhouse", "c", "birds")).toBe(false);
  });

  it("unticking in another tab revokes this one too", async () => {
    saveArtifactWriteGrant("cramhouse", "c", "birds", true);
    visit("/a/cramhouse?key=birds");
    const rwFrame = await frameNow();
    expect(await initFor(rwFrame)).toMatchObject({ access: "readwrite" });
    // The other tab's write lands in the shared store and arrives here as a `storage` event.
    const before = localStorage.getItem("claude-code-settings");
    localStorage.setItem("claude-code-settings", JSON.stringify({ ...JSON.parse(before!), artifactWriteGrants: {} }));
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "claude-code-settings" }));
    });
    expect(await initFor(await frameNow((f) => f !== rwFrame))).toMatchObject({ access: "read" });
  });

  it("an artifact declared read gets no write even with a remembered grant, and offers no toggle", async () => {
    saveArtifactWriteGrant("cramhouse", "c", "birds", true);
    h.getArtifact.mockResolvedValue(artifact({ storageAccess: "read" }));
    expect(await grantOf("/a/cramhouse?key=birds")).toMatchObject({ access: "read" });
    expect(screen.queryByLabelText("Allow saving")).toBeNull();
  });

  it("declared access lowered after the page loaded: the render's own fresh check wins, so no write", async () => {
    saveArtifactWriteGrant("cramhouse", "c", "birds", true);
    // The page's load sees readwrite; the renderer's judge-before-mount (the next fetch) sees it lowered to read.
    h.getArtifact.mockResolvedValueOnce(artifact()).mockResolvedValue(artifact({ storageAccess: "read" }));
    expect(await grantOf("/a/cramhouse?key=birds")).toMatchObject({ access: "read" });
    await waitFor(() => expect(screen.getByTestId("artifact-page-access").textContent).toBe("read-only"));
  });
});
