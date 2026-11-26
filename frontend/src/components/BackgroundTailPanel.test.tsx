// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { BackgroundTailResponse, BackgroundTailStream } from "../api";

const getBackgroundTail = vi.hoisted(() => vi.fn());
vi.mock("../api", async (orig) => {
  const real = await orig<typeof import("../api")>();
  return { ...real, getBackgroundTail };
});
const { default: BackgroundTailPanel } = await import("./BackgroundTailPanel");
const { BackgroundTailError } = await import("../api");

const streamButtons = () => within(screen.getByRole("group", { name: "Output streams" })).getAllByRole("button");
const streamButton = (name: string) => within(screen.getByRole("group", { name: "Output streams" })).getByRole("button", { name });

// jsdom has no layout: give <pre> a scroll box the test controls.
const scrollTops = new WeakMap<Element, number>();
let scrollHeight = 1000;
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 200 });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return scrollTops.get(this) ?? 0;
    },
    set(this: Element, v: number) {
      scrollTops.set(this, v);
    },
  });
});

const now = Date.now();
const streams: BackgroundTailStream[] = [
  { id: "output", kind: "engine", label: "output", displayPath: "/tmp/claude-1/x/tasks/b1.output", exists: true, size: 10, mtimeMs: now - 4000 },
  { id: "r0", kind: "redirect", label: "stdout → rsync.log", displayPath: "~/backup/logs/rsync.log", exists: true, size: 12_600, mtimeMs: now - 1000 },
  { id: "r1", kind: "redirect", label: "stderr → rsync.err", displayPath: "~/backup/logs/rsync.err", exists: false, error: "missing" },
];

