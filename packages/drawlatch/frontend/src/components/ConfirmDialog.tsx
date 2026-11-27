/**
 * ConfirmDialog: confirm an action before running it. Built on Modal, so it
 * traps focus, closes only itself on Escape, and stacks above whatever
 * opened it.
 *
 * Mounted by parents conditionally (or pass `open`).
 * - `variant="danger"` (default): red button, warning icon, `alertdialog`.
 *   For anything that loses data.
 * - `variant="neutral"`: accent button, no warning styling. For a
 *   confirmation that isn't destructive (revealing a vault value).
 * - Focus starts on Cancel, so Enter alone never confirms a deletion.
 * - Parent owns `busy` / `error`: the dialog stays open during the mutation
 *   (nothing can close it while busy) and shows a failure inline.
 */
import { useId, useRef } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import Modal from "./Modal";
import "./ConfirmDialog.css";

interface ConfirmDialogProps {
  /** Headline above the body copy, e.g. `Delete caller "prod"?` */
  title: string;
  /** Body copy. Can include inline elements (`<code>`, `<strong>`, etc.). */
  description: React.ReactNode;
  /** Confirm button label. Defaults to "Delete". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** "danger" (default) or "neutral". */
  variant?: "danger" | "neutral";
  /** Disables both buttons, shows a spinner on confirm, and blocks closing. */
  busy?: boolean;
  /** Surface a mutation error inline; the dialog stays open. */
  error?: string | null;
  /** Defaults to true, for parents that mount the dialog conditionally. */
  open?: boolean;
  /** Where focus goes on close (see Modal). Useful when confirming removes
   *  the button that opened the dialog. */
  returnFocusRef?: React.RefObject<HTMLElement>;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  description,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  variant = "danger",
  busy = false,
  error = null,
  open = true,
  returnFocusRef,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const descId = useId();
  const danger = variant === "danger";

  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      size="sm"
      nested
      busy={busy}
      role={danger ? "alertdialog" : "dialog"}
      icon={danger ? <AlertTriangle size={18} /> : undefined}
      iconTone="danger"
      describedBy={descId}
      initialFocusRef={cancelRef}
      returnFocusRef={returnFocusRef}
      className="dl-confirm-panel"
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            className="btn btn-secondary"
            disabled={busy}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${danger ? "btn-danger" : "btn-primary"}`}
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            {busy && <Loader2 size={14} className="spinner" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div id={descId} className="dl-confirm-body">
        {description}
      </div>
      {error && (
        <div className="modal-error dl-confirm-error" role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}
