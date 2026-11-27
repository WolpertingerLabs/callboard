import { useEffect, useState } from "react";

/** Same breakpoint as the CSS: phones get the drawer and card layouts. */
const QUERY = "(max-width: 768px)";

function matches(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(QUERY).matches
    : false;
}

export function useIsMobile(): boolean {
  // Lazy init, so a phone's first paint is already the mobile layout.
  const [isMobile, setIsMobile] = useState(matches);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
