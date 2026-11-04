// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StarredMessageNavigator from "../components/StarredMessageNavigator";
import type { StarredMessage } from "../utils/starredMessages";

const setMessageStarred = vi.fn();
vi.mock("../api", () => ({ setMessageStarred: (...args: unknown[]) => setMessageStarred(...args) }));

const { useStableStarred, useStarredMessages, useStarredNavigation } = await import("./useStarredMessages");

/** A transcript container holding one row per message, as Chat renders them. */
function transcript(count: number) {
  const container = document.createElement("div");
  for (let i = 0; i < count; i++) {
    const row = document.createElement("div");
    row.dataset.messageIndex = String(i);
    container.appendChild(row);
  }
  document.body.appendChild(container);
  return container;
}
const row = (container: HTMLElement, i: number) => container.querySelector<HTMLElement>(`[data-message-index="${i}"]`)!;

beforeEach(() => {
  vi.useFakeTimers();
  Element.prototype.scrollIntoView = vi.fn();
  setMessageStarred.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** A controllable PATCH: each call parks until the test answers it. */
function deferredPatches() {
  const calls: { args: unknown[]; resolve: (v: { starredMessages: string[]; starredMessagesRev: number }) => void; reject: (e: unknown) => void }[] = [];
  setMessageStarred.mockImplementation(
    (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        calls.push({ args, resolve, reject });
      }),
  );
  return calls;
}
const keysOf = (r: { current: { starredKeys: Set<string> } }) => [...r.current.starredKeys].sort();

describe("useStarredMessages", () => {
  it("starts from the server's list and follows a refetched one", () => {
    const { result, rerender } = renderHook(({ stars, rev }) => useStarredMessages("c1", stars, rev), {
      initialProps: { stars: ["a"] as string[] | undefined, rev: 1 as number | undefined },
    });
    expect(keysOf(result)).toEqual(["a"]);
    rerender({ stars: ["a", "b"], rev: 2 });
    expect(keysOf(result)).toEqual(["a", "b"]);
  });

  it("applies a toggle at once, then adopts the server's answer", async () => {
    const calls = deferredPatches();
    const { result } = renderHook(() => useStarredMessages("c1", undefined, undefined));

    act(() => result.current.toggleStar("a", true));
    expect(setMessageStarred).toHaveBeenCalledWith("c1", "a", true);
    expect(keysOf(result)).toEqual(["a"]);

    // Another tab starred "z" meanwhile; the reply carries it.
    await act(async () => calls[0].resolve({ starredMessages: ["z", "a"], starredMessagesRev: 2 }));
    expect(keysOf(result)).toEqual(["a", "z"]);
  });

  it("keeps a second toggle shown when the first one's reply lands", async () => {
    const calls = deferredPatches();
    const { result } = renderHook(() => useStarredMessages("c1", [], 0));
    act(() => result.current.toggleStar("a", true));
    act(() => result.current.toggleStar("b", true));

    // The reply to A predates B: B must not flicker off.
    await act(async () => calls[0].resolve({ starredMessages: ["a"], starredMessagesRev: 1 }));
    expect(keysOf(result)).toEqual(["a", "b"]);
    await act(async () => calls[1].resolve({ starredMessages: ["a", "b"], starredMessagesRev: 2 }));
    expect(keysOf(result)).toEqual(["a", "b"]);
  });

  it("does not bring back a message unstarred before its star's reply arrived", async () => {
    const calls = deferredPatches();
    const { result } = renderHook(() => useStarredMessages("c1", [], 0));
    act(() => result.current.toggleStar("x", true));
    act(() => result.current.toggleStar("x", false));
    expect(keysOf(result)).toEqual([]);

    await act(async () => calls[0].resolve({ starredMessages: ["x"], starredMessagesRev: 1 }));
    expect(keysOf(result)).toEqual([]);
    await act(async () => calls[1].resolve({ starredMessages: [], starredMessagesRev: 2 }));
    expect(keysOf(result)).toEqual([]);
  });

  it("settles on the newest revision when replies arrive out of order", async () => {
    const calls = deferredPatches();
    const { result } = renderHook(() => useStarredMessages("c1", [], 0));
    act(() => result.current.toggleStar("x", true));
    act(() => result.current.toggleStar("x", false));

    // The unstar's reply first: it already covers the star sent before it.
    await act(async () => calls[1].resolve({ starredMessages: [], starredMessagesRev: 2 }));
    expect(keysOf(result)).toEqual([]);
    // The late, older reply must not resurrect the star.
    await act(async () => calls[0].resolve({ starredMessages: ["x"], starredMessagesRev: 1 }));
    expect(keysOf(result)).toEqual([]);
  });

  it("ignores a refetched record older than its own write", async () => {
    const calls = deferredPatches();
    const { result, rerender } = renderHook(({ stars, rev }) => useStarredMessages("c1", stars, rev), { initialProps: { stars: [] as string[], rev: 3 } });

    act(() => result.current.toggleStar("a", true));
    await act(async () => calls[0].resolve({ starredMessages: ["a"], starredMessagesRev: 4 }));
    // A getChat that started before the PATCH and lands after it.
    rerender({ stars: [], rev: 3 });
    expect(keysOf(result)).toEqual(["a"]);
    // A record fetched after it is adopted, other tabs' stars included.
    rerender({ stars: ["a", "b"], rev: 5 });
    expect(keysOf(result)).toEqual(["a", "b"]);
  });

  it("holds a toggle through a refetched record read before it landed", () => {
    deferredPatches();
    const { result, rerender } = renderHook(({ stars, rev }) => useStarredMessages("c1", stars, rev), { initialProps: { stars: [] as string[], rev: 1 } });
    act(() => result.current.toggleStar("a", true));
    rerender({ stars: [], rev: 1 });
    expect(keysOf(result)).toEqual(["a"]);
  });

  it("does not apply a reply to the chat the user has since switched to", async () => {
    const calls = deferredPatches();
    const { result, rerender } = renderHook(({ id, stars }) => useStarredMessages(id, stars, 0), {
      initialProps: { id: "c1", stars: [] as string[] | undefined },
    });
    act(() => result.current.toggleStar("a", true));

    rerender({ id: "c2", stars: undefined });
    expect(keysOf(result)).toEqual([]);
    await act(async () => calls[0].resolve({ starredMessages: ["a"], starredMessagesRev: 1 }));
    expect(keysOf(result)).toEqual([]);

    rerender({ id: "c2", stars: ["q"] });
    expect(keysOf(result)).toEqual(["q"]);
  });

  it("adopts a record whose revision went backwards once nothing of ours is recent", async () => {
    // A hand-edited chat JSON, or a record recreated from older metadata,
    // starts its revision over. Refusing it forever would freeze this tab.
    const calls = deferredPatches();
    const { result, rerender } = renderHook(({ stars, rev }) => useStarredMessages("c1", stars, rev), { initialProps: { stars: [] as string[], rev: 0 } });
    act(() => result.current.toggleStar("a", true));
    await act(async () => calls[0].resolve({ starredMessages: ["a"], starredMessagesRev: 7 }));

    // Inside the window it reads as a stale refetch and is ignored...
    rerender({ stars: ["reset"], rev: 1 });
    expect(keysOf(result)).toEqual(["a"]);
    // ...and once it has passed, as the record's own history.
    act(() => vi.advanceTimersByTime(10_001));
    rerender({ stars: ["reset", "x"], rev: 1 });
    expect(keysOf(result)).toEqual(["reset", "x"]);
  });

  it("adopts a lower revision straight away when this tab never wrote", () => {
    const { result, rerender } = renderHook(({ stars, rev }) => useStarredMessages("c1", stars, rev), { initialProps: { stars: ["a"] as string[], rev: 9 } });
    rerender({ stars: ["b"], rev: 2 });
    expect(keysOf(result)).toEqual(["b"]);
  });

  it("never adopts a lower revision while a toggle is in flight", () => {
    deferredPatches();
    vi.advanceTimersByTime(60_000);
    const { result, rerender } = renderHook(({ stars, rev }) => useStarredMessages("c1", stars, rev), { initialProps: { stars: ["a"] as string[], rev: 9 } });
    act(() => result.current.toggleStar("b", true));
    rerender({ stars: [], rev: 2 });
    expect(keysOf(result)).toEqual(["a", "b"]);
  });

  it("undoes only the failed toggle", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = deferredPatches();
    const { result } = renderHook(() => useStarredMessages("c1", ["a"], 1));
    act(() => result.current.toggleStar("a", false));
    act(() => result.current.toggleStar("b", true));
    await act(async () => calls[0].reject(new Error("nope")));
    expect(keysOf(result)).toEqual(["a", "b"]);
  });
});

