/**
 * The footprint shared by the icon buttons in the sidebar's two top rows — the
 * header's nav controls and the filter bar's modal button and scope toggles.
 *
 * An explicit box rather than padding, because these buttons differ in their
 * BORDERS: an active one drops its border, and a grouped one drops the border
 * it shares with its neighbour. Sized by padding, each of those would shift the
 * control by a pixel as it toggled, so a row would twitch out of alignment
 * simply by being used.
 *
 * Exported rather than copied into each file because agreeing is the whole
 * requirement. The filter bar's buttons are supposed to be the same size as the
 * header's — that is what makes the two rows read as one stack rather than as
 * two bars that nearly line up — and two literals are a size that agrees until
 * someone edits one of them.
 */
export const HEADER_BUTTON_STYLE = {
  width: 28,
  height: 28,
  padding: 0,
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
} as const;

/**
 * The gap between adjacent controls in those rows, shared for the same reason:
 * it is what makes a standalone button read as separate from the segmented
 * group beside it, at both ends of the stack.
 */
export const HEADER_ROW_GAP = 4;
