import type { CSSProperties } from "react";

/**
 * A path that, when too long, loses its START to the ellipsis ("…/code/app")
 * rather than its end — the end is the part that tells folders apart.
 *
 * The truncation comes from `direction: rtl` on the box. The path itself sits
 * in an LTR isolate (`<bdi dir="ltr">`): without it the RTL box reorders the
 * neutral slashes and "/home/me/app" renders as "home/me/app/".
 */
export default function LeftTruncatedPath({ path, style }: { path: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        direction: "rtl",
        textAlign: "left",
        minWidth: 0,
        ...style,
      }}
    >
      <bdi dir="ltr">{path}</bdi>
    </span>
  );
}
