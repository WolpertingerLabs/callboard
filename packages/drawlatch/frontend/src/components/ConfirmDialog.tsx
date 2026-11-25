/**
 * ConfirmDialog — reusable destructive-action confirm modal.
 *
 * Mounted by parents conditionally (no `isOpen` prop). Used for any UI action
 * that can lose data: deleting a caller, deleting a listener instance, etc.
 *
 * - Closes on Escape and overlay click (Cancel).
 * - Primary button is danger-styled; runs `onConfirm` (may be async).
 * - Parent owns the busy/error state so the dialog stays open during the
 *   underlying mutation and can surface mutation errors inline.
 */
import { useEffect } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import "./ConfirmDialog.css";

interface ConfirmDialogProps {
  /** Headline above the body copy, e.g. `Delete caller "prod"?` */
  title: string;
  /** Body copy. Can include inline elements (`<code>`, `<strong>`, etc.). */
  description: React.ReactNode;
  /** Primary (danger) button label. Defaults to "Delete". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Disables both buttons and shows a spinner on confirm. */
  busy?: boolean;
  /** Surface a mutation error inline; the dialog stays open. */
  error?: string | null;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  // Close on Escape (only when not busy — don't strand a mid-flight mutation).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, busy]);

  return (
    <div
      className="dl-confirm-overlay"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div
        className="dl-confirm-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="dl-confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dl-confirm-header">
          <div className="dl-confirm-header-text">
            <span className="dl-confirm-icon" aria-hidden="true">
              <AlertTriangle size={18} />
            </span>
            <h2 id="dl-confirm-title" className="dl-confirm-title">
              {title}
            </h2>
          </div>
          <button
            type="button"
            className="dl-confirm-close"
            aria-label="Close"
            disabled={busy}
            onClick={onCancel}
          >
            <X size={16} />
          </button>
        </div>

        <div className="dl-confirm-body">{description}</div>

        {error && <div className="dl-confirm-error">{error}</div>}

        <div className="dl-confirm-footer">
          <button
            type="button"
            className="dl-confirm-btn dl-confirm-btn-secondary"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="dl-confirm-btn dl-confirm-btn-danger"
            disabled={busy}
            onClick={() => void onConfirm()}
            autoFocus
          >
            {busy && <Loader2 size={14} className="dl-confirm-spin" />}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
