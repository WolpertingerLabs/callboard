import { splitPathForTruncation, stripPathPrefix } from "../../utils/pathTruncate";

interface CardPathLabelProps {
  path: string;
  /**
   * A shared prefix already shown elsewhere (a hoisted group header), stripped
   * at a segment boundary. Unset renders the whole path.
   */
  prefix?: string;
  /** Falls back to the surrounding text colour. */
  color?: string;
  fontSize?: number;
}

/**
 * A path that truncates in the middle, in CSS alone.
 *
 * The last two segments are the part worth keeping — a leaf like `frontend` or
 * `main` names nothing on its own across a fan-out of worktrees — so they sit
 * in a `flex: 0 0 auto` cell that claims its width first, and the head
 * ellipsizes into whatever is left. Flex supplies the priority for free, and
 * because the browser is doing the layout it reflows live on a window resize
 * or a sidebar drag, with no `ResizeObserver` and no measurement pass.
 *
 * Accepted cost: the head's ellipsis lands mid-segment (`…proj…`) rather than
 * on a `/`, since CSS cannot be told to cut at a delimiter. The full path is
 * in the `title`, and a JS-measured implementation can replace the internals
 * later without touching this component's surface.
 *
 * The tail's priority is a *ratio*, not an absolute: `flex: 0 0 auto` gave it
 * an unbreakable width, so a parent+leaf longer than the whole label — real
 * paths reach 82 characters after the shared prefix comes off — spilled out of
 * a 260px tile instead of truncating. It shrinks last, not never.
 */
export default function CardPathLabel({ path, prefix, color, fontSize = 11 }: CardPathLabelProps) {
  const shown = stripPathPrefix(path, prefix);
  const { head, tail } = splitPathForTruncation(shown);

  return (
    <span
      // The title is always the FULL path, never the stripped remainder: the
      // hover is the escape hatch for everything the layout had to drop.
      title={path}
      // overflow is the backstop: whatever the flex arithmetic decides, nothing
      // in here escapes the cell the caller sized.
      style={{ display: "flex", minWidth: 0, overflow: "hidden", fontSize, color: color ?? "inherit" }}
    >
      {/* 999 vs the tail's 1 is the priority: the head absorbs essentially all
          of the shrinkage, which is the entire point of the component. */}
      {head && <span style={{ flex: "0 999 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{head}</span>}
      <span style={{ flex: "0 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tail}</span>
    </span>
  );
}