describe("useStarredNavigation", () => {
  const latch = () => ({ unlatch: vi.fn(), suppressRelatchRef: { current: false } });
  const stars: StarredMessage[] = [
    { index: 1, key: "k1" },
    { index: 3, key: "k3" },
    { index: 5, key: "k5" },
  ];

  /**
   * A 100px viewport over rows whose centres move with `scroll`: rows 1, 3, 5
   * sit at 100, 300, 500 in content coordinates.
   */
  function laidOut(container: HTMLElement) {
    const geo = { scroll: 0 };
    container.getBoundingClientRect = () => ({ top: 0, height: 100 }) as DOMRect;
    for (const i of [1, 3, 5]) row(container, i).getBoundingClientRect = () => ({ top: i * 100 - 5 - geo.scroll, height: 10 }) as DOMRect;
    return {
      scrollTo(y: number) {
        geo.scroll = y;
        act(() => {
          container.dispatchEvent(new Event("scroll"));
          vi.advanceTimersByTime(50);
        });
      },
    };
  }

  it("walks down and up through the stars, stopping at the ends", () => {
    const container = transcript(6);
    const l = latch();
    const { result } = renderHook(() => useStarredNavigation("c1", stars, { current: container }, l));
    expect(result.current.current).toBeNull();

    // No layout in jsdom, so the first "down" starts from the oldest star.
    act(() => result.current.goNext());
    expect(result.current.current).toBe(0);
    expect(row(container, 1).scrollIntoView).toHaveBeenCalled();
    expect(row(container, 1).style.outline).not.toBe("");
    expect(l.unlatch).toHaveBeenCalled();
    expect(l.suppressRelatchRef.current).toBe(true);
    expect(result.current.canPrev).toBe(false);

    act(() => result.current.goNext());
    act(() => result.current.goNext());
    expect(result.current.current).toBe(2);
    expect(result.current.canNext).toBe(false);
    act(() => result.current.goNext());
    expect(result.current.current).toBe(2);

    act(() => result.current.goPrev());
    expect(result.current.current).toBe(1);
  });

  it("starts 'up' from the newest star when there is no layout", () => {
    const { result } = renderHook(() => useStarredNavigation("c1", stars, { current: transcript(6) }, latch()));
    act(() => result.current.goPrev());
    expect(result.current.current).toBe(2);
  });

  it("goes to the nearest star in each direction from the viewport", () => {
    const container = transcript(6);
    const view = laidOut(container);
    const { result } = renderHook(() => useStarredNavigation("c1", stars, { current: container }, latch()));
    // Viewport 250-350: middle 300 is on star 3 itself.
    view.scrollTo(250);
    act(() => result.current.goNext());
    expect(result.current.current).toBe(2);

    const up = renderHook(() => useStarredNavigation("c1", stars, { current: container }, latch()));
    act(() => up.result.current.goPrev());
    expect(up.result.current.current).toBe(0);
  });

  it("does not wrap: below every star, down is disabled; above every star, up is", () => {
    const container = transcript(6);
    const view = laidOut(container);
    const { result } = renderHook(() => useStarredNavigation("c1", stars, { current: container }, latch()));

    view.scrollTo(900);
    expect(result.current.canNext).toBe(false);
    expect(result.current.canPrev).toBe(true);
    act(() => result.current.goNext());
    expect(result.current.current).toBeNull();
    expect(row(container, 1).scrollIntoView).not.toHaveBeenCalled();

    view.scrollTo(-200);
    expect(result.current.canPrev).toBe(false);
    expect(result.current.canNext).toBe(true);
    act(() => result.current.goPrev());
    expect(result.current.current).toBeNull();
  });

  it("lets go of the remembered star when the user scrolls by hand", () => {
    const container = transcript(6);
    const view = laidOut(container);
    const { result } = renderHook(() => useStarredNavigation("c1", stars, { current: container }, latch()));
    view.scrollTo(0);
    act(() => result.current.goNext());
    expect(result.current.current).toBe(0);

    // Our own smooth scroll fires scroll events and must not count.
    view.scrollTo(50);
    expect(result.current.current).toBe(0);

    // The user wheels to the bottom: "up" is now judged from there.
    act(() => {
      row(container, 3).dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 400 }));
    });
    view.scrollTo(900);
    expect(result.current.current).toBeNull();
    expect(result.current.canPrev).toBe(true);
    act(() => result.current.goPrev());
    expect(result.current.current).toBe(2);
  });

  it("treats scroll keys in the transcript as manual scrolling, but not typing in the composer", () => {
    const container = transcript(6);
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    const { result } = renderHook(() => useStarredNavigation("c1", stars, { current: container }, latch()));
    act(() => result.current.goNext());
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    expect(result.current.current).toBe(0);
    act(() => {
      row(container, 1).dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    });
    expect(result.current.current).toBeNull();
  });

  it("forgets the position on a chat switch, even when the keys match (a fork)", () => {
    const container = transcript(6);
    const { result, rerender } = renderHook(({ id }) => useStarredNavigation(id, stars, { current: container }, latch()), { initialProps: { id: "c1" } });
    act(() => result.current.goNext());
    act(() => result.current.goNext());
    expect(result.current.current).toBe(1);
    rerender({ id: "fork" });
    expect(result.current.current).toBeNull();
  });

  it("lets go when something else scrolls the transcript away (jump-to-bottom, auto-scroll)", () => {
    // QA repro B: at "1 / 3", the floating jump-to-bottom button scrolled
    // away but the label stayed and up was disabled with every star above.
    const container = transcript(6);
    const view = laidOut(container);
    const { result } = renderHook(() => useStarredNavigation("c1", stars, { current: container }, latch()));
    view.scrollTo(0);
    act(() => result.current.goNext());
    expect(result.current.current).toBe(0);

    // The jump's smooth scroll settles on the star...
    view.scrollTo(50);
    expect(result.current.current).toBe(0);
    // ...then a programmatic scrollTop change: no wheel, no key, just scroll events.
    view.scrollTo(900);
    expect(result.current.current).toBeNull();
    expect(result.current.canPrev).toBe(true);
    expect(result.current.canNext).toBe(false);
    act(() => result.current.goPrev());
    expect(result.current.current).toBe(2);
  });

  it("forgets the position on leaving a chat and coming back to it", () => {
    // QA repro A: ▲ to "3 / 3" in A, open B, Back to A — A reopens at the
    // bottom and must not still claim 3 / 3.
    const container = transcript(6);
    const { result, rerender } = renderHook(({ id }) => useStarredNavigation(id, stars, { current: container }, latch()), { initialProps: { id: "A" } });
    act(() => result.current.goPrev());
    expect(result.current.current).toBe(2);
    rerender({ id: "B" });
    rerender({ id: "A" });
    expect(result.current.current).toBeNull();
  });

  it("holds the target through its own smooth scroll, then applies the out-of-view rule", () => {
    const container = transcript(6);
    const view = laidOut(container);
    const { result } = renderHook(() => useStarredNavigation("c1", stars, { current: container }, latch()));
    view.scrollTo(900);
    act(() => result.current.goPrev());
    expect(result.current.current).toBe(2);

    // Mid-flight: still far from the target, which must not count.
    view.scrollTo(700);
    expect(result.current.current).toBe(2);
    // Arrived.
    view.scrollTo(450);
    expect(result.current.current).toBe(2);
    // Then scrolled away by anything at all.
    view.scrollTo(900);
    expect(result.current.current).toBeNull();
  });

  it("lets go of a jump whose target never arrives", () => {
    const container = transcript(6);
    const view = laidOut(container);
    const { result } = renderHook(() => useStarredNavigation("c1", stars, { current: container }, latch()));
    view.scrollTo(900);
    act(() => result.current.goPrev());
    act(() => vi.advanceTimersByTime(2000));
    view.scrollTo(900);
    expect(result.current.current).toBeNull();
  });

  it("re-measures after a click in the transcript (an expanded tool call shifts the layout)", () => {
    const container = transcript(6);
    const view = laidOut(container);
    const { result } = renderHook(() => useStarredNavigation("c1", stars, { current: container }, latch()));
    view.scrollTo(900);
    expect(result.current.canNext).toBe(false);

    // Something above grew by 1000px: every star is now below the viewport.
    for (const i of [1, 3, 5]) row(container, i).getBoundingClientRect = () => ({ top: i * 100 + 1000 - 5 - 900, height: 10 }) as DOMRect;
    act(() => {
      row(container, 1).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      vi.advanceTimersByTime(50);
    });
    expect(result.current.canNext).toBe(true);
    expect(result.current.canPrev).toBe(false);
  });

  it("keeps its place by key as stars change around it, and lets go when its star is removed", () => {
    const { result, rerender } = renderHook(({ s }) => useStarredNavigation("c1", s, { current: transcript(8) }, latch()), { initialProps: { s: stars } });
    act(() => result.current.goNext());
    act(() => result.current.goNext());
    expect(result.current.current).toBe(1);

    rerender({ s: [{ index: 0, key: "k0" }, ...stars] });
    expect(result.current.current).toBe(2);

    rerender({ s: stars.filter((s) => s.key !== "k3") });
    expect(result.current.current).toBeNull();
  });
});

