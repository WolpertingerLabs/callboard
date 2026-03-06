import type { ReactNode, CSSProperties } from "react";

interface ModalOverlayProps {
  children: ReactNode;
  /** Additional styles applied to the overlay container */
  style?: CSSProperties;
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
 */
export default function ModalOverlay({ children, style }: ModalOverlayProps) {
  return <div style={{ ...overlayStyle, ...style }}>{children}</div>;
}
