// @vitest-environment jsdom
/**
 * `useIsMobile` must answer correctly on its FIRST render — starting from
 * `false` painted the desktop layout for a frame on every phone — and must
 * follow the media query's `change` event rather than every `resize`.
 *
 * jsdom has no `matchMedia`, so the query is stubbed here; the last block
 * covers the `innerWidth` fallback the rest of the suite relies on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useIsMobile } from "./useIsMobile";

/** Every value the hook returned, in render order — `[0]` is the first paint. */
function renderRecorder() {
  const seen: boolean[] = [];
  function Probe() {
    seen.push(useIsMobile());
    return null;
  }
  const view = render(<Probe />);
  return { seen, view };
}

/** A controllable MediaQueryList for `(max-width: 767px)`. */
function stubMatchMedia(initial: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initial,
    media: "",
    addEventListener: vi.fn((_type: string, cb: () => void) => listeners.add(cb)),
    removeEventListener: vi.fn((_type: string, cb: () => void) => listeners.delete(cb)),
  };
  const matchMedia = vi.fn((media: string) => {
    query.media = media;
    return query as unknown as MediaQueryList;
  });
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    query,
    matchMedia,
    listeners,
    flip(matches: boolean) {
      query.matches = matches;
      act(() => listeners.forEach((cb) => cb()));
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("with matchMedia", () => {
  it("is true on the very first render on a phone", () => {
    const mq = stubMatchMedia(true);
    const { seen } = renderRecorder();
    expect(seen[0]).toBe(true);
    expect(seen.every(Boolean)).toBe(true);
    expect(mq.matchMedia).toHaveBeenCalledWith("(max-width: 767px)");
  });

  it("is false on the first render on a desktop", () => {
    stubMatchMedia(false);
    const { seen } = renderRecorder();
    expect(seen[0]).toBe(false);
  });

  it("follows the query's change event and ignores plain resizes", () => {
    const mq = stubMatchMedia(false);
    const { seen } = renderRecorder();

    mq.flip(true);
    expect(seen.at(-1)).toBe(true);

    const renders = seen.length;
    act(() => window.dispatchEvent(new Event("resize")));
    expect(seen.length).toBe(renders);

    mq.flip(false);
    expect(seen.at(-1)).toBe(false);
  });

  it("unsubscribes on unmount", () => {
    const mq = stubMatchMedia(false);
    const { view } = renderRecorder();
    expect(mq.listeners.size).toBe(1);
    view.unmount();
    expect(mq.listeners.size).toBe(0);
  });
});

describe("without matchMedia (jsdom)", () => {
  const original = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: original, configurable: true });
  });

  it("reads innerWidth on the first render and follows resize, with the same < 768 breakpoint", () => {
    expect(window.matchMedia).toBeUndefined();
    Object.defineProperty(window, "innerWidth", { value: 767, configurable: true });
    const { seen } = renderRecorder();
    expect(seen[0]).toBe(true);

    act(() => {
      Object.defineProperty(window, "innerWidth", { value: 768, configurable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(seen.at(-1)).toBe(false);
  });
});
