import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import ImageLightbox, { type LightboxItem } from "./ImageLightbox";

afterEach(cleanup);

const ITEMS: LightboxItem[] = [
  { src: "/a.png", alt: "Alpha" },
  { src: "/b.png", alt: "Bravo", caption: "Second picture" },
  { src: "/c.png", alt: "Charlie" },
];

/**
 * jsdom has no layout: every size is 0, which pins `clampPan` to 0 and would
 * let a broken pan pass. Give the surface a 400×800 phone viewport at the
 * origin and every image a 400×300 fitted size, so at 2.5× the image is
 * 1000×750 — 300px of pan room each side horizontally, none vertically.
 */
const VIEW = { width: 400, height: 800 };
const IMG = { width: 400, height: 300 };

function stubLayout() {
  const s = surface();
  Object.defineProperty(s, "clientWidth", { configurable: true, value: VIEW.width });
  Object.defineProperty(s, "clientHeight", { configurable: true, value: VIEW.height });
  s.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: VIEW.width,
    bottom: VIEW.height,
    width: VIEW.width,
    height: VIEW.height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  for (const img of document.querySelectorAll("[role=dialog] img")) {
    Object.defineProperty(img, "offsetWidth", { configurable: true, value: IMG.width });
    Object.defineProperty(img, "offsetHeight", { configurable: true, value: IMG.height });
  }
}

function renderLightbox(startIndex = 0, items = ITEMS) {
  const onClose = vi.fn();
  const utils = render(<ImageLightbox items={items} startIndex={startIndex} onClose={onClose} />);
  stubLayout();
  return { onClose, ...utils };
}

const surface = () => screen.getByTestId("lightbox-surface");
const strip = () => surface().firstElementChild as HTMLElement;
const CENTRE = { x: VIEW.width / 2, y: VIEW.height / 2 };

/** A one-finger drag across the surface, from `from` to `to` in steps. */
function drag(from: { x: number; y: number }, to: { x: number; y: number }, target: Element = surface()) {
  const id = 1;
  fireEvent.pointerDown(target, { pointerId: id, pointerType: "touch", clientX: from.x, clientY: from.y });
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    fireEvent.pointerMove(surface(), {
      pointerId: id,
      pointerType: "touch",
      clientX: from.x + ((to.x - from.x) * i) / steps,
      clientY: from.y + ((to.y - from.y) * i) / steps,
    });
  }
  fireEvent.pointerUp(surface(), { pointerId: id, pointerType: "touch", clientX: to.x, clientY: to.y });
}

/** A tap as the browser delivers it: pointerdown, pointerup, then the click. */
function tap(target: Element, at = { x: 100, y: 100 }) {
  fireEvent.pointerDown(target, { pointerId: 1, pointerType: "touch", clientX: at.x, clientY: at.y });
  fireEvent.pointerUp(surface(), { pointerId: 1, pointerType: "touch", clientX: at.x, clientY: at.y });
  fireEvent.click(target);
}

const down = (target: Element, id: number, x: number, y: number) =>
  fireEvent.pointerDown(target, { pointerId: id, pointerType: "touch", clientX: x, clientY: y });
const move = (id: number, x: number, y: number) => fireEvent.pointerMove(surface(), { pointerId: id, pointerType: "touch", clientX: x, clientY: y });
const up = (id: number, x: number, y: number) => fireEvent.pointerUp(surface(), { pointerId: id, pointerType: "touch", clientX: x, clientY: y });

const currentImage = (alt: string) => screen.getByAltText(alt);

