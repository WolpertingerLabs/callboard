// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import ArtifactRenderer, { judgeRender } from "./ArtifactRenderer";
import { BRIDGE_HELLO, BRIDGE_INIT, BRIDGE_REPLY, BRIDGE_REQUEST, type BridgeStorageApi } from "./artifactBridge";
import type { Artifact, RenderArtifactToolResult } from "../api";

/**
 * ArtifactRenderer as mounted — the wiring `artifactBridge.test.ts` cannot see.
 *
 * That file proves the rules on a bridge driven by hand. What is only
 * decidable here is that the component actually connects them to the real
 * iframe: nothing mounts until the result has been checked against the
 * artifact as it is now, the grant is the lesser of the result's and the
 * artifact's current access, the sandbox is exactly `allow-scripts`, the
 * frame's src carries the mount's token, a hello from *this* frame is what
 * binds, a second load cuts it off, fullscreen is the same frame, and
 * changing the grant is a new frame (new token) rather than a re-grant to the
 * running document.
 */

const h = vi.hoisted(() => ({ getArtifactVersionSource: vi.fn(), getArtifact: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getArtifactVersionSource: h.getArtifactVersionSource, getArtifact: h.getArtifact };
});

const SHA = "a".repeat(64);

const base: RenderArtifactToolResult = {
  type: "render_artifact",
  artifact_id: "cramhouse",
  version: 3,
  sha256: SHA,
  name: "Cramhouse",
  content_type: "html",
  storage_key: "birds",
  storage_access: "read",
};

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "cramhouse",
    name: "Cramhouse",
    contentType: "html",
    storageAccess: "readwrite",
    currentVersion: 3,
    created: "c",
    updated: "u",
    versions: [{ version: 3, created: "c", size: 10, sha256: SHA }],
    ...over,
  };
}

function api(): BridgeStorageApi & { readText: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => []),
    readText: vi.fn(async () => "hello"),
    readBlob: vi.fn(async () => ({ blob: new Blob() })),
    write: vi.fn(async (_k: string, name: string) => ({ name, mimeType: "text/plain", size: 1, sha256: "s", created: "c", updated: "u" })),
    remove: vi.fn(async () => undefined),
  };
}

async function frameOf(container: HTMLElement): Promise<HTMLIFrameElement> {
  return waitFor(() => {
    const frame = container.querySelector("iframe");
    if (!frame) throw new Error("no iframe");
    return frame;
  });
}

function tokenOf(frame: HTMLIFrameElement): string {
  const m = /\?bridge=([0-9a-f]{32})$/.exec(frame.getAttribute("src") ?? "");
  if (!m) throw new Error(`no token in ${frame.getAttribute("src")}`);
  return m[1];
}

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  onmessage: ((e: MessageEvent) => void) | null;
}

/** A window `message` event from `source`, carrying `ports` — jsdom's MessageEvent cannot take fake ports, so they are defined on. */
function windowMessage(data: unknown, source: unknown, ports: FakePort[] = []) {
  const ev = new MessageEvent("message", { data, source: source as Window });
  Object.defineProperty(ev, "ports", { value: ports });
  window.dispatchEvent(ev);
}

/** What the served shim does at parse time: hello to the parent with the token from its src, transferring a port. */
function hello(frame: HTMLIFrameElement, token = tokenOf(frame)): FakePort {
  const port: FakePort = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
  windowMessage({ __callboard: BRIDGE_HELLO, token }, frame.contentWindow, [port]);
  return port;
}

