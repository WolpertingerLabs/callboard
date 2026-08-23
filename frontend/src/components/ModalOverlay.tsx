import type { ReactNode, CSSProperties } from "react";
import ErrorBoundary from "./ErrorBoundary";

interface ModalOverlayProps {
  children: ReactNode;
  /** Additional styles applied to the overlay container */
  style?: CSSProperties;
  /**
   * The dialog's own close handler, used only when its content crashes: the
   * fallback's "Dismiss" runs it so the modal closes in the *parent's* state.
   *
   * Optional because not every call site has one to hand, but pass it if you
   * do. Without it, Dismiss hides the fallback and nothing more — the parent
   * still believes the dialog is open, so re-opening it sets state that has
   * not changed, React bails out, and the button appears to do nothing at all.
   */
  onClose?: () => void;
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: "var(--overlay-bg)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

/**
 * Full-screen overlay backdrop for modals.
 *
 * Replaces the ~10-line inline style block that was duplicated
 * across ConfirmModal, DraftModal, ScheduleModal, FolderBrowser,
 * SlashCommandsModal, and Queue.
 *
 * Being that shared ancestor also makes it the cheapest place to contain a
 * dialog that throws — one boundary here covers every modal in the app,
 * including the workspace manager whose `removability` row took the whole SPA
 * down during #364's review. The boundary wraps the backdrop rather than the
 * children so that "Dismiss" can remove the backdrop too; a fallback rendered
 * *inside* it would leave a full-screen click trap with no way out, since the
 * dialog that threw owns the Escape handler and the close button.
 *
 * What it covers is **descendant components** — see `ErrorBoundary`'s note on
 * the seam, which is narrower than "everything a modal does".
 */
export default function ModalOverlay({ children, style, onClose }: ModalOverlayProps) {
  return (
    <ErrorBoundary region="This dialog" variant="modal" onDismiss={onClose}>
      <div style={{ ...overlayStyle, ...style }}>{children}</div>
    </ErrorBoundary>
  );
}
