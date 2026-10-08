import type { SpaceListItem } from "shared/types/space.js";

/** "💼 Work", or just the name. */
export function spaceLabel(space: Pick<SpaceListItem, "name" | "emoji"> | undefined): string {
  if (!space) return "";
  return space.emoji ? `${space.emoji} ${space.name}` : space.name;
}

/**
 * The space's accent as a CSS value. Token names only (see SPACE_ACCENTS):
 * every theme decides what the tint looks like. No accent → the neutral border.
 */
export function spaceAccentVar(space: Pick<SpaceListItem, "color"> | undefined): string {
  return space?.color ? `var(--space-accent-${space.color})` : "var(--border)";
}

/** A small round marker in the space's accent. */
export function SpaceDot({ space, size = 8 }: { space: Pick<SpaceListItem, "color"> | undefined; size?: number }) {
  return (
    <span aria-hidden style={{ width: size, height: size, flexShrink: 0, borderRadius: "50%", background: spaceAccentVar(space), display: "inline-block" }} />
  );
}

/**
 * The chip a row carries when it is shown outside its own space — the "All"
 * view, and other spaces' blocked cards in the board's Needs-you bucket.
 * Text stays on the neutral surface; the accent is only the stripe.
 */
export default function SpaceChip({ space, title }: { space: SpaceListItem | undefined; title?: string }) {
  if (!space) return null;
  return (
    <span
      title={title ?? `In space: ${space.name}`}
      data-testid="space-chip"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        maxWidth: 120,
        padding: "1px 6px",
        borderRadius: 4,
        borderLeft: `3px solid ${spaceAccentVar(space)}`,
        background: "var(--bg-secondary)",
        color: "var(--text-muted)",
        fontSize: 11,
        lineHeight: "16px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        flexShrink: 0,
      }}
    >
      {spaceLabel(space)}
    </span>
  );
}
