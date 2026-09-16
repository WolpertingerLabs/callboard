import { Star } from "lucide-react";

interface Props {
  active: boolean;
  onToggle: () => void;
  /** Noun for the tooltip, e.g. "skill" or "job". */
  label: string;
  size?: number;
}

/**
 * The star that adds a skill or job to the New Chat launchpad.
 *
 * Filled + accent when starred, hollow + muted when not, which is the whole
 * affordance — there is no save step, so the icon's state IS the persisted
 * state (see `utils/favorites.ts` for the optimistic write and its revert).
 */
export default function FavoriteStar({ active, onToggle, label, size = 15 }: Props) {
  return (
    <button
      onClick={(e) => {
        // The job rows in Settings → Jobs are inside a clickable card header;
        // starring one must not also expand it.
        e.stopPropagation();
        onToggle();
      }}
      title={active ? `Remove ${label} from the New Chat launchpad` : `Pin ${label} to the New Chat launchpad`}
      aria-label={active ? `Unfavorite ${label}` : `Favorite ${label}`}
      aria-pressed={active}
      style={{
        background: "none",
        border: "none",
        color: active ? "var(--accent-text)" : "var(--text-muted)",
        cursor: "pointer",
        padding: 4,
        display: "flex",
        alignItems: "center",
      }}
    >
      <Star size={size} fill={active ? "currentColor" : "none"} />
    </button>
  );
}
