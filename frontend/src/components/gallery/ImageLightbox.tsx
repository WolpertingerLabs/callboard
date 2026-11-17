import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributeReferrerPolicy,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import ModalOverlay from "../ModalOverlay";
import {
  AXIS_LOCK_SLOP,
  clampPan,
  clampScale,
  decideSwipe,
  DOUBLE_TAP_SCALE,
  IDENTITY,
  isDoubleTap,
  lockAxis,
  pinchState,
  rubberBand,
  zoomAboutPoint,
  type Point,
  type Size,
  type Tap,
  type Transform,
} from "./gestureMath";

export interface LightboxItem {
  src: string;
  alt: string;
  caption?: string;
  /** Passed through to the `<img>`; tool-rendered media sets `no-referrer`. */
  referrerPolicy?: HTMLAttributeReferrerPolicy;
}

interface ImageLightboxProps {
  items: LightboxItem[];
  startIndex: number;
  onClose: () => void;
}

/**
 * - `pending`: one pointer down at 1×, not yet past the tap slop.
 * - `swipe-x`: horizontal drag at 1× — moves the strip, may change image.
 * - `swipe-y`: vertical drag at 1× — moves the image, may close.
 * - `pan`: one pointer down while zoomed — moves the zoomed image.
 * - `pinch`: two pointers down — zooms about their midpoint.
 */
type Mode = "idle" | "pending" | "swipe-x" | "swipe-y" | "pan" | "pinch";

interface Gesture {
  mode: Mode;
  /** Client position of the pointer that started a one-finger gesture. */
  start: Point;
  startTransform: Transform;
  pinchDist: number;
  /** Pinch midpoint at its start, in surface-centred coordinates. */
  pinchMid: Point;
  last: Tap;
  /** Recent velocity, px/ms. */
  v: Point;
  /** Whether the gesture began on the current image (vs. the backdrop around it). */
  downOnImage: boolean;
  /**
   * Set once a second finger joins; cleared only when a new gesture starts
   * from no fingers. A gesture that was ever a pinch is never a tap — not for
   * closing on the backdrop, and not as the first half of a double-tap.
   */
  multiTouch: boolean;
}

/** Velocity is discarded if the finger rested this long (ms) before lifting. */
const VELOCITY_STALE_MS = 100;
const STRIP_TRANSITION = "transform 250ms ease-out";
const IMAGE_TRANSITION = "transform 200ms ease-out";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const stopPropagation = (e: SyntheticEvent) => e.stopPropagation();

/**
 * Full-screen image viewer with touch gestures.
 *
 * - Swipe left/right to move between `items`; prev/next buttons and arrow keys on desktop.
 * - Pinch to zoom (1–4×) about the fingers' midpoint; one finger pans while zoomed.
 * - Double-tap (or double-click) toggles 1× ↔ 2.5× at the tapped point; wheel zooms at the cursor.
 * - Swipe down at 1× closes; so do Escape, the × button and a tap on the backdrop.
 *
 * Gestures are hand-rolled on Pointer Events, with the geometry in
 * `gestureMath.ts`. Movement is written straight to `style.transform` on the
 * strip and the current image rather than through React state, so a drag
 * re-renders nothing; React state holds only the current index.
 *
 * Rendered through a portal so `position: fixed` escapes any transformed
 * ancestor, and every pointer/click event is stopped at the dialog so it
 * cannot reach handlers on the message bubble that opened it (React
 * propagates portal events through the component tree).
 */
