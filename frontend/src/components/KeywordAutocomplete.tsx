import { useEffect, useRef } from "react";
import type { Keyword } from "../api";

interface Props {
  /** Candidates, already filtered and ranked by `matchKeywords`. */
  matches: Keyword[];
  /**
   * How many keywords the query matched before `matchKeywords` capped the list.
   *
   * Separate from `matches.length` because the cap is invisible otherwise: an
   * install with 40 keywords rendering "Keywords (10)" on a bare `$` states a
   * total that is not the total.
   */
  totalMatches: number;
  /**
   * Index of the highlighted row, or -1 for none.
   *
   * Owned by the composer rather than by this component: the highlight is what
   * Enter and Tab act on, and those keys are handled in the textarea's
   * `onKeyDown`, which cannot see state that lives down here.
   */
  highlightedIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (keyword: Keyword) => void;
  /** DOM id of the listbox; option ids derive from it via {@link keywordOptionId}. */
  listboxId: string;
}

/** DOM id of row `index`, for the textarea's `aria-activedescendant`. */
export const keywordOptionId = (listboxId: string, index: number) => `${listboxId}-${index}`;

/**
 * The `$keyword` dropdown — visually a sibling of `SlashCommandAutocomplete`,
 * anchored above the composer field with the same tokens and header row.
 *
 * Both menus have a highlight that the arrow keys move, but they differ in
 * the default: keyword insertion is meant to be driven from the keyboard
 * (Tab/Enter), so a typed query highlights the top row — and, crucially, there
 * is a state in which nothing is highlighted. See `PromptInput`'s `keywordHighlight`
 * for why a bare `$` deliberately highlights nothing.
 *
 * Renders nothing when there are no matches. That is the last guard in the
 * trigger chain: it is what makes `$HOME` and `$PATH` inert on an install with
 * no keyword of that name, rather than showing an empty box.
 */
export default function KeywordAutocomplete({ matches, totalMatches, highlightedIndex, onHighlight, onSelect, listboxId }: Props) {
  const highlightedRef = useRef<HTMLButtonElement | null>(null);

  /**
   * Keep the highlighted row on screen.
   *
   * The list scrolls — 200px of box against ~35px rows and a header shows about
   * five of a possible ten — so arrowing past the fifth row, or wrapping with
   * ArrowUp to the last, moves the highlight out of view. Enter then inserts
   * something the user cannot see, which is squarely inside the keyboard
   * contract this menu exists to honour.
   *
   * `block: "nearest"` scrolls the minimum needed, so a highlight that is
   * already visible does not jump the list under a mouse. The optional call is
   * for jsdom, which has no layout and therefore no `scrollIntoView`.
   */
  useEffect(() => {
    highlightedRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedIndex]);

  if (matches.length === 0) return null;

  return (
    <div
      data-testid="keyword-autocomplete"
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
        Keywords ({totalMatches > matches.length ? `${matches.length} of ${totalMatches}` : matches.length})
      </div>

      <div role="listbox" id={listboxId} aria-label="Keywords">
      {matches.map((keyword, index) => {
        const isHighlighted = index === highlightedIndex;
        return (
          <button
            key={keyword.name}
            id={keywordOptionId(listboxId, index)}
            role="option"
            aria-selected={isHighlighted}
            ref={isHighlighted ? highlightedRef : undefined}
            // Insertion has to survive the click without the textarea losing
            // focus first — mousedown-preventDefault keeps the caret where the
            // token is, so the replacement lands in the right place.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(keyword)}
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
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <code
                style={{
                  background: "var(--bg-secondary)",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  fontSize: 13,
                  fontFamily: "var(--font-mono)",
                  color: "var(--accent-text)",
                  flexShrink: 0,
                }}
              >
                ${keyword.name}
              </code>
              {keyword.description && (
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {keyword.description}
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
