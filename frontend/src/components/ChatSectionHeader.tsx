/**
 * The header above a sidebar chat section.
 *
 * Typography and chevron are the sidebar's existing "Staging" header, down to
 * the count in parentheses — these are the same kind of control on the same
 * surface, so they should not read as two different ones. Deliberately not the
 * Board's `sectionHeader`, which belongs to a different surface.
 *
 * Where it does depart from Staging: a filled background. Staging is one
 * header pinned above a bordered block, while these sit *inside* the run of
 * rows and repeat down it, so they need to read as bands rather than as
 * another row. `--chatlist-section-header-bg` exists for that; the sidebar's
 * own `--chatlist-header-bg` is transparent in both themes.
 *
 * The count is threads — one per row, child chats never counted (see
 * `ChatSection.count`) — and is passed in rather than derived here.
 *
 * A sidebar folder's header carries a folder glyph — the only thing that tells
 * a folder the user named "Pinned" or "Recent" from the built-in sections — and
 * its label is the user's own text, up to 64 characters with no guarantee of a
 * space in it. So the label ellipsizes in its own shrinkable span, the count
 * sits beside it in one that never shrinks, and the full name is the tooltip.
 *
 * The running indicator — a dot and a number, shown only while at least one
 * chat in the section has a live session — is the Board's "Active" rollup
 * mark (7px `--status-active` dot with a glow of its own colour, number in the
 * same colour) rather than a new look. Unlike the count it is CHATS, every
 * running member of every group: a tree with three agents working in it is
 * three running, which is the number the user wants when deciding whether a
 * folder still has work in flight. Like the count it never shrinks, so a long
 * label ellipsizes before the indicator clips.
 */

import { ChevronDown, ChevronRight, Folder } from "lucide-react";
import { visuallyHidden } from "../utils/visuallyHidden";

export default function ChatSectionHeader({
  label,
  count,
  expanded,
  onToggle,
  isFolder = false,
  runningCount = 0,
}: {
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  /** A sidebar folder rather than Pinned/Recent: adds the folder glyph. */
  isFolder?: boolean;
  /** Chats in this section with a live session; the indicator shows only when > 0. */
  runningCount?: number;
}) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={expanded}
      data-testid="section-header"
      title={isFolder ? `Folder: ${label}` : undefined}
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "12px 20px",
        background: "var(--chatlist-section-header-bg)",
        border: "none",
        // Only when expanded, where it is the line between the header and the
        // rows it introduces. A collapsed header introduces nothing, and a
        // rule under it would read as a separator for the section below.
        borderBottom: expanded ? "1px solid var(--chatlist-item-border)" : undefined,
        color: "var(--text-muted)",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
        textTransform: "uppercase",
        letterSpacing: 0.5,
        minWidth: 0,
        textAlign: "left",
      }}
    >
      {expanded ? <ChevronDown size={14} style={{ flexShrink: 0 }} /> : <ChevronRight size={14} style={{ flexShrink: 0 }} />}
      {isFolder && <Folder size={13} aria-hidden style={{ flexShrink: 0 }} />}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {/* The leading space keeps the accessible name "Label (n)"; the flex gap does the visual spacing. */}
      <span style={{ flexShrink: 0 }}> ({count})</span>
      {runningCount > 0 && (
        <span
          data-testid="section-running"
          title={`${runningCount} running`}
          style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, marginLeft: 2, color: "var(--status-active)" }}
        >
          <span
            aria-hidden
            style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--status-active)", boxShadow: "0 0 5px var(--status-active)" }}
          />
          <span aria-hidden>{runningCount}</span>
          {/* The dot is colour alone, so the name spells it out: "Label (n) 2 running". */}
          <span style={visuallyHidden}>{runningCount} running</span>
        </span>
      )}
    </button>
  );
}
