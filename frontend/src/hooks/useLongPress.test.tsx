/**
 * The gesture that opens multi-select on touch.
 *
 * Every coordinate assertion here depends on `vitest.setup.frontend.ts`
 * supplying a `PointerEvent` — jsdom 25 has none, and without the shim
 * `e.clientX` arrives as `undefined`, which makes `NaN > tolerance` false and
 * turns "small movement does NOT cancel" green for a reason that has nothing
 * to do with the threshold. The first test exists to fail loudly if the shim
 * ever stops being loaded, so the rest cannot quietly become theatre.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, cleanup } from "@testing-library/react";
import { useLongPress } from "./useLongPress";

function Harness(props: { onLongPress: () => void; delayMs?: number; moveTolerance?: number; onSeen?: (e: React.PointerEvent) => void }) {
  const { handlers } = useLongPress({ onLongPress: props.onLongPress, delayMs: props.delayMs, moveTolerance: props.moveTolerance });
  return (
    <div
      data-testid="target"
      {...handlers}
      onPointerDown={(e) => {
        props.onSeen?.(e);
        handlers.onPointerDown(e);
      }}
    />
  );
}

function setup(props: Partial<React.ComponentProps<typeof Harness>> = {}) {
  const onLongPress = props.onLongPress ?? vi.fn();
  const utils = render(<Harness {...props} onLongPress={onLongPress} />);
  return { onLongPress, el: utils.getByTestId("target"), utils };
}

/** Hold a touch pointer past the delay. */
function holdTouch(el: HTMLElement, ms: number, pointerType = "touch") {
  fireEvent.pointerDown(el, { pointerType, clientX: 10, clientY: 20 });
  act(() => void vi.advanceTimersByTime(ms));
}

beforeEach(() => vi.useFakeTimers());
// The project runs without vitest `globals`, so testing-library's automatic
// cleanup never registers — every suite unmounts by hand.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the PointerEvent shim these tests stand on", () => {
  it("delivers pointerType and coordinates to the handler", () => {
    const seen = vi.fn();
    const { el } = setup({ onSeen: seen });
    fireEvent.pointerDown(el, { pointerType: "touch", clientX: 10, clientY: 20 });

    expect(seen).toHaveBeenCalled();
    const e = seen.mock.calls[0][0];
    // If these are undefined, every threshold assertion below is a false green.
    expect(e.pointerType).toBe("touch");
    expect(e.clientX).toBe(10);
    expect(e.clientY).toBe(20);
  });
});

describe("holding a touch pointer", () => {
  it("fires once the delay elapses", () => {
    const { onLongPress, el } = setup();
    holdTouch(el, 499);
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("honours a custom delay", () => {
    const { onLongPress, el } = setup({ delayMs: 900 });
    holdTouch(el, 500);
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(400));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});

describe("what abandons the press", () => {
  it("lifting the finger before the delay", () => {
    const { onLongPress, el } = setup();
    holdTouch(el, 300);
    fireEvent.pointerUp(el);
    act(() => void vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("pointercancel — the browser saying the gesture became a scroll", () => {
    const { onLongPress, el } = setup();
    holdTouch(el, 300);
    fireEvent.pointerCancel(el);
    act(() => void vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("the pointer leaving the element", () => {
    const { onLongPress, el } = setup();
    holdTouch(el, 300);
    fireEvent.pointerLeave(el);
    act(() => void vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("movement past the tolerance", () => {
    const { onLongPress, el } = setup();
    holdTouch(el, 100);
    fireEvent.pointerMove(el, { pointerType: "touch", clientX: 10 + 11, clientY: 20 });
    act(() => void vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("movement past the tolerance on the other axis", () => {
    const { onLongPress, el } = setup();
    holdTouch(el, 100);
    fireEvent.pointerMove(el, { pointerType: "touch", clientX: 10, clientY: 20 + 11 });
    act(() => void vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("but NOT the finger-jitter every real touch carries", () => {
    const { onLongPress, el } = setup();
    holdTouch(el, 100);
    fireEvent.pointerMove(el, { pointerType: "touch", clientX: 10 + 9, clientY: 20 + 9 });
    act(() => void vi.advanceTimersByTime(500));
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("unmounting, rather than firing against a gone tree", () => {
    const { onLongPress, el, utils } = setup();
    holdTouch(el, 100);
    utils.unmount();
    act(() => void vi.advanceTimersByTime(500));
    expect(onLongPress).not.toHaveBeenCalled();
  });
});

describe("the mouse gate — the whole of the desktop decision", () => {
  it("does not fire for a held MOUSE pointer, however long it is held", () => {
    const { onLongPress, el } = setup();
    holdTouch(el, 5000, "mouse");
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("fires for a held TOUCH pointer over the same interval", () => {
    const { onLongPress, el } = setup();
    holdTouch(el, 5000, "touch");
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});

describe("the click a gesture leaves behind", () => {
  /**
   * The pressable element with a child that owns its own gesture — a card
   * row's expansion chevron, a folder entry. The child stops `pointerdown`
   * bubbling so a held finger on it does not also enter selection mode.
   */
  function Nested(props: { onLongPress: () => void; onChildClick: (suppressed: boolean) => void }) {
    const { handlers, consumeClickSuppression } = useLongPress({ onLongPress: props.onLongPress });
    return (
      <div data-testid="outer" {...handlers}>
        <button
          data-testid="child"
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          onClick={() => props.onChildClick(consumeClickSuppression())}
        />
      </div>
    );
  }

  it("is consumed once, then gone", () => {
    const seen: boolean[] = [];
    const { getByTestId } = render(<Nested onLongPress={vi.fn()} onChildClick={(s) => seen.push(s)} />);
    fireEvent.contextMenu(getByTestId("outer"));

    // Without any pointerdown in between, the flag is the gesture's own
    // trailing click and belongs to whoever asks first.
    fireEvent.click(getByTestId("child"));
    fireEvent.click(getByTestId("child"));
    expect(seen).toEqual([true, false]);
  });

  it("is cleared by a pointerdown the pressable element never sees", () => {
    const seen: boolean[] = [];
    const { getByTestId } = render(<Nested onLongPress={vi.fn()} onChildClick={(s) => seen.push(s)} />);

    // Right-click the row: the flag is set and selection mode opens.
    fireEvent.contextMenu(getByTestId("outer"));
    // Now press the child. Its guard stops the bubble, so the hook's own
    // `onPointerDown` never runs — and the reset used to live there, which
    // left the flag standing to swallow the click below.
    fireEvent.pointerDown(getByTestId("child"), { pointerType: "mouse" });
    fireEvent.pointerUp(getByTestId("child"));
    fireEvent.click(getByTestId("child"));
    expect(seen).toEqual([false]);
  });
});

describe("contextmenu", () => {
  it("fires immediately, without waiting out the delay", () => {
    const { onLongPress, el } = setup();
    fireEvent.contextMenu(el);
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("preventDefaults, so the browser's own menu does not cover ours", () => {
    const { el } = setup();
    // fireEvent returns false when the dispatched event was defaultPrevented.
    expect(fireEvent.contextMenu(el)).toBe(false);
  });
});
