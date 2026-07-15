import { useEffect } from "react";

/**
 * Keeps the app sized to the *visual* viewport so the on-screen keyboard never
 * covers the composer on mobile.
 *
 * Why: `height: 100%` (and even `100dvh`) track the *layout* viewport, which on
 * iOS Safari does not shrink when the keyboard opens — the keyboard just overlays
 * the bottom of the page and the browser starts panning the whole page to reveal
 * the focused input. Android Chrome 108+ has the same overlay behavior by default,
 * which we opt out of via `interactive-widget=resizes-content` in the viewport
 * meta tag; iOS ignores that attribute, so this hook covers it.
 *
 * Mechanism: mirror `visualViewport.height` into the `--app-height` CSS variable
 * (consumed by `html, body, #root` in index.css) and pin the window scroll back
 * to the origin whenever the browser auto-pans the page for a focused input.
 */
export function useVisualViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return; // very old browsers: keep the static 100% fallback

    const root = document.documentElement;

    const update = () => {
      // Ignore pinch-zoom (iOS Safari ignores user-scalable=no): while zoomed,
      // vv.height describes the zoomed-in window, not the space the keyboard left.
      if (vv.scale && Math.abs(vv.scale - 1) > 0.01) return;

      root.style.setProperty("--app-height", `${Math.round(vv.height)}px`);

      // iOS pans the page when focusing an input near the keyboard; once the app
      // is sized to the visual viewport nothing needs to be revealed, so undo it.
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0);
      }
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("orientationchange", update);

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("orientationchange", update);
      root.style.removeProperty("--app-height");
    };
  }, []);
}