const request = (port: FakePort, token: string, body: Record<string, unknown>) => port.onmessage?.({ data: { __callboard: BRIDGE_REQUEST, token, ...body } } as MessageEvent);
const sent = (port: FakePort) => port.postMessage.mock.calls.map((c) => c[0]);

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  h.getArtifact.mockResolvedValue(artifact());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ArtifactRenderer — mounting", () => {
  it("renders html in a frame sandboxed to allow-scripts only, from the render route with this mount's token", async () => {
    const { container } = render(<ArtifactRenderer data={base} bridgeApi={api()} />);
    const frame = await frameOf(container);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toMatch(/^\/api\/artifacts\/cramhouse\/versions\/3\/render\?bridge=[0-9a-f]{32}$/);
  });

  it("encodes the id in the render URL", async () => {
    h.getArtifact.mockResolvedValue(artifact({ id: "a b/../c" }));
    const { container } = render(<ArtifactRenderer data={{ ...base, artifact_id: "a b/../c" }} bridgeApi={api()} />);
    expect((await frameOf(container)).getAttribute("src")).toMatch(/^\/api\/artifacts\/a%20b%2F..%2Fc\/versions\/3\/render\?bridge=/);
  });

  it("mounts nothing until the artifact has been checked", async () => {
    let resolve!: (a: Artifact) => void;
    h.getArtifact.mockReturnValue(new Promise<Artifact>((r) => (resolve = r)));
    const { container } = render(<ArtifactRenderer data={base} bridgeApi={api()} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector("iframe")).toBeNull();
    expect(h.getArtifact).toHaveBeenCalledWith("cramhouse");
    await act(async () => resolve(artifact()));
    await frameOf(container);
  });
});

describe("ArtifactRenderer — bridge wiring", () => {
  it("a hello from its frame with its token binds; init and replies go down the port, never to the frame's window", async () => {
    const storage = api();
    const { container } = render(<ArtifactRenderer data={base} bridgeApi={storage} />);
    const frame = await frameOf(container);
    const toWindow = vi.spyOn(frame.contentWindow!, "postMessage");
    const token = tokenOf(frame);

    const port = hello(frame);
    expect(sent(port)).toEqual([{ __callboard: BRIDGE_INIT, storageKey: "birds", access: "read" }]);
    fireEvent.load(frame);

    request(port, token, { id: "r1", op: "read", name: "deck.json" });
    await waitFor(() => expect(sent(port)).toHaveLength(2));
    expect(sent(port)[1]).toEqual({ __callboard: BRIDGE_REPLY, id: "r1", ok: true, result: "hello" });
    expect(storage.readText).toHaveBeenCalledWith("birds", "deck.json");

    // Write under a read grant is refused.
    request(port, token, { id: "w1", op: "write", name: "deck.json", data: "x" });
    await waitFor(() => expect(sent(port)).toHaveLength(3));
    expect(sent(port)[2]).toMatchObject({ id: "w1", ok: false });
    expect(storage.write).not.toHaveBeenCalled();

    // The frame navigates itself: the bridge is dead.
    fireEvent.load(frame);
    expect(port.close).toHaveBeenCalled();
    request(port, token, { id: "r2", op: "read", name: "deck.json" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent(port)).toHaveLength(3);
    expect(storage.readText).toHaveBeenCalledTimes(1);
    expect(toWindow).not.toHaveBeenCalled();
  });

  it("a hello with the right token but from another source, or the wrong token from the frame, binds nothing", async () => {
    const { container } = render(<ArtifactRenderer data={base} bridgeApi={api()} />);
    const frame = await frameOf(container);
    const token = tokenOf(frame);
    const stranger: FakePort = { postMessage: vi.fn(), close: vi.fn(), onmessage: null };
    windowMessage({ __callboard: BRIDGE_HELLO, token }, window, [stranger]);
    const wrong = hello(frame, "f".repeat(32));
    expect(stranger.postMessage).not.toHaveBeenCalled();
    expect(wrong.postMessage).not.toHaveBeenCalled();
    expect(sent(hello(frame))).toHaveLength(1);
  });

  it("an unbound render initialises with access none and shows no key badge", async () => {
    const { container } = render(<ArtifactRenderer data={{ ...base, storage_key: undefined, storage_access: "readwrite" }} bridgeApi={api()} />);
    const port = hello(await frameOf(container));
    expect(sent(port)[0]).toMatchObject({ storageKey: null, access: "none" });
    expect(screen.queryByTestId("artifact-key-badge")).toBeNull();
  });

  it("changing the grant mounts a new frame with a new token", async () => {
    const { container, rerender } = render(<ArtifactRenderer data={base} bridgeApi={api()} />);
    const first = await frameOf(container);
    const firstToken = tokenOf(first);
    rerender(<ArtifactRenderer data={{ ...base, storage_access: "readwrite" }} bridgeApi={api()} />);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBe(first));
    const second = await frameOf(container);
    expect(tokenOf(second)).not.toBe(firstToken);
    expect(sent(hello(second))[0]).toMatchObject({ access: "readwrite" });
  });
});

