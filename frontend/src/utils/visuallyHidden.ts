import type { CSSProperties } from "react";

/**
 * Off screen but in the accessibility tree — not `display: none`, which takes
 * it out of both. Read by screen readers, invisible on screen.
 *
 * `clip` for the browsers that want the deprecated one and `clipPath` for the
 * rest; a 1px box rather than a zero one, because a zero-sized element is
 * skipped by some screen readers outright.
 */
export const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};
