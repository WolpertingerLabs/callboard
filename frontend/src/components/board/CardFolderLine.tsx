import CardPathLabel from "./CardPathLabel";
import { FOLDER_LIVE_COLORS, type CardFolderSummary } from "./cardFace";

/**
 * The collapsed folder story, identical on a tile and on a row: one path, plus
 * a `+N` that lights up when the action is somewhere other than the path on
 * show.
 *
 * One component rather than two copies. `cardFace` promoted the *data* behind
 * that colour rule and the two faces then pasted the markup — comment and all
 * — so the argument for why a single-folder card shows no `+0` lived in two
 * places and the rule itself was asserted on only one of them. Sharing the
 * element means the tile's colour tests are the row's colour tests.
 *
 * Renders a fragment: the tile gives this its own line and the row gives it a
 * grid cell alongside the expansion chevron, and that container is the half
 * the two faces are supposed to differ on.
 */
export default function CardFolderLine({ folders, extraCount, extrasLive }: CardFolderSummary) {
  if (folders.length === 0) return null;

  // Count AND state, because the colour carries the second half and a colour
  // is not a thing a screen reader can read. Also the sighted hover: `+3`
  // painted amber says something happened somewhere, and this says where.
  const label = `${extraCount} other folder${extraCount === 1 ? "" : "s"}${
    extrasLive ? (extrasLive === "waiting" ? ", one needs you" : ", one active") : ""
  }`;

  return (
    <>
      <CardPathLabel path={folders[0].path} color="var(--board-tile-meta-text)" />
      {/* Nothing at all on a single-folder card: a "+0" on 794 of 818 cards is
          noise on every one of them. */}
      {extraCount > 0 && (
        <span
          title={label}
          // Without this the row's accessible name runs the count into the
          // path beside it — "…callboard +3 Active 4 2h" — and the +N is the
          // one glyph on the face whose meaning is carried by its colour.
          aria-label={label}
          style={{
            flexShrink: 0,
            fontSize: 11,
            fontWeight: 600,
            color: extrasLive ? FOLDER_LIVE_COLORS[extrasLive] : "var(--board-tile-meta-text)",
          }}
        >
          +{extraCount}
        </span>
      )}
    </>
  );
}
