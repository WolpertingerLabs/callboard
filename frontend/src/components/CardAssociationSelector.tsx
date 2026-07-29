import { useState, useEffect, useRef } from "react";
import { LayoutGrid, Sparkles } from "lucide-react";
import { listCards, CARD_CATEGORY_MAX, type CardSummary } from "../api";
import { uniqueCategories } from "../utils/cardCategories";
import { useIsMobile } from "../hooks/useIsMobile";

/** Card association choice for a new chat: create a new card, join an
 *  existing open card, or (default) neither. */
export interface CardAssociationConfig {
  createCard: boolean;
  cardId: string | null;
  /** Optional category for the auto-created card (only used with createCard). */
  category: string;
}

interface CardAssociationSelectorProps {
  /** Controlled value — the parent owns the selection. */
  value: CardAssociationConfig;
  onChange: (config: CardAssociationConfig) => void;
}

export default function CardAssociationSelector({ value, onChange }: CardAssociationSelectorProps) {
  const [openCards, setOpenCards] = useState<CardSummary[]>([]);
  // Autocomplete suggestions for the category input — from ALL cards (closed
  // included) so an established category survives its last open card closing.
  const [knownCategories, setKnownCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const isMobile = useIsMobile();

  // Latest value/onChange for the one-shot fetch effect below, without
  // re-fetching when they change.
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });

  // Fetch cards on mount; only open cards are offered (closed cards live in
  // the board's Closed strip and shouldn't accumulate new chats).
  useEffect(() => {
    let cancelled = false;
    listCards()
      .then((data) => {
        if (cancelled) return;
        const open = data.cards
          .filter((c) => c.lifecycle === "open")
          .sort((a, b) => (a.pinned === b.pinned ? b.updatedAt.localeCompare(a.updatedAt) : a.pinned ? -1 : 1));
        setOpenCards(open);
        setKnownCategories(uniqueCategories(data.cards));
        setLoading(false);
        // Drop a preselected card that is provably no longer open — the
        // backend would silently ignore it, so don't pretend it's attached.
        const current = valueRef.current;
        if (current.cardId && !open.some((c) => c.id === current.cardId)) {
          onChangeRef.current({ ...current, cardId: null });
        }
      })
      .catch(() => {
        if (cancelled) return;
        // Keep any preselected cardId: a transient fetch failure says nothing
        // about the card's validity — the backend validates on send.
        setLoadFailed(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The typed category is kept across an uncheck/re-check — it's only ever
  // read when createCard is set (see Chat.tsx), so leaving it in place costs
  // nothing and saves the user retyping after a glance at the card dropdown.
  const handleCreateChange = (checked: boolean) => {
    onChange({ ...value, createCard: checked, cardId: checked ? null : value.cardId });
  };

  const handleCardSelect = (selected: string) => {
    onChange({ ...value, createCard: false, cardId: selected || null });
  };

  const hasChoice = value.createCard || !!value.cardId;

  const createToggle = (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        cursor: "pointer",
        fontSize: 12,
        color: value.createCard ? "var(--accent)" : "var(--text-muted)",
        flexShrink: 0,
        userSelect: "none",
        fontWeight: value.createCard ? 500 : 400,
        transition: "color 0.15s ease",
      }}
      title="Auto-create a card for this chat, titled from the first message"
    >
      <input type="checkbox" checked={value.createCard} onChange={(e) => handleCreateChange(e.target.checked)} style={{ cursor: "pointer", margin: 0 }} />
      <Sparkles size={12} style={{ flexShrink: 0 }} />
      Create card
    </label>
  );

  const cardSelect = value.createCard ? (
    // On mobile the category input is forced to a full-width flex basis so it
    // wraps onto its own second row (the outer flex container has flexWrap);
    // on desktop it stays inline at a fixed width alongside the hint text.
    <>
      <div
        style={{
          flex: 1,
          padding: "4px 0",
          fontSize: 12,
          color: "var(--accent-text)",
          fontStyle: "italic",
          opacity: 0.85,
          minWidth: 0,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        Will create a card titled from the first message
      </div>
      <input
        value={value.category}
        onChange={(e) => onChange({ ...value, category: e.target.value })}
        maxLength={CARD_CATEGORY_MAX}
        list="card-association-category-options"
        placeholder="Category (optional)"
        title="Optional category — the board groups open cards by category"
        style={{
          background: "var(--bg)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 5,
          padding: "4px 8px",
          fontSize: 12,
          outline: "none",
          ...(isMobile ? { flex: "1 1 100%", minWidth: 0 } : { width: 180, flexShrink: 0 }),
        }}
      />
      {knownCategories.length > 0 && (
        <datalist id="card-association-category-options">
          {knownCategories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      )}
    </>
  ) : loading ? (
    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading...</span>
  ) : loadFailed ? (
    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Couldn&apos;t load cards{value.cardId ? " — keeping current selection" : ""}</span>
  ) : openCards.length === 0 ? (
    <span style={{ fontSize: 12, color: "var(--text-muted)" }}>No open cards</span>
  ) : (
    <select
      value={value.cardId ?? ""}
      onChange={(e) => handleCardSelect(e.target.value)}
      style={{
        background: "var(--bg)",
        color: "var(--text)",
        border: "1px solid var(--border)",
        borderRadius: 5,
        padding: "4px 8px",
        fontSize: 12,
        cursor: "pointer",
        outline: "none",
        ...(isMobile ? { flex: 1, minWidth: 0 } : { maxWidth: 260 }),
      }}
    >
      <option value="">No card</option>
      {openCards.map((card) => (
        <option key={card.id} value={card.id}>
          {card.emoji} {card.title}
        </option>
      ))}
    </select>
  );

  return (
    <div
      style={{
        background: "var(--bg-secondary)",
        borderRadius: 10,
        padding: "10px 14px",
        marginBottom: 8,
        border: hasChoice ? "1px solid var(--accent)" : "1px solid transparent",
        transition: "border-color 0.2s ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <LayoutGrid size={13} style={{ color: "var(--accent-text)", flexShrink: 0 }} />
          <span style={{ fontSize: 12, color: "var(--text-muted)", userSelect: "none" }}>Card</span>
        </div>
        {createToggle}
        {cardSelect}
      </div>
    </div>
  );
}