function respond(stream: string | undefined, lines: string[], extra: Partial<BackgroundTailResponse> = {}): BackgroundTailResponse {
  const id = stream ?? "r0";
  const s = streams.find((x) => x.id === id)!;
  return {
    toolUseId: "t1",
    taskId: "b1",
    streams,
    defaultStream: "r0",
    tail: s.exists ? { stream: id, size: s.size!, mtimeMs: s.mtimeMs!, lines } : null,
    ...extra,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  scrollHeight = 1000;
  getBackgroundTail.mockReset();
  getBackgroundTail.mockImplementation(async (_c: string, _t: string, { stream }: { stream?: string }) => respond(stream, [`${stream ?? "r0"} line`]));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("BackgroundTailPanel", () => {
  it("shows the default stream with its tabs and meta", async () => {
    render(<BackgroundTailPanel chatId="c1" toolUseId="t1" live={false} />);
    await flush();
    const tabs = streamButtons();
    expect(tabs.map((t) => t.textContent)).toEqual(["output", "stdout → rsync.log", "stderr → rsync.err"]);
    expect(tabs.map((t) => t.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    expect(screen.getByTestId("background-tail-lines").textContent).toBe("r0 line");
    expect(screen.getByText("~/backup/logs/rsync.log")).toBeTruthy();
    expect(screen.getByText(/12\.3 KB · updated/)).toBeTruthy();
  });

  it("switches stream from the tabs", async () => {
    render(<BackgroundTailPanel chatId="c1" toolUseId="t1" live={false} />);
    await flush();
    fireEvent.click(streamButton("output"));
    await flush();
    expect(getBackgroundTail.mock.calls.at(-1)?.[2]).toMatchObject({ stream: "output" });
    expect(screen.getByTestId("background-tail-lines").textContent).toBe("output line");
    expect(streamButton("output").getAttribute("aria-pressed")).toBe("true");
  });

  it("explains a missing file", async () => {
    render(<BackgroundTailPanel chatId="c1" toolUseId="t1" live={false} />);
    await flush();
    fireEvent.click(streamButton("stderr → rsync.err"));
    await flush();
    expect(screen.getByText("File no longer exists (cleaned up)")).toBeTruthy();
  });

  it("says when there is no output yet, and hides tabs for a single stream", async () => {
    getBackgroundTail.mockImplementation(async () => ({ toolUseId: "t1", streams: [{ ...streams[0], size: 0 }], defaultStream: null, tail: null }));
    render(<BackgroundTailPanel chatId="c1" toolUseId="t1" live={false} />);
    await flush();
    expect(screen.queryByRole("group", { name: "Output streams" })).toBeNull();
    expect(screen.getByText("No output yet")).toBeTruthy();
  });

  it("says binary output is not shown", async () => {
    getBackgroundTail.mockImplementation(async () => respond("r0", [], { tail: { stream: "r0", size: 5, mtimeMs: 1, lines: [], binary: true } }));
    render(<BackgroundTailPanel chatId="c1" toolUseId="t1" live={false} />);
    await flush();
    expect(screen.getByText("Binary output — not shown")).toBeTruthy();
  });

  it("shows Loading, not 'No output yet', while a switched-to stream loads", async () => {
    render(<BackgroundTailPanel chatId="c1" toolUseId="t1" live={false} />);
    await flush();
    let resolve!: (v: BackgroundTailResponse) => void;
    getBackgroundTail.mockImplementation(() => new Promise((r) => (resolve = r)));
    fireEvent.click(streamButton("output"));
    await flush();
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("No output yet")).toBeNull();
    await act(async () => resolve(respond("output", ["output line"])));
    expect(screen.getByTestId("background-tail-lines").textContent).toBe("output line");
  });

  it("keeps showing the stream it is fetching when that file goes away", async () => {
    vi.useFakeTimers();
    render(<BackgroundTailPanel chatId="c1" toolUseId="t1" live={true} />);
    await flush();
    // r0 rotated away; the server's default moves to r1, but the panel is still on r0.
    getBackgroundTail.mockImplementation(async () => ({
      toolUseId: "t1",
      streams: [
        streams[0],
        { ...streams[1], exists: false, size: undefined, mtimeMs: undefined, error: "missing" },
        { ...streams[2], exists: true, size: 4, mtimeMs: now },
      ],
      defaultStream: "r1",
      tail: null,
    }));
    await act(async () => vi.advanceTimersByTime(2500));
    await flush();
    expect(streamButton("stdout → rsync.log").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("File not created yet")).toBeTruthy();
  });

  it("says it is reconnecting when polls fail after a good load, with a retry", async () => {
    vi.useFakeTimers();
    render(<BackgroundTailPanel chatId="c1" toolUseId="t1" live={true} />);
    await flush();
    getBackgroundTail.mockImplementation(async () => {
      throw new BackgroundTailError("Network down", 500);
    });
    await act(async () => vi.advanceTimersByTime(2500));
    await flush();
    expect(screen.getByText(/Reconnecting… \(Network down\)/)).toBeTruthy();
    expect(screen.getByTestId("background-tail-lines").textContent).toBe("r0 line");
    getBackgroundTail.mockImplementation(async () => respond("r0", ["fresh"]));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.queryByText(/Reconnecting/)).toBeNull();
    expect(screen.getByTestId("background-tail-lines").textContent).toBe("fresh");
  });

  it("offers a retry when the first load fails", async () => {
    getBackgroundTail.mockImplementation(async () => {
      throw new BackgroundTailError("boom", 500);
    });
    render(<BackgroundTailPanel chatId="c1" toolUseId="t1" live={false} />);
    await flush();
    expect(screen.getByText("Couldn't load output: boom")).toBeTruthy();
    getBackgroundTail.mockImplementation(async () => respond("r0", ["ok"]));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(screen.getByTestId("background-tail-lines").textContent).toBe("ok");
  });

  it("follows new output at the bottom, and stops once the user scrolls up", async () => {
    vi.useFakeTimers();
    try {
      let n = 1;
      getBackgroundTail.mockImplementation(async () =>
        respond(
          "r0",
          Array.from({ length: n++ }, (_, i) => `line ${i}`),
        ),
      );
      render(<BackgroundTailPanel chatId="c1" toolUseId="t1" live={true} />);
      await flush();
      const pre = screen.getByTestId("background-tail-lines");
      expect(pre.scrollTop).toBe(1000);

      scrollHeight = 1500;
      await act(async () => vi.advanceTimersByTime(2500));
      await flush();
      expect(pre.scrollTop).toBe(1500);
      expect(screen.queryByText("Latest")).toBeNull();

      // Scroll up: no longer following.
      pre.scrollTop = 100;
      fireEvent.scroll(pre);
      scrollHeight = 2000;
      await act(async () => vi.advanceTimersByTime(2500));
      await flush();
      expect(pre.scrollTop).toBe(100);
      fireEvent.click(screen.getByRole("button", { name: /Latest/ }));
      expect(pre.scrollTop).toBe(2000);
      expect(screen.queryByRole("button", { name: /Latest/ })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