export default function ImageLightbox({ items, startIndex, onClose }: ImageLightboxProps) {
  const count = items.length;
  const [rawIndex, setIndex] = useState(() => Math.max(0, startIndex));
  // `items` can shrink under an open viewer; every read goes through this
  // clamped value so the counter, the strip and prev/next never point past the end.
  const index = Math.min(rawIndex, Math.max(0, count - 1));
  // …and the state itself snaps to the clamp, so a list that shrinks and then
  // grows again stays where the user is instead of jumping back to the old
  // index. Adjusted during render (guarded, so it settles in one pass).
  if (rawIndex !== index) setIndex(index);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const imgEls = useRef(new Map<number, HTMLImageElement>());

  const indexRef = useRef(index);
  const transformRef = useRef<Transform>(IDENTITY);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>({
    mode: "idle",
    start: { x: 0, y: 0 },
    startTransform: IDENTITY,
    pinchDist: 0,
    pinchMid: { x: 0, y: 0 },
    last: { t: 0, x: 0, y: 0 },
    v: { x: 0, y: 0 },
    downOnImage: false,
    multiTouch: false,
  });
  /** A backdrop tap waiting for its click (see `onSurfaceClick`). */
  const closeOnClick = useRef(false);
  const lastTap = useRef<Tap | null>(null);
  const reducedMotion = useRef(prefersReducedMotion());
  const hasMounted = useRef(false);

  // Callers pass a fresh inline onClose every render; the listeners below read
  // it through a ref so they attach once per open.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  // ---- imperative style writers ---------------------------------------------

  const viewport = useCallback((): Size => {
    const s = surfaceRef.current;
    return { width: s?.clientWidth ?? 0, height: s?.clientHeight ?? 0 };
  }, []);

  const imageSize = useCallback((): Size => {
    const img = imgEls.current.get(indexRef.current);
    return { width: img?.offsetWidth ?? 0, height: img?.offsetHeight ?? 0 };
  }, []);

  /** Client coordinates → coordinates relative to the surface's centre. */
  const toSurface = useCallback((p: Point): Point => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return p;
    return { x: p.x - rect.left - rect.width / 2, y: p.y - rect.top - rect.height / 2 };
  }, []);

  const transition = (value: string, animate: boolean) => (animate && !reducedMotion.current ? value : "none");

  const writeImage = useCallback((t: Transform, animate: boolean) => {
    transformRef.current = t;
    const img = imgEls.current.get(indexRef.current);
    if (img) {
      img.style.transition = transition(IMAGE_TRANSITION, animate);
      img.style.transform = `translate3d(${t.x}px, ${t.y}px, 0) scale(${t.scale})`;
    }
    const surface = surfaceRef.current;
    if (surface) surface.style.cursor = t.scale > 1 ? "grab" : "default";
  }, []);

  const writeStrip = useCallback((offset: number, animate: boolean) => {
    const strip = stripRef.current;
    if (!strip) return;
    strip.style.transition = transition(STRIP_TRANSITION, animate);
    strip.style.transform = `translate3d(calc(${-indexRef.current * 100}% + ${offset}px), 0, 0)`;
  }, []);

  const writeBackdrop = useCallback((opacity: number) => {
    if (backdropRef.current) backdropRef.current.style.opacity = String(opacity);
  }, []);

  const snapBack = useCallback(() => {
    writeStrip(0, true);
    writeImage(transformRef.current.scale > 1 ? transformRef.current : IDENTITY, true);
    writeBackdrop(1);
  }, [writeBackdrop, writeImage, writeStrip]);

  // ---- navigation -------------------------------------------------------------

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => Math.min(count - 1, Math.max(0, Math.min(i, count - 1) + delta)));
    },
    [count],
  );

  // On every index change: reset zoom on all mounted images and slide the strip
  // to the new slot (animated from wherever a swipe left it, except on open).
  useLayoutEffect(() => {
    indexRef.current = index;
    transformRef.current = IDENTITY;
    lastTap.current = null;
    imgEls.current.forEach((img) => {
      img.style.transition = "none";
      img.style.transform = "";
    });
    writeStrip(0, hasMounted.current);
    writeBackdrop(1);
    writeImage(IDENTITY, false);
    hasMounted.current = true;
  }, [index, writeBackdrop, writeImage, writeStrip]);

  // ---- keyboard, focus, iOS gesture events -----------------------------------

  const goRef = useRef(go);
  useLayoutEffect(() => {
    goRef.current = go;
  });

  useEffect(() => {
    // Capture phase on document, and stopped once handled: while the viewer is
    // open it owns these keys — Escape must not also reach the chat, and the
    // arrows must not scroll the transcript behind it.
    const onKeyDown = (e: KeyboardEvent) => {
      // Alt+← is browser Back, Cmd+← / Ctrl+← are text and OS shortcuts —
      // leave every modified key to the browser.
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === "Escape") {
        onCloseRef.current();
      } else if (e.key === "ArrowLeft") {
        goRef.current(-1);
      } else if (e.key === "ArrowRight") {
        goRef.current(1);
      } else if (e.key === "Tab") {
        trapFocus(e, dialogRef.current);
        return;
      } else {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    closeButtonRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) previouslyFocused.focus();
    };
  }, []);

  useEffect(() => {
    // iOS Safari zooms the whole page on a pinch despite `user-scalable=no`
    // unless its proprietary gesture events are cancelled.
    const prevent = (e: Event) => e.preventDefault();
    const events = ["gesturestart", "gesturechange", "gestureend"];
    events.forEach((name) => document.addEventListener(name, prevent, { passive: false }));

    // `touch-action: none` on the dialog covers this everywhere else; the
    // non-passive touchmove is belt and braces for older iOS. Multi-finger
    // only: cancelling a one-finger touchmove can make iOS drop the click that
    // ends a slightly jittery tap, and the backdrop closes on that click.
    const dialog = dialogRef.current;
    const preventPinch = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    dialog?.addEventListener("touchmove", preventPinch, { passive: false });
    return () => {
      events.forEach((name) => document.removeEventListener(name, prevent));
      dialog?.removeEventListener("touchmove", preventPinch);
    };
  }, []);

  // ---- wheel zoom (non-passive so it can stop the page scrolling) -----------

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const t = transformRef.current;
      // Trackpad pinch arrives as ctrl+wheel with small deltas; a mouse wheel
      // without ctrl sends large ones.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      const scale = clampScale(t.scale * factor);
      if (scale === 1) {
        writeImage(IDENTITY, false);
        return;
      }
      const next = zoomAboutPoint(t, scale, toSurface({ x: e.clientX, y: e.clientY }));
      writeImage({ scale, ...clampPan(next, imageSize(), viewport()) }, false);
    };
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
  }, [imageSize, toSurface, viewport, writeImage]);

  // ---- pointer gestures -------------------------------------------------------

  const toggleZoom = (clientPoint: Point) => {
    if (transformRef.current.scale > 1) {
      writeImage(IDENTITY, true);
      return;
    }
    const next = zoomAboutPoint(IDENTITY, DOUBLE_TAP_SCALE, toSurface(clientPoint));
    writeImage({ scale: DOUBLE_TAP_SCALE, ...clampPan(next, imageSize(), viewport()) }, true);
  };

  const handleTap = (tap: Tap) => {
    if (!gesture.current.downOnImage) {
      // Don't close here: unmounting on pointerup leaves the click that
      // follows the tap with no overlay to land on, and iOS Safari hit-tests
      // it onto whatever is underneath — a link, a button, another thumbnail.
      // Close on that click instead, so the viewer itself absorbs it.
      closeOnClick.current = true;
      return;
    }
    if (isDoubleTap(lastTap.current, tap)) {
      lastTap.current = null;
      toggleZoom(tap);
    } else {
      lastTap.current = tap;
    }
  };

  const beginPinch = () => {
    const g = gesture.current;
    if (g.mode === "swipe-x" || g.mode === "swipe-y") snapBack();
    const [a, b] = [...pointers.current.values()].map(toSurface);
    const { dist, mid } = pinchState(a, b);
    g.mode = "pinch";
    g.multiTouch = true;
    lastTap.current = null;
    g.pinchDist = dist;
    g.pinchMid = mid;
    g.startTransform = transformRef.current;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // A primary pointer starts a fresh sequence: no other pointer can be down,
    // so anything still in the map leaked (an up or cancel the browser never
    // delivered). Drop it rather than let it turn every later touch into a pinch.
    if (e.isPrimary) pointers.current.clear();
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // jsdom, or a pointer that is already gone
    }
    const p = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    closeOnClick.current = false;

    if (pointers.current.size === 1) {
      g.multiTouch = false;
      const img = imgEls.current.get(indexRef.current);
      g.downOnImage = !!img && img.contains(e.target as Node);
      g.start = p;
      g.startTransform = transformRef.current;
      g.last = { t: e.timeStamp, ...p };
      g.v = { x: 0, y: 0 };
      g.mode = transformRef.current.scale > 1 ? "pan" : "pending";
      // Settle any running snap-back at its end position, so the drag starts
      // from where the strip will rest rather than mid-animation.
      writeStrip(0, false);
    } else if (pointers.current.size === 2) {
      beginPinch();
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;

    const dt = e.timeStamp - g.last.t;
    if (dt > 0) {
      g.v = { x: (p.x - g.last.x) / dt, y: (p.y - g.last.y) / dt };
      g.last = { t: e.timeStamp, ...p };
    }

    if (g.mode === "pinch") {
      if (pointers.current.size < 2 || g.pinchDist === 0) return;
      const [a, b] = [...pointers.current.values()].map(toSurface);
      const { dist, mid } = pinchState(a, b);
      const scale = clampScale((g.startTransform.scale * dist) / g.pinchDist);
      const zoomed = zoomAboutPoint(g.startTransform, scale, g.pinchMid);
      // Moving both fingers together pans as well as zooms.
      const moved = { scale, x: zoomed.x + mid.x - g.pinchMid.x, y: zoomed.y + mid.y - g.pinchMid.y };
      writeImage({ scale, ...clampPan(moved, imageSize(), viewport()) }, false);
      return;
    }

    const dx = p.x - g.start.x;
    const dy = p.y - g.start.y;

    if (g.mode === "pan") {
      const t = { ...g.startTransform, x: g.startTransform.x + dx, y: g.startTransform.y + dy };
      writeImage({ scale: t.scale, ...clampPan(t, imageSize(), viewport()) }, false);
      return;
    }

    if (g.mode === "pending") {
      const axis = lockAxis(dx, dy);
      if (!axis) return;
      g.mode = axis === "x" ? "swipe-x" : "swipe-y";
    }

    if (g.mode === "swipe-x") {
      const atEnd = (dx > 0 && indexRef.current === 0) || (dx < 0 && indexRef.current === count - 1);
      writeStrip(atEnd ? rubberBand(dx) : dx, false);
    } else if (g.mode === "swipe-y") {
      writeImage({ scale: 1, x: 0, y: dy }, false);
      const fadeDistance = viewport().height * 0.6 || 500;
      writeBackdrop(Math.max(0.2, 1 - Math.abs(dy) / fadeDistance));
    }
  };

  const endPointer = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    const remaining = pointers.current.size;

    if (g.mode === "pinch") {
      if (remaining >= 2) {
        // A third finger lifted: carry on with the pair that is left, measured
        // afresh — keeping the old pair's distance would make the zoom jump.
        beginPinch();
      } else if (remaining === 1) {
        // Lifting one finger of a pinch hands over to a pan with the other.
        // `multiTouch` stays set, so lifting that finger is not a tap.
        const [p] = [...pointers.current.values()];
        g.mode = "pan";
        g.start = p;
        g.startTransform = transformRef.current;
      } else if (remaining === 0) {
        g.mode = "idle";
      }
      return;
    }
    if (remaining > 0) return;

    const mode = g.mode;
    g.mode = "idle";
    const p = { x: e.clientX, y: e.clientY };
    const dx = p.x - g.start.x;
    const dy = p.y - g.start.y;

    if (mode === "swipe-x" || mode === "swipe-y") {
      if (cancelled) {
        snapBack();
        return;
      }
      const stale = e.timeStamp - g.last.t > VELOCITY_STALE_MS;
      const decision = decideSwipe({
        dx,
        dy,
        vx: stale ? 0 : g.v.x,
        vy: stale ? 0 : g.v.y,
        axis: mode === "swipe-x" ? "x" : "y",
        viewport: viewport(),
        hasPrev: indexRef.current > 0,
        hasNext: indexRef.current < count - 1,
      });
      if (decision === "next") go(1);
      else if (decision === "prev") go(-1);
      else if (decision === "close") onCloseRef.current();
      else snapBack();
      return;
    }

    const isTap = !g.multiTouch && (mode === "pending" || (mode === "pan" && Math.hypot(dx, dy) < AXIS_LOCK_SLOP));
    if (isTap && !cancelled) handleTap({ t: e.timeStamp, ...p });
  };

  const onSurfaceClick = () => {
    if (!closeOnClick.current) return;
    closeOnClick.current = false;
    onCloseRef.current();
  };

  if (count === 0) return null;
  const current = items[index];

  return createPortal(
    // Above every other layer, as the viewer it replaced was: dropdowns,
    // popovers and other modals sit at 1000, and a photo viewer opened from
    // inside any of them must cover them.
    <ModalOverlay onClose={onClose} style={{ background: "transparent", zIndex: 9999 }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Image viewer"
        tabIndex={-1}
        onClick={stopPropagation}
        onDoubleClick={stopPropagation}
        onPointerDown={stopPropagation}
        onPointerMove={stopPropagation}
        onPointerUp={stopPropagation}
        onPointerCancel={stopPropagation}
        onMouseDown={stopPropagation}
        onMouseUp={stopPropagation}
        onTouchStart={stopPropagation}
        onTouchMove={stopPropagation}
        onTouchEnd={stopPropagation}
        onContextMenu={stopPropagation}
        // touch-action is the intersection along the ancestor chain, so this
        // covers the buttons too: no page zoom from a pinch or a fast
        // double-tap that starts on a control.
        style={{ position: "absolute", inset: 0, outline: "none", touchAction: "none" }}
      >
        <div ref={backdropRef} aria-hidden="true" style={backdropStyle} />

        <div
          ref={surfaceRef}
          data-testid="lightbox-surface"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(e) => endPointer(e, false)}
          onPointerCancel={(e) => endPointer(e, true)}
          // Capture lost without a pointerup or pointercancel (the element was
          // re-parented, the browser revoked it): treat it as a cancel. After a
          // normal pointerup this is a no-op, as the pointer is already gone.
          onLostPointerCapture={(e) => endPointer(e, true)}
          onClick={onSurfaceClick}
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
            userSelect: "none",
            WebkitUserSelect: "none",
          }}
        >
          <div ref={stripRef} style={{ display: "flex", width: "100%", height: "100%", willChange: "transform" }}>
            {items.map((item, i) => (
              <div key={i} style={slotStyle} aria-hidden={i !== index}>
                {/* Only the current image and its neighbours are mounted. */}
                {Math.abs(i - index) <= 1 && (
                  <img
                    ref={(el) => {
                      if (el) imgEls.current.set(i, el);
                      else imgEls.current.delete(i);
                    }}
                    src={item.src}
                    alt={item.alt}
                    referrerPolicy={item.referrerPolicy}
                    draggable={false}
                    style={imageStyle}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        <div style={topBarStyle}>
          <span aria-live="polite" style={count > 1 ? counterStyle : undefined}>
            {count > 1 && (
              <>
                <span aria-hidden="true">{`${index + 1} / ${count}`}</span>
                <span style={visuallyHidden}>{`Image ${index + 1} of ${count}`}</span>
              </>
            )}
          </span>
          <button ref={closeButtonRef} type="button" aria-label="Close image viewer" onClick={onClose} style={roundButtonStyle}>
            <X size={18} />
          </button>
        </div>

        {count > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous image"
              onClick={() => go(-1)}
              disabled={index === 0}
              style={{ ...roundButtonStyle, ...navButtonStyle, left: 12, opacity: index === 0 ? 0.35 : 1 }}
            >
              <ChevronLeft size={22} />
            </button>
            <button
              type="button"
              aria-label="Next image"
              onClick={() => go(1)}
              disabled={index === count - 1}
              style={{ ...roundButtonStyle, ...navButtonStyle, right: 12, opacity: index === count - 1 ? 0.35 : 1 }}
            >
              <ChevronRight size={22} />
            </button>
          </>
        )}

        {current.caption && (
          <div style={captionStyle}>
            <span style={captionTextStyle}>{current.caption}</span>
          </div>
        )}
      </div>
    </ModalOverlay>,
    document.body,
  );
}

/** Keep Tab / Shift+Tab cycling inside the dialog. */
function trapFocus(e: KeyboardEvent, dialog: HTMLElement | null) {
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  const inside = active instanceof Node && dialog.contains(active);
  if (e.shiftKey && (active === first || !inside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !inside)) {
    e.preventDefault();
    first.focus();
  }
}

// The theme's overlay is translucent (the chat shows through); the blur keeps
// the transcript behind from competing with the image.
const backdropStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "var(--overlay-bg)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
};

const slotStyle: CSSProperties = {
  flex: "0 0 100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const imageStyle: CSSProperties = {
  maxWidth: "92vw",
  maxHeight: "86vh",
  objectFit: "contain",
  borderRadius: 4,
  transformOrigin: "center center",
  willChange: "transform",
  WebkitUserDrag: "none",
} as CSSProperties;

const topBarStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "calc(12px + env(safe-area-inset-top, 0px)) 12px 12px",
  pointerEvents: "none",
};

const counterStyle: CSSProperties = {
  color: "var(--media-control-text)",
  background: "var(--media-control-bg)",
  borderRadius: 12,
  padding: "2px 10px",
  fontSize: 13,
  fontVariantNumeric: "tabular-nums",
};

const roundButtonStyle: CSSProperties = {
  pointerEvents: "auto",
  background: "var(--media-control-bg-strong)",
  color: "var(--media-control-text)",
  border: "none",
  borderRadius: "50%",
  width: 40,
  height: 40,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
};

const navButtonStyle: CSSProperties = {
  position: "absolute",
  top: "50%",
  transform: "translateY(-50%)",
};

const captionStyle: CSSProperties = {
  position: "absolute",
  left: 16,
  right: 16,
  bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
  display: "flex",
  justifyContent: "center",
  pointerEvents: "none",
};

const captionTextStyle: CSSProperties = {
  maxWidth: 720,
  textAlign: "center",
  color: "var(--media-control-text)",
  background: "var(--media-control-bg)",
  borderRadius: 8,
  padding: "4px 10px",
  fontSize: 13,
};

const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