describe("ArtifactRenderer — the grant is re-checked against the artifact as it is now", () => {
  it("grants the lesser of the result's access and the artifact's current access (downgraded since)", async () => {
    h.getArtifact.mockResolvedValue(artifact({ storageAccess: "read" }));
    const { container } = render(<ArtifactRenderer data={{ ...base, storage_access: "readwrite" }} bridgeApi={api()} />);
    expect(sent(hello(await frameOf(container)))[0]).toMatchObject({ storageKey: "birds", access: "read" });
    expect(screen.getByTestId("artifact-key-badge").textContent).toBe("birds · read");
  });

  it("an artifact since lowered to none gets no storage at all, and no key badge", async () => {
    h.getArtifact.mockResolvedValue(artifact({ storageAccess: "none" }));
    const { container } = render(<ArtifactRenderer data={{ ...base, storage_access: "readwrite" }} bridgeApi={api()} />);
    expect(sent(hello(await frameOf(container)))[0]).toMatchObject({ access: "none" });
    expect(screen.queryByTestId("artifact-key-badge")).toBeNull();
  });

  it("never grants more than the result recorded, even if the artifact was raised since", async () => {
    h.getArtifact.mockResolvedValue(artifact({ storageAccess: "readwrite" }));
    const { container } = render(<ArtifactRenderer data={{ ...base, storage_access: "read" }} bridgeApi={api()} />);
    expect(sent(hello(await frameOf(container)))[0]).toMatchObject({ access: "read" });
  });

  it.each<[string, () => void, Partial<RenderArtifactToolResult>, RegExp]>([
    ["deleted", () => h.getArtifact.mockRejectedValue(new Error("Artifact not found: cramhouse")), {}, /"cramhouse" no longer exists/],
    ["unreachable", () => h.getArtifact.mockRejectedValue(new Error("Failed to fetch")), {}, /could not check the artifact \(Failed to fetch\)/],
    ["version pruned", () => h.getArtifact.mockResolvedValue(artifact({ versions: [{ version: 60, created: "c", size: 1, sha256: SHA }] })), {}, /no longer kept/],
    [
      "deleted and recreated (same version number, different bytes)",
      () => h.getArtifact.mockResolvedValue(artifact({ versions: [{ version: 3, created: "c", size: 1, sha256: "b".repeat(64) }] })),
      {},
      /has been replaced/,
    ],
    ["bound but written before sha256 pinning", () => undefined, { sha256: undefined }, /predates version pinning/],
  ])("fails closed when the artifact is %s: the error box, and no frame", async (_label, arrange, over, message) => {
    arrange();
    const { container } = render(<ArtifactRenderer data={{ ...base, ...over }} bridgeApi={api()} />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(message);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("an unbound result from before sha256 pinning still renders (it holds no grant)", async () => {
    const { container } = render(<ArtifactRenderer data={{ ...base, sha256: undefined, storage_key: undefined, storage_access: "none" }} bridgeApi={api()} />);
    await frameOf(container);
  });

  it("a deleted svg or markdown artifact also shows the error box, never the raw 404", async () => {
    h.getArtifact.mockRejectedValue(new Error("Artifact not found: cramhouse"));
    for (const content_type of ["svg", "markdown"] as const) {
      const { container, unmount } = render(<ArtifactRenderer data={{ ...base, content_type }} />);
      expect((await screen.findByRole("alert")).textContent).toMatch(/no longer exists/);
      expect(container.querySelector("img")).toBeNull();
      expect(h.getArtifactVersionSource).not.toHaveBeenCalled();
      unmount();
    }
  });

  it("judgeRender: the rules on their own", () => {
    expect(judgeRender(base, artifact())).toEqual({ status: "ok", access: "read" });
    expect(judgeRender({ ...base, storage_access: "readwrite" }, artifact({ storageAccess: "read" }))).toEqual({ status: "ok", access: "read" });
    expect(judgeRender({ ...base, storage_key: undefined, storage_access: "readwrite" }, artifact())).toEqual({ status: "ok", access: "none" });
    expect(judgeRender(base, artifact({ contentType: "svg" })).status).toBe("refused");
  });
});

describe("ArtifactRenderer — fullscreen is the same frame", () => {
  it("expanding restyles the one frame (no second frame, no reload) and the bridge keeps serving it", async () => {
    const storage = api();
    const { container } = render(<ArtifactRenderer data={base} bridgeApi={storage} />);
    const frame = await frameOf(container);
    const token = tokenOf(frame);
    const port = hello(frame);
    fireEvent.load(frame);

    fireEvent.click(screen.getByTitle("Fullscreen"));
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(document.querySelector("iframe")).toBe(frame);
    expect(screen.getByTestId("artifact-frame-box").style.position).toBe("fixed");
    expect(screen.getByTestId("artifact-fullscreen-backdrop")).toBeTruthy();

    request(port, token, { id: "r1", op: "list" });
    await waitFor(() => expect(sent(port)).toHaveLength(2));
    expect(sent(port)[1]).toMatchObject({ id: "r1", ok: true });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.querySelector("iframe")).toBe(frame);
    expect(screen.getByTestId("artifact-frame-box").style.position).toBe("");
    expect(screen.queryByTestId("artifact-fullscreen-backdrop")).toBeNull();
    expect(port.close).not.toHaveBeenCalled();
  });

  it("display_mode fullscreen opens on the same single frame", async () => {
    const { container } = render(<ArtifactRenderer data={{ ...base, display_mode: "fullscreen" }} bridgeApi={api()} />);
    await frameOf(container);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(screen.getByTestId("artifact-frame-box").style.position).toBe("fixed");
    fireEvent.click(screen.getByTitle("Close"));
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
  });
});

describe("ArtifactRenderer — other types", () => {
  it("renders svg through <img>, never a frame", async () => {
    h.getArtifact.mockResolvedValue(artifact({ contentType: "svg" }));
    const { container } = render(<ArtifactRenderer data={{ ...base, content_type: "svg" }} />);
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/artifacts/cramhouse/versions/3/render"));
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("an error is not sticky: switching to another version clears it", async () => {
    h.getArtifact.mockResolvedValue(
      artifact({
        contentType: "svg",
        versions: [
          { version: 3, created: "c", size: 1, sha256: SHA },
          { version: 4, created: "c", size: 1, sha256: SHA },
        ],
      }),
    );
    const svg = { ...base, content_type: "svg" as const };
    const { container, rerender } = render(<ArtifactRenderer data={svg} />);
    const img = await waitFor(() => {
      const el = container.querySelector("img");
      if (!el) throw new Error("no img yet");
      return el;
    });
    fireEvent.error(img);
    expect((await screen.findByRole("alert")).textContent).toMatch(/image failed to load/);
    rerender(<ArtifactRenderer data={{ ...svg, version: 4 }} />);
    await waitFor(() => expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/artifacts/cramhouse/versions/4/render"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders markdown from the source text through MarkdownRenderer, never a frame", async () => {
    h.getArtifact.mockResolvedValue(artifact({ contentType: "markdown" }));
    h.getArtifactVersionSource.mockResolvedValue("# Deck notes\n\n<script>window.pwned = 1</script>");
    const { container } = render(<ArtifactRenderer data={{ ...base, content_type: "markdown" }} />);
    expect(await screen.findByRole("heading", { name: "Deck notes" })).toBeTruthy();
    expect(h.getArtifactVersionSource).toHaveBeenCalledWith("cramhouse", 3);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  it("honours a maxWidth override for the settings pane", () => {
    render(<ArtifactRenderer data={base} maxWidth="100%" bridgeApi={api()} />);
    expect(screen.getByTestId("artifact-renderer").style.maxWidth).toBe("100%");
  });
});