describe("ImageLightbox", () => {
  it("guards that the PointerEvent shim carries coordinates", () => {
    // Without the shim in vitest.setup.frontend.ts every clientX below would be
    // undefined and the swipe tests would pass or fail for the wrong reason.
    const e = new PointerEvent("pointerdown", { clientX: 42, pointerId: 7 });
    expect(e.clientX).toBe(42);
    expect(e.pointerId).toBe(7);
  });

  it("opens at the start index and shows a counter", () => {
    renderLightbox(1);
    expect(screen.getByText("2 / 3")).toBeTruthy();
    expect(screen.getByText("Image 2 of 3")).toBeTruthy();
    expect(screen.getByText("Second picture")).toBeTruthy();
  });

  it("mounts only the current image and its neighbours", () => {
    renderLightbox(0);
    expect(screen.queryByAltText("Alpha")).toBeTruthy();
    expect(screen.queryByAltText("Bravo")).toBeTruthy();
    expect(screen.queryByAltText("Charlie")).toBeNull();
  });

  it("moves with the next/previous buttons and stops at either end", () => {
    renderLightbox(0);
    const prev = screen.getByRole("button", { name: "Previous image" }) as HTMLButtonElement;
    const next = screen.getByRole("button", { name: "Next image" }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);

    fireEvent.click(next);
    expect(screen.getByText("2 / 3")).toBeTruthy();
    fireEvent.click(next);
    expect(screen.getByText("3 / 3")).toBeTruthy();
    expect(next.disabled).toBe(true);
    fireEvent.click(next);
    expect(screen.getByText("3 / 3")).toBeTruthy();

    fireEvent.click(prev);
    expect(screen.getByText("2 / 3")).toBeTruthy();
  });

  it("moves with the arrow keys without wrapping", () => {
    renderLightbox(0);
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.getByText("2 / 3")).toBeTruthy();
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.getByText("3 / 3")).toBeTruthy();
  });

  it("keeps the arrow keys and Escape from reaching the page behind", () => {
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      const { onClose } = renderLightbox(0);
      fireEvent.keyDown(document, { key: "ArrowRight" });
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(behind).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });

  it("hides the navigation and counter for a single image", () => {
    renderLightbox(0, [ITEMS[0]]);
    expect(screen.queryByRole("button", { name: "Next image" })).toBeNull();
    expect(screen.queryByText("1 / 1")).toBeNull();
  });

  it("closes on Escape and the close button", () => {
    const { onClose } = renderLightbox(0);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close image viewer" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes on a tap on the backdrop but not on the image", () => {
    const { onClose } = renderLightbox(0);
    tap(currentImage("Alpha"));
    expect(onClose).not.toHaveBeenCalled();
    tap(surface());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes a backdrop tap on its click, not on pointerup", () => {
    // Unmounting on pointerup would let iOS deliver the tap's click to
    // whatever sits under the viewer.
    const { onClose } = renderLightbox(0);
    down(surface(), 1, 100, 100);
    up(1, 100, 100);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(surface());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a click with no backdrop tap before it does not close", () => {
    const { onClose } = renderLightbox(0);
    // A swipe ends without a tap, so a stray click after it is ignored.
    drag({ x: 300, y: 200 }, { x: 286, y: 200 });
    fireEvent.click(surface());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("swipes left to the next image and right back", () => {
    renderLightbox(0);
    drag({ x: 300, y: 200 }, { x: 100, y: 205 });
    expect(screen.getByText("2 / 3")).toBeTruthy();
    drag({ x: 100, y: 200 }, { x: 300, y: 200 });
    expect(screen.getByText("1 / 3")).toBeTruthy();
  });

  it("does not swipe past the first image", () => {
    renderLightbox(0);
    drag({ x: 100, y: 200 }, { x: 300, y: 200 });
    expect(screen.getByText("1 / 3")).toBeTruthy();
  });

  it("a short drag snaps back instead of changing image", () => {
    renderLightbox(0);
    // Past the axis-lock slop but short of both the distance and the flick
    // minimum — jsdom's event timestamps are sub-millisecond apart, so any drag
    // past the flick minimum would read as a fast flick here.
    drag({ x: 300, y: 200 }, { x: 286, y: 200 });
    expect(screen.getByText("1 / 3")).toBeTruthy();
  });

  it("swipes down to close", () => {
    const { onClose } = renderLightbox(0);
    drag({ x: 200, y: 100 }, { x: 205, y: 400 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("double-tap zooms in, and while zoomed a drag pans instead of changing image", () => {
    renderLightbox(0);
    const img = currentImage("Alpha");
    tap(img, CENTRE);
    tap(img, CENTRE);
    expect(img.style.transform).toBe("translate3d(0px, 0px, 0) scale(2.5)");

    drag({ x: 300, y: 400 }, { x: 100, y: 400 }, img);
    expect(screen.getByText("1 / 3")).toBeTruthy();
    // Panned 200px left; vertically the 750px-tall image fits, so it stays centred.
    expect(img.style.transform).toBe("translate3d(-200px, 0px, 0) scale(2.5)");

    // Further than the image's edge allows: clamped at 300px.
    drag({ x: 300, y: 400 }, { x: -200, y: 500 }, img);
    expect(img.style.transform).toBe("translate3d(-300px, 0px, 0) scale(2.5)");

    // A second double-tap returns to 1×, and swiping works again.
    tap(img, CENTRE);
    tap(img, CENTRE);
    expect(img.style.transform).toContain("scale(1)");
    drag({ x: 300, y: 200 }, { x: 100, y: 200 });
    expect(screen.getByText("2 / 3")).toBeTruthy();
  });

  it("pinches to zoom with two pointers, clamped to 4×", () => {
    renderLightbox(0);
    const img = currentImage("Alpha");
    fireEvent.pointerDown(img, { pointerId: 1, pointerType: "touch", clientX: 150, clientY: 200 });
    fireEvent.pointerDown(img, { pointerId: 2, pointerType: "touch", clientX: 250, clientY: 200 });
    fireEvent.pointerMove(surface(), { pointerId: 2, pointerType: "touch", clientX: 350, clientY: 200 });
    // Distance 100 → 200: 2×.
    expect(img.style.transform).toContain("scale(2)");
    fireEvent.pointerMove(surface(), { pointerId: 2, pointerType: "touch", clientX: 2000, clientY: 200 });
    expect(img.style.transform).toContain("scale(4)");
    fireEvent.pointerUp(surface(), { pointerId: 2, pointerType: "touch", clientX: 2000, clientY: 200 });
    fireEvent.pointerUp(surface(), { pointerId: 1, pointerType: "touch", clientX: 150, clientY: 200 });
    expect(screen.getByText("1 / 3")).toBeTruthy();
  });

  it("pinches about the fingers' midpoint", () => {
    renderLightbox(0);
    const img = currentImage("Alpha");
    // Midpoint (300, 400) is 100px right of centre; 100px apart → 200px: 2×.
    down(img, 1, 250, 400);
    down(img, 2, 350, 400);
    move(1, 200, 400);
    move(2, 400, 400);
    // The image point under the midpoint stays put: x = 100 - 2 × 100 = -100.
    expect(img.style.transform).toBe("translate3d(-100px, 0px, 0) scale(2)");
  });

  it("a pinch that starts mid-swipe snaps the strip back", () => {
    renderLightbox(0);
    down(surface(), 1, 300, 200);
    move(1, 150, 200);
    expect(strip().style.transform).toBe("translate3d(calc(0% + -150px), 0, 0)");
    down(surface(), 2, 250, 300);
    expect(strip().style.transform).toBe("translate3d(calc(0% + 0px), 0, 0)");
    up(1, 100, 200);
    up(2, 250, 300);
    expect(screen.getByText("1 / 3")).toBeTruthy();
  });

  it("releasing a pinch that began on the backdrop does not close", () => {
    const { onClose } = renderLightbox(0);
    down(surface(), 1, 20, 60);
    down(currentImage("Alpha"), 2, 200, 400);
    move(2, 260, 460);
    up(2, 260, 460);
    up(1, 20, 60);
    fireEvent.click(surface());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a pinch is never the first tap of a double-tap", () => {
    renderLightbox(0);
    const img = currentImage("Alpha");
    down(img, 1, 150, 400);
    down(img, 2, 250, 400);
    move(2, 350, 400);
    up(2, 350, 400);
    up(1, 150, 400);
    const zoomed = img.style.transform;
    expect(zoomed).toContain("scale(2)");
    // One quick tap near where the last finger lifted: still zoomed.
    tap(img, { x: 150, y: 400 });
    expect(img.style.transform).toBe(zoomed);
  });

  it("re-measures the pinch when a third finger lifts, so the zoom does not jump", () => {
    renderLightbox(0);
    const img = currentImage("Alpha");
    down(img, 1, 100, 400);
    down(img, 2, 300, 400);
    down(img, 3, 200, 420);
    // The pinch is fingers 1 and 2 (200px apart). Lift 1: the pair is now 2
    // and 3, about 100px apart — with the old distance the scale would drop
    // to 0.5× (clamped to 1); measured afresh, nothing moves.
    up(1, 100, 400);
    move(3, 200, 420);
    expect(img.style.transform).toBe("translate3d(0px, 0px, 0) scale(1)");
    // And the new pair zooms from its own distance: 2→3 spread doubles → 2×.
    const before = Math.hypot(300 - 200, 400 - 420);
    move(3, 300 - 2 * (300 - 200), 400 - 2 * (400 - 420));
    expect(before).toBeCloseTo(102, 0);
    expect(img.style.transform).toContain("scale(2)");
  });

  it("resets zoom when the image changes", () => {
    renderLightbox(0);
    const img = currentImage("Alpha");
    tap(img);
    tap(img);
    expect(img.style.transform).toContain("scale(2.5)");
    fireEvent.keyDown(document, { key: "ArrowRight" });
    fireEvent.keyDown(document, { key: "ArrowLeft" });
    expect(currentImage("Alpha").style.transform).toContain("scale(1)");
  });

  it("a cancelled pointer does not navigate", () => {
    renderLightbox(0);
    fireEvent.pointerDown(surface(), { pointerId: 1, pointerType: "touch", clientX: 300, clientY: 200 });
    fireEvent.pointerMove(surface(), { pointerId: 1, pointerType: "touch", clientX: 50, clientY: 200 });
    fireEvent.pointerCancel(surface(), { pointerId: 1, pointerType: "touch", clientX: 50, clientY: 200 });
    expect(screen.getByText("1 / 3")).toBeTruthy();
  });

  it("does not leak pointer or click events to the component that opened it", () => {
    const outer = vi.fn();
    render(
      <div onClick={outer} onPointerDown={outer}>
        <ImageLightbox items={ITEMS} startIndex={0} onClose={() => {}} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next image" }));
    tap(surface());
    expect(outer).not.toHaveBeenCalled();
  });

  it("is a modal dialog that focuses its close button and restores focus on close", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>thumb</button>
          {open && <ImageLightbox items={ITEMS} startIndex={0} onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<Harness />);
    const thumb = screen.getByRole("button", { name: "thumb" });
    thumb.focus();
    fireEvent.click(thumb);

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close image viewer" }));

    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(thumb);
  });

  it("keeps Tab inside the dialog", () => {
    renderLightbox(1);
    const close = screen.getByRole("button", { name: "Close image viewer" });
    const next = screen.getByRole("button", { name: "Next image" });
    next.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(next);
  });

  it("leaves modified arrow keys and Escape to the browser", () => {
    const { onClose } = renderLightbox(0);
    fireEvent.keyDown(document, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(document, { key: "ArrowRight", metaKey: true });
    fireEvent.keyDown(document, { key: "Escape", ctrlKey: true });
    expect(screen.getByText("1 / 3")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clamps the index when the list shrinks under it", () => {
    const onClose = vi.fn();
    const { rerender } = render(<ImageLightbox items={ITEMS} startIndex={2} onClose={onClose} />);
    expect(screen.getByText("3 / 3")).toBeTruthy();
    rerender(<ImageLightbox items={ITEMS.slice(0, 2)} startIndex={2} onClose={onClose} />);
    expect(screen.getByText("2 / 2")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next image" }) as HTMLButtonElement).disabled).toBe(true);
    expect(strip().style.transform).toBe("translate3d(calc(-100% + 0px), 0, 0)");
    fireEvent.click(screen.getByRole("button", { name: "Previous image" }));
    expect(screen.getByText("1 / 2")).toBeTruthy();
  });

  it("does not jump back to the old index when the list shrinks and grows again", () => {
    const onClose = vi.fn();
    const { rerender } = render(<ImageLightbox items={ITEMS} startIndex={2} onClose={onClose} />);
    rerender(<ImageLightbox items={ITEMS.slice(0, 2)} startIndex={2} onClose={onClose} />);
    expect(screen.getByText("2 / 2")).toBeTruthy();
    rerender(<ImageLightbox items={ITEMS} startIndex={2} onClose={onClose} />);
    expect(screen.getByText("2 / 3")).toBeTruthy();
  });

  it("a pointer whose capture is lost without a pointerup cannot wedge later gestures", () => {
    renderLightbox(0);
    const img = currentImage("Alpha");
    // A pinch whose pointers never get a pointerup or pointercancel.
    down(img, 5, 150, 400);
    down(img, 6, 250, 400);
    fireEvent.lostPointerCapture(surface(), { pointerId: 5, pointerType: "touch" });
    fireEvent.lostPointerCapture(surface(), { pointerId: 6, pointerType: "touch" });
    // A later one-finger swipe is a swipe, not the third finger of a pinch.
    drag({ x: 300, y: 200 }, { x: 100, y: 200 });
    expect(screen.getByText("2 / 3")).toBeTruthy();
  });

  it("a primary pointerdown drops pointers that leaked from an earlier sequence", () => {
    renderLightbox(0);
    const img = currentImage("Alpha");
    down(img, 5, 150, 400);
    down(img, 6, 250, 400);
    // No up, cancel or lost capture for 5 and 6. The next touch sequence
    // starts with a primary pointer.
    fireEvent.pointerDown(surface(), { pointerId: 7, pointerType: "touch", clientX: 300, clientY: 200, isPrimary: true });
    move(7, 200, 200);
    move(7, 100, 200);
    up(7, 100, 200);
    expect(screen.getByText("2 / 3")).toBeTruthy();
  });

  it("sits above other layers and owns every touch on the dialog", () => {
    renderLightbox(0);
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.touchAction).toBe("none");
    expect(Number((dialog.parentElement as HTMLElement).style.zIndex)).toBeGreaterThan(1000);
  });
});
