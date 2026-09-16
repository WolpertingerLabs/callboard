import { Star } from "lucide-react";

interface Props {
  active: boolean;
  onToggle: () => void;
  /** Noun for the accessible name and tooltip, e.g. `skill "release-notes"`. */
  label: string;
  /**
   * True until the favorites list has actually been read. Starring is a
   * read-modify-write of the whole list, so a click before the read would PUT a
   * one-element list and destroy every other favorite — see
   * `utils/favorites.ts`, which refuses the write. Disabled here so the refusal
   * is something the user can see instead of a click that does nothing.
   */
  disabled?: boolean;
  /**
   * Tooltip while disabled. Defaults to the still-loading wording; pass the
   * read's error when there was one, so "the daemon did not answer" does not
   * render as a spinner that never stops.
   */
  disabledReason?: string;
  size?: number;
}

/**
 * The star that adds a skill or job to the New Chat launchpad.
 *
 * Filled + accent when starred, hollow + muted when not, which is the whole
 * affordance — there is no save step, so the icon's state IS the persisted
 * state (see `utils/favorites.ts` for the optimistic write and how the server's
 * response settles it).
 *
 * The accessible name is static and `aria-pressed` carries the state, because a
 * toggle that changes both announces itself twice and contradictorily —
 * "Unfavorite skill X, pressed". The `title` stays dynamic: a tooltip is read
 * by people who can also see the star, and there the imperative is the useful
 * phrasing.
 */
export default function FavoriteStar({ active, onToggle, label, disabled = false, disabledReason, size = 15 }: Props) {
  return (
    <button
      onClick={(e) => {
        // Cheap insurance: these stars sit in dense settings rows next to other
        // controls, and a future clickable row would otherwise silently turn
        // every star click into a row click too.
        e.stopPropagation();
        onToggle();
      }}
      disabled={disabled}
      title={
        disabled
          ? (disabledReason ?? "Loading your favorites…")
          : active
            ? `Remove ${label} from the New Chat launchpad`
            : `Pin ${label} to the New Chat launchpad`
      }
      aria-label={`Favorite ${label}`}
      aria-pressed={active}
      style={{
        background: "none",
        border: "none",
        color: active ? "var(--accent-text)" : "var(--text-muted)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        padding: 4,
        display: "flex",
        alignItems: "center",
      }}
    >
      <Star size={size} fill={active ? "currentColor" : "none"} />
    </button>
  );
}
