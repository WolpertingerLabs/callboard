import { useState } from "react";
import type { CardSummary } from "../../api";
import ModalOverlay from "../ModalOverlay";
import { Plus } from "lucide-react";

interface CardPickerProps {
  cards: CardSummary[];
  onSelect: (cardId: string) => void | Promise<void>;
  onCreate: (title: string) => void | Promise<void>;
  onClose: () => void;
}

/** Pick an open card, or create a new one inline. */
export default function CardPicker({ cards, onSelect, onCreate, onClose }: CardPickerProps) {
  const [newTitle, setNewTitle] = useState("");
  // In-flight guard: the parent unmounts this picker only after its request
  // resolves, so without it a second Enter/click fires a duplicate create.
  const [busy, setBusy] = useState(false);
  const openCards = cards.filter((c) => c.lifecycle === "open");

  const run = async (action: void | Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action;
    } finally {
      setBusy(false);
    }
  };

  const create = () => {
    if (newTitle.trim()) run(onCreate(newTitle.trim()));
  };

  return (
    <ModalOverlay>
      <div
        style={{
          background: "var(--bg)",
          borderRadius: 8,
          padding: 20,
          width: "90%",
          maxWidth: 420,
          maxHeight: "70vh",
          border: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>Add to card</h2>

        <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, minHeight: 0 }}>
          {openCards.length === 0 && <div style={{ fontSize: 13, color: "var(--text-muted)" }}>No open cards yet — create one below.</div>}
          {openCards.map((card) => (
            <button
              key={card.id}
              onClick={() => run(onSelect(card.id))}
              disabled={busy}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                textAlign: "left",
                fontSize: 13,
                cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >
              <span>{card.emoji}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{card.title}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{card.chatCount} chats</span>
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
            placeholder="New card title…"
            style={{
              flex: 1,
              background: "var(--surface)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 13,
            }}
          />
          <button
            onClick={create}
            disabled={!newTitle.trim() || busy}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: "var(--accent)",
              color: "var(--text-on-accent)",
              padding: "6px 12px",
              borderRadius: 6,
              fontSize: 13,
              cursor: newTitle.trim() && !busy ? "pointer" : "default",
              opacity: newTitle.trim() && !busy ? 1 : 0.5,
            }}
          >
            <Plus size={14} />
            Create
          </button>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ fontSize: 13, color: "var(--text-muted)", padding: "4px 8px", cursor: "pointer" }}>
            Cancel
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
