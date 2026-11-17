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

function renderLightbox(startIndex = 0, items = ITEMS) {
  const onClose = vi.fn();
  const utils = render(<ImageLightbox items={items} startIndex={startIndex} onClose={onClose} />);
  return { onClose, ...utils };
}

const surface = () => screen.getByTestId("lightbox-surface");

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

function tap(target: Element, at = { x: 100, y: 100 }) {
  fireEvent.pointerDown(target, { pointerId: 1, pointerType: "touch", clientX: at.x, clientY: at.y });
  fireEvent.pointerUp(surface(), { pointerId: 1, pointerType: "touch", clientX: at.x, clientY: at.y });
}

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
    tap(img);
    tap(img);
    expect(img.style.transform).toContain("scale(2.5)");

    drag({ x: 300, y: 200 }, { x: 100, y: 200 }, img);
    expect(screen.getByText("1 / 3")).toBeTruthy();

    // A second double-tap returns to 1×, and swiping works again.
    tap(img);
    tap(img);
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

  it("a pinch that starts mid-swipe cancels the swipe", () => {
    renderLightbox(0);
    fireEvent.pointerDown(surface(), { pointerId: 1, pointerType: "touch", clientX: 300, clientY: 200 });
    fireEvent.pointerMove(surface(), { pointerId: 1, pointerType: "touch", clientX: 150, clientY: 200 });
    fireEvent.pointerDown(surface(), { pointerId: 2, pointerType: "touch", clientX: 250, clientY: 300 });
    fireEvent.pointerUp(surface(), { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 200 });
    fireEvent.pointerUp(surface(), { pointerId: 2, pointerType: "touch", clientX: 250, clientY: 300 });
    expect(screen.getByText("1 / 3")).toBeTruthy();
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

  it("locks body scroll while open", () => {
    const { unmount } = renderLightbox(0);
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
