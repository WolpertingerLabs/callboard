import { useEffect, useLayoutEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Maximize2 } from "lucide-react";
import ModalOverlay from "./ModalOverlay";

/**
 * The fullscreen viewer shared by MediaRenderer and CanvasRenderer.
 *
 * Mounted only while open, so it owns the Escape listener for its lifetime.
 * Closes on Escape, on the × button, and on a click on the backdrop around the
 * frame; a click inside the frame does not close it.
 */
export default function FullscreenFrame({
  onClose,
  caption,
  frameStyle,
  children,
}: {
  onClose: () => void;
  /** Shown centred under the content. */
  caption?: string;
  /** Extra styles for the frame around the content (e.g. a fixed size for an iframe). */
  frameStyle?: CSSProperties;
  children: ReactNode;
}) {
  // Callers pass a fresh inline onClose every render; reading it through a ref
  // keeps the Escape listener attached once per open rather than per render.
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <ModalOverlay onClose={onClose}>
      <div
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "relative",
            cursor: "default",
            maxWidth: "90vw",
            maxHeight: "90vh",
            ...frameStyle,
          }}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              zIndex: 1,
              background: "var(--media-control-bg-strong)",
              border: "none",
              borderRadius: "50%",
              width: 32,
              height: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--media-control-text)",
              fontSize: 18,
              cursor: "pointer",
              lineHeight: 1,
            }}
          >
            &times;
          </button>
          {children}
          {caption && (
            <div
              style={{
                textAlign: "center",
                color: "var(--text-muted)",
                fontSize: 13,
                marginTop: 8,
              }}
            >
              {caption}
            </div>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}

/** The button overlaid on inline content that opens the fullscreen viewer. */
export function FullscreenButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Fullscreen"
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        background: "var(--media-control-bg)",
        border: "none",
        borderRadius: 6,
        width: 28,
        height: 28,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--media-control-text)",
        cursor: "pointer",
        opacity: 0.7,
        transition: "opacity 0.15s",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
      onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.7")}
    >
      <Maximize2 size={14} />
    </button>
  );
}
