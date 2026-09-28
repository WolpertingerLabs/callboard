// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import ArtifactRenderer from "./ArtifactRenderer";
import { BRIDGE_INIT, BRIDGE_REPLY, BRIDGE_REQUEST, type BridgeStorageApi } from "./artifactBridge";
import type { RenderArtifactToolResult } from "../api";

/**
 * ArtifactRenderer as mounted — the wiring `artifactBridge.test.ts` cannot see.
 *
 * That file proves the rules on a bridge driven by hand. What is only
 * decidable here is that the component actually connects them to the real
 * iframe: the sandbox is exactly `allow-scripts`, the init goes to *this*
 * frame's window on its first load, a real window `message` event from that
 * frame is served, a second load cuts it off, and changing the grant is a new
 * frame (new nonce) rather than a re-grant to the running document.
 */

const h = vi.hoisted(() => ({ getArtifactVersionSource: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getArtifactVersionSource: h.getArtifactVersionSource };
});

const base: RenderArtifactToolResult = {
  type: "render_artifact",
  artifact_id: "cramhouse",
  version: 3,
  name: "Cramhouse",
  content_type: "html",
  storage_key: "birds",
  storage_access: "read",
};

function api(): BridgeStorageApi & { readText: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> } {
  return {
    list: vi.fn(async () => []),
    readText: vi.fn(async () => "hello"),
    readBlob: vi.fn(async () => new Blob()),
    write: vi.fn(async (_k: string, name: string) => ({ name, mimeType: "text/plain", size: 1, sha256: "s", created: "c", updated: "u" })),
    remove: vi.fn(async () => undefined),
  };
}

function frameOf(container: HTMLElement): HTMLIFrameElement {
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("no iframe");
  return frame;
}

function fromFrame(frame: HTMLIFrameElement, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow }));
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ArtifactRenderer", () => {
  it("renders html in a frame sandboxed to allow-scripts only, from the render route", () => {
    const { container } = render(<ArtifactRenderer data={base} bridgeApi={api()} />);
    const frame = frameOf(container);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("src")).toBe("/api/artifacts/cramhouse/versions/3/render");
  });

  it("encodes the id in the render URL", () => {
    const { container } = render(<ArtifactRenderer data={{ ...base, artifact_id: "a b/../c" }} bridgeApi={api()} />);
    expect(frameOf(container).getAttribute("src")).toBe("/api/artifacts/a%20b%2F..%2Fc/versions/3/render");
  });

  it("wires the bridge: init on first load, serves the frame, revokes on a second load", async () => {
    const storage = api();
    const { container } = render(<ArtifactRenderer data={base} bridgeApi={storage} />);
    const frame = frameOf(container);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");

    fireEvent.load(frame);
    expect(post).toHaveBeenCalledTimes(1);
    const init = post.mock.calls[0][0] as { nonce: string };
    expect(init).toMatchObject({ __callboard: BRIDGE_INIT, storageKey: "birds", access: "read" });

    fromFrame(frame, { __callboard: BRIDGE_REQUEST, nonce: init.nonce, id: "r1", op: "read", name: "deck.json" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][0]).toEqual({ __callboard: BRIDGE_REPLY, id: "r1", ok: true, result: "hello" });
    expect(storage.readText).toHaveBeenCalledWith("birds", "deck.json");

    // Write under a read grant is refused.
    fromFrame(frame, { __callboard: BRIDGE_REQUEST, nonce: init.nonce, id: "w1", op: "write", name: "deck.json", data: "x" });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post.mock.calls[2][0]).toMatchObject({ id: "w1", ok: false });
    expect(storage.write).not.toHaveBeenCalled();

    // The frame navigates itself: the next document gets nothing.
    fireEvent.load(frame);
    fromFrame(frame, { __callboard: BRIDGE_REQUEST, nonce: init.nonce, id: "r2", op: "read", name: "deck.json" });
    await new Promise((r) => setTimeout(r, 10));
    expect(post).toHaveBeenCalledTimes(3);
    expect(storage.readText).toHaveBeenCalledTimes(1);
  });

  it("ignores a correctly-nonced request that does not come from its frame", async () => {
    const storage = api();
    const { container } = render(<ArtifactRenderer data={base} bridgeApi={storage} />);
    const frame = frameOf(container);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    const { nonce } = post.mock.calls[0][0] as { nonce: string };
    window.dispatchEvent(new MessageEvent("message", { data: { __callboard: BRIDGE_REQUEST, nonce, id: 1, op: "list" }, source: window }));
    await new Promise((r) => setTimeout(r, 10));
    expect(storage.list).not.toHaveBeenCalled();
  });

  it("an unbound render initialises with access none", () => {
    const { container } = render(<ArtifactRenderer data={{ ...base, storage_key: undefined, storage_access: "readwrite" }} bridgeApi={api()} />);
    const frame = frameOf(container);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    expect(post.mock.calls[0][0]).toMatchObject({ storageKey: null, access: "none" });
  });

  it("changing the grant mounts a new frame with a new nonce", () => {
    const { container, rerender } = render(<ArtifactRenderer data={base} bridgeApi={api()} />);
    const first = frameOf(container);
    const firstPost = vi.spyOn(first.contentWindow!, "postMessage");
    fireEvent.load(first);
    rerender(<ArtifactRenderer data={{ ...base, storage_access: "readwrite" }} bridgeApi={api()} />);
    const second = frameOf(container);
    expect(second).not.toBe(first);
    const secondPost = vi.spyOn(second.contentWindow!, "postMessage");
    fireEvent.load(second);
    const a = firstPost.mock.calls[0][0] as { nonce: string };
    const b = secondPost.mock.calls[0][0] as { nonce: string; access: string };
    expect(b.access).toBe("readwrite");
    expect(b.nonce).not.toBe(a.nonce);
  });

  it("renders svg through <img>, never a frame", () => {
    const { container } = render(<ArtifactRenderer data={{ ...base, content_type: "svg" }} />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/api/artifacts/cramhouse/versions/3/render");
  });

  it("renders markdown from the source text through MarkdownRenderer, never a frame", async () => {
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
