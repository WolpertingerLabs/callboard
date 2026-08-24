import type { Keyword } from "../api";

interface Props {
  /** Candidates, already filtered and ranked by `matchKeywords`. */
  matches: Keyword[];
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
}

/**
 * The `$keyword` dropdown — visually a sibling of `SlashCommandAutocomplete`,
 * anchored above the composer field with the same tokens and header row.
 *
 * The one thing it adds is a *highlight*, which the slash menu has no concept
 * of. That difference is load-bearing: the slash menu is click-or-type-through,
 * whereas keyword insertion is meant to be driven from the keyboard (Tab/Enter),
 * so there has to be a current row for those keys to act on — and, crucially,
 * a state in which there is *not* one. See `PromptInput`'s `keywordHighlight`
 * for why a bare `$` deliberately highlights nothing.
 *
 * Renders nothing when there are no matches. That is the last guard in the
 * trigger chain: it is what makes `$HOME` and `$PATH` inert on an install with
 * no keyword of that name, rather than showing an empty box.
 */
export default function KeywordAutocomplete({ matches, highlightedIndex, onHighlight, onSelect }: Props) {
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
        Keywords ({matches.length})
      </div>

      {matches.map((keyword, index) => {
        const isHighlighted = index === highlightedIndex;
        return (
          <button
            key={keyword.name}
            // Insertion has to survive the click without the textarea losing
            // focus first — mousedown-preventDefault keeps the caret where the
            // token is, so the replacement lands in the right place.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(keyword)}
            onMouseEnter={() => onHighlight(index)}
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
  );
}
