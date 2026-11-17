import { describe, expect, it } from "vitest";
import { clampPan, clampScale, decideSwipe, IDENTITY, isDoubleTap, lockAxis, pinchState, zoomAboutPoint, type SwipeInput } from "./gestureMath";

const VIEWPORT = { width: 400, height: 800 };

function swipe(overrides: Partial<SwipeInput>): SwipeInput {
  return { dx: 0, dy: 0, vx: 0, vy: 0, axis: "x", viewport: VIEWPORT, hasPrev: true, hasNext: true, ...overrides };
}

describe("clampScale", () => {
  it("keeps the scale within 1–4", () => {
    expect(clampScale(0.5)).toBe(1);
    expect(clampScale(2)).toBe(2);
    expect(clampScale(9)).toBe(4);
  });

  it("treats a non-finite scale as the minimum", () => {
    expect(clampScale(NaN)).toBe(1);
    expect(clampScale(Infinity)).toBe(1);
  });
});

describe("zoomAboutPoint", () => {
  it("keeps the image point under the origin fixed on screen", () => {
    const start = { scale: 1.5, x: 20, y: -10 };
    const origin = { x: 60, y: 30 };
    // The image-space point currently under the origin.
    const local = { x: (origin.x - start.x) / start.scale, y: (origin.y - start.y) / start.scale };

    const next = zoomAboutPoint(start, 3, origin);

    expect(next.scale).toBe(3);
    expect(next.x + next.scale * local.x).toBeCloseTo(origin.x);
    expect(next.y + next.scale * local.y).toBeCloseTo(origin.y);
  });

  it("zooming about the centre does not pan", () => {
    expect(zoomAboutPoint(IDENTITY, 2, { x: 0, y: 0 })).toEqual({ scale: 2, x: 0, y: 0 });
  });

  it("zooming back to 1× about the same point returns to identity", () => {
    const zoomed = zoomAboutPoint(IDENTITY, 2.5, { x: 100, y: -40 });
    const back = zoomAboutPoint(zoomed, 1, { x: 100, y: -40 });
    expect(back.scale).toBe(1);
    expect(back.x).toBeCloseTo(0);
    expect(back.y).toBeCloseTo(0);
  });
});

describe("clampPan", () => {
  const image = { width: 400, height: 300 };

  it("holds the image centred at 1×", () => {
    expect(clampPan({ scale: 1, x: 120, y: -80 }, image, VIEWPORT)).toEqual({ x: 0, y: 0 });
  });

  it("allows panning up to the image edge once it overflows", () => {
    // 400×300 at 2× is 800×600: 200px spare each side horizontally, none vertically (600 < 800).
    expect(clampPan({ scale: 2, x: 500, y: 90 }, image, VIEWPORT)).toEqual({ x: 200, y: 0 });
    expect(clampPan({ scale: 2, x: -500, y: 0 }, image, VIEWPORT)).toEqual({ x: -200, y: 0 });
  });

  it("leaves an in-bounds pan alone", () => {
    expect(clampPan({ scale: 4, x: 150, y: -120 }, image, VIEWPORT)).toEqual({ x: 150, y: -120 });
  });
});

describe("pinchState", () => {
  it("returns the finger distance and midpoint", () => {
    expect(pinchState({ x: 0, y: 0 }, { x: 30, y: 40 })).toEqual({ dist: 50, mid: { x: 15, y: 20 } });
  });
});

describe("lockAxis", () => {
  it("stays unlocked within the tap slop", () => {
    expect(lockAxis(4, 5)).toBeNull();
  });

  it("locks to the dominant axis", () => {
    expect(lockAxis(30, 10)).toBe("x");
    expect(lockAxis(-8, 25)).toBe("y");
  });
});

describe("decideSwipe", () => {
  it("a slow drag past 25% of the width changes image", () => {
    expect(decideSwipe(swipe({ dx: -110 }))).toBe("next");
    expect(decideSwipe(swipe({ dx: 110 }))).toBe("prev");
  });

  it("a slow drag short of the threshold snaps back", () => {
    expect(decideSwipe(swipe({ dx: -90 }))).toBe("none");
  });

  it("a fast short flick changes image", () => {
    expect(decideSwipe(swipe({ dx: -30, vx: -0.9 }))).toBe("next");
    expect(decideSwipe(swipe({ dx: 30, vx: 0.9 }))).toBe("prev");
  });

  it("a fast flick that barely moved is not a swipe", () => {
    expect(decideSwipe(swipe({ dx: -6, vx: -2 }))).toBe("none");
  });

  it("follows the fling when it reverses the drag", () => {
    expect(decideSwipe(swipe({ dx: -120, vx: 0.8 }))).toBe("prev");
  });

  it("goes nowhere past either end of the gallery", () => {
    expect(decideSwipe(swipe({ dx: 200, hasPrev: false }))).toBe("none");
    expect(decideSwipe(swipe({ dx: -200, hasNext: false }))).toBe("none");
  });

  it("uses a minimum distance on a tiny viewport", () => {
    const tiny = { width: 0, height: 0 };
    expect(decideSwipe(swipe({ dx: -20, viewport: tiny }))).toBe("none");
    expect(decideSwipe(swipe({ dx: -60, viewport: tiny }))).toBe("next");
  });

  it("a vertical drag never changes image", () => {
    expect(decideSwipe(swipe({ axis: "y", dx: -300, dy: 20 }))).toBe("none");
  });

  it("a downward drag past 20% of the height closes", () => {
    expect(decideSwipe(swipe({ axis: "y", dy: 170 }))).toBe("close");
    expect(decideSwipe(swipe({ axis: "y", dy: 150 }))).toBe("none");
  });

  it("a fast downward flick closes; an upward one does not", () => {
    expect(decideSwipe(swipe({ axis: "y", dy: 40, vy: 1 }))).toBe("close");
    expect(decideSwipe(swipe({ axis: "y", dy: -300, vy: -1 }))).toBe("none");
  });
});

describe("isDoubleTap", () => {
  const first = { t: 1000, x: 50, y: 50 };

  it("needs a previous tap", () => {
    expect(isDoubleTap(null, first)).toBe(false);
  });

  it("accepts a second tap close in time and space", () => {
    expect(isDoubleTap(first, { t: 1200, x: 60, y: 55 })).toBe(true);
  });

  it("rejects a second tap that is too late", () => {
    expect(isDoubleTap(first, { t: 1400, x: 50, y: 50 })).toBe(false);
  });

  it("rejects a second tap that is too far away", () => {
    expect(isDoubleTap(first, { t: 1100, x: 100, y: 50 })).toBe(false);
  });

  it("rejects a tap that predates the previous one", () => {
    expect(isDoubleTap(first, { t: 900, x: 50, y: 50 })).toBe(false);
  });
});
