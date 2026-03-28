import { useState } from "react";
import { createDraft, updateDraft, type DefaultPermissions } from "../api";
import ModalOverlay from "./ModalOverlay";

interface DraftModalProps {
  isOpen: boolean;
  onClose: () => void;
  chatId: string | null;
  message: string;
  onSuccess?: () => void;
  folder?: string;
  defaultPermissions?: DefaultPermissions;
  existingDraftId?: string | null;
}

export default function DraftModal({ isOpen, onClose, chatId, message, onSuccess, folder, defaultPermissions, existingDraftId }: DraftModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const isUpdate = !!existingDraftId;

  const handleSaveDraft = async () => {
    if (!message.trim()) return;

    setIsSubmitting(true);
    setError(null);

    try {
      if (existingDraftId) {
        await updateDraft(existingDraftId, message.trim());
      } else {
        await createDraft(chatId, message.trim(), folder, defaultPermissions);
      }
      onSuccess?.();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to save draft");
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
        <h2 style={{ margin: "0 0 16px 0", fontSize: 18 }}>{isUpdate ? "Update Draft" : chatId ? "Save Message" : "Save New Chat Message"}</h2>

        {!chatId && folder && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Folder: {folder}</div>
          </div>
        )}

        <div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontSize: 14, fontWeight: 500 }}>Message:</label>
            <div
              style={{
                background: "var(--surface)",
                padding: 12,
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 14,
                maxHeight: 120,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                color: "var(--text)",
              }}
            >
              {message || "No message content"}
            </div>
          </div>

          {error && (
            <div
              style={{
                color: "var(--danger)",
                fontSize: 12,
                marginBottom: 16,
                padding: 8,
                background: "var(--danger-bg)",
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
              onClick={handleSaveDraft}
              disabled={isSubmitting || !message.trim()}
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                fontSize: 14,
                background: isSubmitting || !message.trim() ? "var(--border)" : "var(--accent)",
                color: "var(--text-on-accent)",
                border: "none",
                cursor: isSubmitting || !message.trim() ? "default" : "pointer",
              }}
            >
              {isSubmitting ? "Saving..." : isUpdate ? "Update Draft" : "Save Draft"}
            </button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  );
}
