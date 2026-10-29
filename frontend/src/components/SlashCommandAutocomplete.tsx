import { useEffect, useRef } from "react";
import { getCommandDescription } from "../utils/commands";

interface Props {
  /** Candidates, already filtered and ranked by `matchSlashCommands`. */
  matches: string[];
  /**
   * Index of the highlighted row, or -1 for none.
   *
   * Owned by the composer for the same reason as `KeywordAutocomplete`'s: the
   * highlight is what Enter and Tab act on, and those keys are handled in the
   * textarea's `onKeyDown`, which cannot see state that lives down here.
   */
  highlightedIndex: number;
  onHighlight: (index: number) => void;
  /** The pointer left the rows — the composer drops a highlight the pointer made. */
  onPointerLeave: () => void;
  onSelect: (command: string) => void;
  visible: boolean;
  /** DOM id of the listbox; option ids derive from it via {@link slashOptionId}. */
  listboxId: string;
  commandDescriptions?: Record<string, string>;
}

/** DOM id of row `index`, for the textarea's `aria-activedescendant`. */
export const slashOptionId = (listboxId: string, index: number) => `${listboxId}-${index}`;

/**
 * The `/command` dropdown, anchored above the composer field.
 *
 * Unlike the `$keyword` menu, nothing is highlighted until the user arrows (or
 * points) at a row: Enter on an un-highlighted menu dismisses it, as it always
 * has, so typing a whole command and pressing Enter keeps doing what it did.
 * See `PromptInput`'s `commandHighlight`.
 */
export default function SlashCommandAutocomplete({
  matches,
  highlightedIndex,
  onHighlight,
  onPointerLeave,
  onSelect,
  visible,
  listboxId,
  commandDescriptions,
}: Props) {
  const highlightedRef = useRef<HTMLButtonElement | null>(null);

  // Keep the highlighted row on screen — the list is 200px tall and holds up
  // to ten rows. Same reasoning, and the same jsdom-optional call, as
  // `KeywordAutocomplete`.
  useEffect(() => {
    highlightedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedIndex]);

  if (!visible || matches.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="slash-command-autocomplete"
      style={{
        position: "absolute",
        bottom: "100%",
        left: 0,
        right: 0,
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        marginBottom: "8px",
        maxHeight: "200px",
        overflowY: "auto",
        zIndex: 1000,
        boxShadow: "var(--shadow-md)",
      }}
    >
      <div
        style={{
          padding: "6px 12px",
          fontSize: 11,
          color: "var(--text-muted)",
          borderBottom: "1px solid var(--border)",
          fontWeight: 600,
        }}
      >
        Available Commands ({matches.length})
      </div>

      <div role="listbox" id={listboxId} aria-label="Commands" onMouseLeave={onPointerLeave}>
        {matches.map((command, index) => {
          const isHighlighted = index === highlightedIndex;
          const description = commandDescriptions?.[command] || getCommandDescription(command);
          return (
            <button
              key={command}
              id={slashOptionId(listboxId, index)}
              role="option"
              // Options are reached through the textarea's
              // aria-activedescendant, not by tabbing onto each row.
              tabIndex={-1}
              aria-selected={isHighlighted}
              ref={isHighlighted ? highlightedRef : undefined}
              onClick={() => onSelect(command)}
              // Move, not enter: scrolling the list under a resting pointer
              // fires mouseenter on whatever row slides beneath it, which would
              // yank the highlight away from the row the arrow keys just chose.
              onMouseMove={() => {
                if (!isHighlighted) onHighlight(index);
              }}
              style={{
                width: "100%",
                padding: "8px 12px",
                background: isHighlighted ? "var(--accent-bg)" : "transparent",
                border: "none",
                textAlign: "left" as const,
                fontSize: 14,
                color: "var(--text)",
                cursor: "pointer",
                borderBottom: index < matches.length - 1 ? "1px solid var(--border)" : "none",
                transition: "background 0.1s ease",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <code
                  style={{
                    background: "var(--bg-secondary)",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    fontSize: 13,
                    fontFamily: "var(--font-mono)",
                    color: "var(--accent-text)",
                  }}
                >
                  {command}
                </code>
                {description && (
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                    }}
                  >
                    {description}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