describe("useStableStarred", () => {
  it("keeps the previous array while the contents are the same, and takes a changed one", () => {
    const first = [{ index: 1, key: "a" }];
    const { result, rerender } = renderHook(({ s }) => useStableStarred(s), { initialProps: { s: first } });
    rerender({ s: [{ index: 1, key: "a" }] });
    expect(result.current).toBe(first);
    const moved = [{ index: 2, key: "a" }];
    rerender({ s: moved });
    expect(result.current).toBe(moved);
  });
});

describe("StarredMessageNavigator", () => {
  const props = { canPrev: true, canNext: true, onPrev: vi.fn(), onNext: vi.fn() };

  it("renders nothing when no message is starred", () => {
    const { container } = render(<StarredMessageNavigator {...props} count={0} current={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows the position, and a dash before the first jump", () => {
    const { rerender } = render(<StarredMessageNavigator {...props} count={5} current={null} />);
    expect(screen.getByTestId("starred-position").textContent).toBe("– / 5");
    rerender(<StarredMessageNavigator {...props} count={5} current={1} />);
    expect(screen.getByTestId("starred-position").textContent).toBe("2 / 5");
    expect(screen.getByTestId("starred-position").getAttribute("aria-live")).toBe("polite");
  });

  it("wires the arrows, and disables them at the ends", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(<StarredMessageNavigator count={3} current={1} canPrev canNext onPrev={onPrev} onNext={onNext} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous starred message" }));
    fireEvent.click(screen.getByRole("button", { name: "Next starred message" }));
    expect(onPrev).toHaveBeenCalledTimes(1);
    expect(onNext).toHaveBeenCalledTimes(1);

    rerender(<StarredMessageNavigator count={3} current={0} canPrev={false} canNext onPrev={onPrev} onNext={onNext} />);
    expect((screen.getByRole("button", { name: "Previous starred message" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
