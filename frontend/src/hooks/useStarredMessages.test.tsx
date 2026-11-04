// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StarredMessageNavigator from "../components/StarredMessageNavigator";
import type { StarredMessage } from "../utils/starredMessages";

const setMessageStarred = vi.fn();
vi.mock("../api", () => ({ setMessageStarred: (...args: unknown[]) => setMessageStarred(...args) }));

const { useStarredMessages, useStarredNavigation } = await import("./useStarredMessages");

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

describe("useStarredMessages", () => {
  it("starts from the server's list and follows a refetched one", () => {
    const { result, rerender } = renderHook(({ stars }) => useStarredMessages("c1", stars), { initialProps: { stars: ["a"] as string[] | undefined } });
    expect([...result.current.starredKeys]).toEqual(["a"]);
    rerender({ stars: ["a", "b"] });
    expect([...result.current.starredKeys]).toEqual(["a", "b"]);
  });

  it("applies a toggle optimistically, then adopts the server's answer", async () => {
    let resolve!: (v: { starredMessages: string[] }) => void;
    setMessageStarred.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result } = renderHook(() => useStarredMessages("c1", undefined));

    act(() => result.current.toggleStar("a", true));
    expect(setMessageStarred).toHaveBeenCalledWith("c1", "a", true);
    expect(result.current.starredKeys.has("a")).toBe(true);

    // Another tab starred "z" meanwhile; the response carries it.
    await act(async () => resolve({ starredMessages: ["z", "a"] }));
    expect([...result.current.starredKeys]).toEqual(["z", "a"]);
  });

  it("ignores a refetched record while a toggle is in flight", async () => {
    let resolve!: (v: { starredMessages: string[] }) => void;
    setMessageStarred.mockReturnValue(new Promise((r) => (resolve = r)));
    const { result, rerender } = renderHook(({ stars }) => useStarredMessages("c1", stars), { initialProps: { stars: [] as string[] } });

    act(() => result.current.toggleStar("a", true));
    // A record read before the write landed must not flick the star off.
    rerender({ stars: [] });
    expect(result.current.starredKeys.has("a")).toBe(true);

    await act(async () => resolve({ starredMessages: ["a"] }));
    expect(result.current.starredKeys.has("a")).toBe(true);
  });

  it("undoes the toggle when the write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setMessageStarred.mockRejectedValue(new Error("nope"));
    const { result } = renderHook(() => useStarredMessages("c1", ["a"]));
    await act(async () => result.current.toggleStar("a", false));
    expect(result.current.starredKeys.has("a")).toBe(true);
  });
});

describe("useStarredNavigation", () => {
  const latch = () => ({ unlatch: vi.fn(), suppressRelatchRef: { current: false } });
  const stars: StarredMessage[] = [
    { index: 1, key: "k1" },
    { index: 3, key: "k3" },
    { index: 5, key: "k5" },
  ];

  it("walks down and up through the stars, stopping at the ends", () => {
    const container = transcript(6);
    const l = latch();
    const { result } = renderHook(() => useStarredNavigation(stars, { current: container }, l));
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

  it("starts 'up' from the newest star", () => {
    const { result } = renderHook(() => useStarredNavigation(stars, { current: transcript(6) }, latch()));
    act(() => result.current.goPrev());
    expect(result.current.current).toBe(2);
  });

  it("falls back to the scroll position before the first jump", () => {
    const container = transcript(6);
    // Viewport 0-100 (middle 50); rows 1, 3, 5 centred at 10, 60, 210.
    container.getBoundingClientRect = () => ({ top: 0, height: 100 }) as DOMRect;
    const centres: Record<number, number> = { 1: 10, 3: 60, 5: 210 };
    for (const [i, c] of Object.entries(centres)) row(container, Number(i)).getBoundingClientRect = () => ({ top: c - 5, height: 10 }) as DOMRect;

    const down = renderHook(() => useStarredNavigation(stars, { current: container }, latch()));
    act(() => down.result.current.goNext());
    expect(down.result.current.current).toBe(1);

    const up = renderHook(() => useStarredNavigation(stars, { current: container }, latch()));
    act(() => up.result.current.goPrev());
    expect(up.result.current.current).toBe(0);
  });

  it("keeps its place by key as stars change around it, and lets go when its star is removed", () => {
    const { result, rerender } = renderHook(({ s }) => useStarredNavigation(s, { current: transcript(8) }, latch()), { initialProps: { s: stars } });
    act(() => result.current.goNext());
    act(() => result.current.goNext());
    expect(result.current.current).toBe(1);

    rerender({ s: [{ index: 0, key: "k0" }, ...stars] });
    expect(result.current.current).toBe(2);

    rerender({ s: stars.filter((s) => s.key !== "k3") });
    expect(result.current.current).toBeNull();
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
