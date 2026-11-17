/**
 * Pure geometry for the image lightbox's gestures.
 *
 * Everything here is free of the DOM so the decisions — how far a zoom moves
 * the image, when a drag counts as a swipe, what a double-tap is — can be
 * tested directly rather than through simulated pointer streams.
 *
 * Coordinate system: points are measured from the CENTRE of the viewer
 * surface, and the image is laid out centred in that surface at its fitted
 * (scale 1) size. A `Transform` is applied as `translate(x, y) scale(scale)`
 * with `transform-origin: center`, so a point `p` on the unscaled image lands
 * on screen at `{ x: x + scale * p.x, y: y + scale * p.y }`.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Transform {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
/** The zoom a double-tap toggles to from 1×. */
export const DOUBLE_TAP_SCALE = 2.5;

export const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

export function clampScale(scale: number, min = MIN_SCALE, max = MAX_SCALE): number {
  if (!Number.isFinite(scale)) return min;
  return Math.min(max, Math.max(min, scale));
}

/**
 * Rescale to `nextScale` while keeping the image point currently under
 * `origin` exactly where it is on screen — the point between the fingers in a
 * pinch, the cursor for wheel zoom, the tap for a double-tap.
 */
export function zoomAboutPoint(t: Transform, nextScale: number, origin: Point): Transform {
  const ratio = nextScale / t.scale;
  return {
    scale: nextScale,
    x: origin.x - ratio * (origin.x - t.x),
    y: origin.y - ratio * (origin.y - t.y),
  };
}

/**
 * Limit the pan so the scaled image never leaves blank space on a side where
 * it overflows the viewport. On an axis where the scaled image fits, it is
 * held centred (offset 0).
 */
export function clampPan(t: Transform, imageSize: Size, viewport: Size): Point {
  const maxX = Math.max(0, (imageSize.width * t.scale - viewport.width) / 2);
  const maxY = Math.max(0, (imageSize.height * t.scale - viewport.height) / 2);
  return {
    x: clampSigned(t.x, maxX),
    y: clampSigned(t.y, maxY),
  };
}

function clampSigned(v: number, limit: number): number {
  // `+ 0` folds -0 into 0 so callers (and tests) never see a signed zero.
  return Math.min(limit, Math.max(-limit, v)) + 0;
}

/** Distance and midpoint of a two-finger pinch. */
export function pinchState(p1: Point, p2: Point): { dist: number; mid: Point } {
  return {
    dist: Math.hypot(p2.x - p1.x, p2.y - p1.y),
    mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
  };
}

/**
 * Movement (px) a single pointer must make before a drag is committed to an
 * axis. Below it, the gesture is still a tap.
 */
export const AXIS_LOCK_SLOP = 10;

/** Which axis a one-finger drag at 1× belongs to, or null while still within the tap slop. */
export function lockAxis(dx: number, dy: number, slop = AXIS_LOCK_SLOP): "x" | "y" | null {
  if (Math.hypot(dx, dy) < slop) return null;
  return Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
}

export interface SwipeInput {
  /** Total drag distance since the pointer went down. */
  dx: number;
  dy: number;
  /** Release velocity in px/ms. */
  vx: number;
  vy: number;
  /** The axis the drag was locked to. */
  axis: "x" | "y";
  viewport: Size;
  hasPrev: boolean;
  hasNext: boolean;
}

export type SwipeDecision = "prev" | "next" | "close" | "none";

/** Fraction of the viewport width a slow horizontal drag must cover to change image. */
export const SWIPE_DISTANCE_RATIO = 0.25;
/** Floor for that distance, so a tiny viewport doesn't make every nudge a swipe. */
export const SWIPE_MIN_DISTANCE = 48;
/** Release speed (px/ms) above which a short flick counts. */
export const SWIPE_FLICK_VELOCITY = 0.5;
/** A flick must still travel this far, so a jittery tap can't be read as one. */
export const SWIPE_FLICK_MIN_DISTANCE = 16;
/** Fraction of the viewport height a slow downward drag must cover to close. */
export const CLOSE_DISTANCE_RATIO = 0.2;

/** What a completed one-finger drag at 1× should do. */
export function decideSwipe(input: SwipeInput): SwipeDecision {
  const { dx, dy, vx, vy, axis, viewport, hasPrev, hasNext } = input;

  if (axis === "x") {
    const distance = Math.max(SWIPE_MIN_DISTANCE, viewport.width * SWIPE_DISTANCE_RATIO);
    const flick = Math.abs(vx) > SWIPE_FLICK_VELOCITY && Math.abs(dx) > SWIPE_FLICK_MIN_DISTANCE;
    // A flick against the drag (pulled left, then flung right) follows the
    // fling: that is the direction the finger was last moving.
    const direction = flick ? Math.sign(vx) : Math.abs(dx) > distance ? Math.sign(dx) : 0;
    if (direction < 0) return hasNext ? "next" : "none";
    if (direction > 0) return hasPrev ? "prev" : "none";
    return "none";
  }

  const distance = Math.max(SWIPE_MIN_DISTANCE, viewport.height * CLOSE_DISTANCE_RATIO);
  const flickDown = vy > SWIPE_FLICK_VELOCITY && dy > SWIPE_FLICK_MIN_DISTANCE;
  if (flickDown || dy > distance) return "close";
  return "none";
}

export interface Tap {
  /** Timestamp in ms. */
  t: number;
  x: number;
  y: number;
}

/** Whether `now` is the second tap of a double-tap following `prev`. */
export function isDoubleTap(prev: Tap | null, now: Tap, maxMs = 300, maxDist = 24): boolean {
  if (!prev) return false;
  const dt = now.t - prev.t;
  if (dt < 0 || dt > maxMs) return false;
  return Math.hypot(now.x - prev.x, now.y - prev.y) <= maxDist;
}

/**
 * Stretch an overscroll so the strip moves less than the finger past an end
 * of the gallery — the "rubber band" that tells the user there is nothing
 * further that way.
 */
export function rubberBand(overscroll: number, factor = 0.3): number {
  return overscroll * factor;
}
