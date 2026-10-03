import { useState, useEffect } from "react";

/**
 * Narrower than 768px — `innerWidth < 768`, expressed as a media query.
 *
 * The media query sees the fractional viewport width (browser zoom, device
 * scaling), where `max-width: 767px` would miss 767 < w < 768. Negating
 * `min-width: 768px` is exactly `< 768` at any width.
 */
const MOBILE_QUERY = "not all and (min-width: 768px)";
const MOBILE_MAX_WIDTH = 768;

/** `null` where `matchMedia` is missing (jsdom), so the caller falls back to `innerWidth`. */
function mobileQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_QUERY) : null;
}

function readIsMobile(query: MediaQueryList | null): boolean {
  return query ? query.matches : window.innerWidth < MOBILE_MAX_WIDTH;
}

export function useIsMobile() {
  // Read synchronously on the first render: starting from `false` painted the
  // desktop layout for a frame on every phone before the effect corrected it.
  const [isMobile, setIsMobile] = useState(() => readIsMobile(mobileQuery()));

  useEffect(() => {
    const query = mobileQuery();
    const update = () => setIsMobile(readIsMobile(query));

    // The viewport may have changed between the first render and this effect.
    update();
    // The query fires only when the answer flips, rather than on every pixel of
    // a resize. `innerWidth` has no such event, so the fallback keeps listening
    // to `resize`.
    if (query) {
      query.addEventListener("change", update);
      return () => query.removeEventListener("change", update);
    }
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return isMobile;
}
