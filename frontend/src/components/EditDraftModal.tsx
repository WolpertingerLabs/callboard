import { useState, useEffect, useRef } from "react";
import { updateDraft, type QueueItem } from "../api";
import ModalOverlay from "./ModalOverlay";

interface EditDraftModalProps {
  isOpen: boolean;
  onClose: () => void;
  draft: QueueItem | null;
  onSaved: () => void;
}

export default function EditDraftModal({ isOpen, onClose, draft, onSaved }: EditDraftModalProps) {
  const [editedMessage, setEditedMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isOpen && draft) {
      setEditedMessage(draft.user_message);
      setError(null);
    }
  }, [isOpen, draft]);

  useEffect(() => {
    if (isOpen && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isOpen]);

  if (!isOpen || !draft) return null;

  const trimmed = editedMessage.trim();
  const isUnchanged = trimmed === draft.user_message;
  const canSave = trimmed.length > 0 && !isUnchanged && !isSubmitting;

  const handleSave = async () => {
    if (!canSave) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await updateDraft(draft.id, trimmed);
      onSaved();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to update draft");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ModalOverlay>
      <div
        style={{
          background: "var(--bg)",
          borderRadius: 8,
          padding: 24,
          width: "90%",
          maxWidth: 500,
          border: "1px solid var(--border)",
        }}
      >
        <h2 style={{ margin: "0 0 16px 0", fontSize: 18 }}>Edit Draft</h2>

        {draft.folder && !draft.chat_id && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Folder: {draft.folder}</div>
          </div>
        )}

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", marginBottom: 8, fontSize: 14, fontWeight: 500 }}>Message:</label>
          <textarea
            ref={textareaRef}
            value={editedMessage}
            onChange={(e) => setEditedMessage(e.target.value)}
            style={{
              width: "100%",
              minHeight: 120,
              maxHeight: 300,
              padding: 12,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              fontSize: 14,
              fontFamily: "monospace",
              color: "var(--text)",
              resize: "vertical",
              boxSizing: "border-box",
            }}
          />
        </div>

        {error && (
          <div
            style={{
              color: "var(--danger)",
              fontSize: 12,
              marginBottom: 16,
              padding: 8,
              background: "var(--danger-bg, rgba(255, 0, 0, 0.1))",
              borderRadius: 4,
            }}
          >
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              cursor: isSubmitting ? "default" : "pointer",
            }}
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: canSave ? "var(--accent)" : "var(--border)",
              color: "#fff",
              border: "none",
              cursor: canSave ? "pointer" : "default",
            }}
          >
            {isSubmitting ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
