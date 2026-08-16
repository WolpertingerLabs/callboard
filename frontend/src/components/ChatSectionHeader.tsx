/**
 * The plain label above an "Active cards first" section, rendered by both list
 * layouts (which is why it is its own file rather than a style object copied
 * into each).
 *
 * Typography is the sidebar's existing "Staging" header, minus its chevron and
 * button semantics — this is a label, not a collapse toggle. Deliberately not
 * the Board's `sectionHeader`, which belongs to a different surface.
 */
export default function ChatSectionHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        padding: "8px 20px",
        color: "var(--text-muted)",
        fontSize: 12,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {label}
    </div>
  );
}
