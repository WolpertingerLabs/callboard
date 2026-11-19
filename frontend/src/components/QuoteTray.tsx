/**
 * The quotes waiting above the composer to go out with the next message —
 * one removable chip per quote (see `hooks/useQuoteTray.ts` for the store and
 * `utils/messageQuotes.ts` for how they are written into the prompt).
 *
 * `actions` is a slot at the row's end for further things to do with the
 * quotes as a set — the place an "Ask as aside" goes.
 */
import type { ReactNode } from "react";
import { Quote, X } from "lucide-react";
import { formatQuoteOrigin, type MessageQuote } from "../utils/messageQuotes";

interface Props {
  quotes: readonly MessageQuote[];
  onRemove: (quoteId: string) => void;
  onClear?: () => void;
  actions?: ReactNode;
}

const PREVIEW_CHARS = 80;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
}

export default function QuoteTray({ quotes, onRemove, onClear, actions }: Props) {
  if (quotes.length === 0) return null;
  return (
    <div role="group" aria-label="Quoted passages" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 12 }}>
      {quotes.map((quote) => {
        const origin = formatQuoteOrigin(quote);
        return (
          <span
            key={quote.id}
            data-testid="quote-chip"
            title={`${origin}\n\n${quote.text}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              maxWidth: "100%",
              minWidth: 0,
              padding: "3px 4px 3px 8px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderLeft: "3px solid var(--accent)",
              borderRadius: 6,
              color: "var(--text)",
            }}
          >
            <Quote size={12} aria-hidden style={{ flexShrink: 0, color: "var(--text-muted)" }} />
            <span style={{ flexShrink: 0, color: "var(--text-muted)" }}>{origin}</span>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview(quote.text)}</span>
            <button
              type="button"
              aria-label={`Remove quote from ${origin}`}
              title="Remove quote"
              onClick={() => onRemove(quote.id)}
              style={{
                display: "inline-flex",
                flexShrink: 0,
                padding: 2,
                background: "transparent",
                border: "none",
                borderRadius: 4,
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              <X size={12} />
            </button>
          </span>
        );
      })}
      {onClear && quotes.length > 1 && (
        <button
          type="button"
          onClick={onClear}
          style={{ padding: "2px 6px", background: "transparent", border: "none", color: "var(--text-muted)", fontSize: 12, cursor: "pointer" }}
        >
          Clear all
        </button>
      )}
      {actions}
    </div>
  );
}
