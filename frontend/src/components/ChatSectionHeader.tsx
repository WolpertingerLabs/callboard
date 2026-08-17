/**
 * The header above an "Active cards first" section, rendered by both list
 * layouts (which is why it is its own file rather than a style object copied
 * into each).
 *
 * Typography and chevron are the sidebar's existing "Staging" header, down to
 * the count in parentheses — these are the same kind of control on the same
 * surface, so they should not read as two different ones. Deliberately not the
 * Board's `sectionHeader`, which belongs to a different surface.
 *
 * Where it does depart from Staging: a filled background. Staging is one
 * header pinned above a bordered block, while these two sit *inside* the run
 * of rows and repeat down it, so they need to read as bands rather than as
 * another row. `--chatlist-section-header-bg` exists for that; the sidebar's
 * own `--chatlist-header-bg` is transparent in both themes.
 *
 * The count is chats, passed in rather than derived from the rows below: the
 * tree layout renders one row per lineage group, so counting what it renders
 * would under-report every group with more than one member.
 */

import { ChevronDown, ChevronRight } from "lucide-react";

export default function ChatSectionHeader({ label, count, expanded, onToggle }: { label: string; count: number; expanded: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={expanded}
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
      }}
    >
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      {label} ({count})
    </button>
  );
}
