import { useState } from "react";
import type { CardPayload } from "../../api";
import { CARD_CATEGORY_MAX } from "../../api";
import ModalOverlay from "../ModalOverlay";
import { Plus } from "lucide-react";

interface NewCardModalProps {
  /** Existing category labels offered as autocomplete suggestions. */
  categories: string[];
  onCreate: (payload: CardPayload) => void | Promise<void>;
  onClose: () => void;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--surface)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 13,
};

/** Draft a card locally — nothing is created until the user saves. */
export default function NewCardModal({ categories, onCreate, onClose }: NewCardModalProps) {
  const [title, setTitle] = useState("");
  const [emoji, setEmoji] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const canCreate = title.trim().length > 0 && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    try {
      await onCreate({
        title: title.trim(),
        ...(emoji.trim() && { emoji: emoji.trim() }),
        ...(category.trim() && { category: category.trim() }),
        ...(description.trim() && { description }),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalOverlay>
      <div
        style={{
          background: "var(--bg)",
          borderRadius: 8,
          padding: 20,
          width: "90%",
          maxWidth: 440,
          border: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>New card</h2>

        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            placeholder="🗂️"
            title="Emoji (optional)"
            style={{ ...inputStyle, width: 52, textAlign: "center", flexShrink: 0 }}
          />
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
              if (e.key === "Escape") onClose();
            }}
            placeholder="Card title"
            style={inputStyle}
          />
        </div>

        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          maxLength={CARD_CATEGORY_MAX}
          list="new-card-category-options"
          placeholder="Category (optional — groups the card on the board)"
          style={inputStyle}
        />
        {categories.length > 0 && (
          <datalist id="new-card-category-options">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        )}

        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          placeholder="Description (optional, markdown supported)"
          rows={4}
          style={{ ...inputStyle, resize: "vertical" }}
        />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ background: "transparent", fontSize: 13, color: "var(--text-muted)", padding: "6px 10px", cursor: "pointer" }}>
            Cancel
          </button>
          <button
            onClick={create}
            disabled={!canCreate}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: "var(--accent)",
              color: "var(--text-on-accent)",
              padding: "6px 14px",
              borderRadius: 6,
              fontSize: 13,
              cursor: canCreate ? "pointer" : "default",
              opacity: canCreate ? 1 : 0.5,
            }}
          >
            <Plus size={14} />
            Create card
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
