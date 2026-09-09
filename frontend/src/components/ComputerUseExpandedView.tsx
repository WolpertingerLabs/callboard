import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ComputerUseObservation, ComputerUseSession } from "shared/types/computerUse.js";
import type { ComputerUseController } from "../hooks/useComputerUseController";
import ComputerUseHeader from "./ComputerUseHeader";
import "./ComputerUseExpandedView.css";

/** Presentation only: the mounted panel remains the sole owner of capture and
 * decoded pixels. Native modal isolation also suppresses the inline input UI. */
export default function ComputerUseExpandedView({
  frame,
  session,
  preview,
  onPreviewChange,
  onClose,
  controller,
}: {
  frame: ComputerUseObservation["frame"];
  session: ComputerUseSession;
  preview: boolean;
  onPreviewChange: (value: boolean) => void;
  onClose: () => void;
  controller: ComputerUseController;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const title = useId();
  useLayoutEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    close.current?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  return createPortal(
    <dialog
      ref={dialog}
      className="computer-use-expanded"
      aria-labelledby={title}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        // Never bubble keyboard events into chat shortcuts or inline input.
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
        if (event.key === "Tab") {
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <div className="computer-use-expanded-toolbar">
        <h2 id={title}>Expanded watch view</h2>
        <button ref={close} onClick={onClose} aria-label="Close expanded view">
          Close
        </button>
        <p className="computer-use-expanded-target">
          {session.kind === "native" ? "Native desktop" : "Managed browser"} · {session.targetLabel ?? session.id}
          {" · "}
          {session.state} · Controller: {session.controller ?? "none"} · Watch only
        </p>
        <div className="computer-use-expanded-controls">
          <span role="status">{preview ? "Live (1 fps)" : "Paused"}</span>
          <button onClick={() => onPreviewChange(!preview)}>{preview ? "Pause" : "Live"}</button>
          <ComputerUseHeader controller={controller} viewOpen />
        </div>
      </div>
      <div className="computer-use-expanded-image">
        <img src={`data:${frame.mimeType};base64,${frame.data}`} alt={`Current ${session.kind} screenshot — watch only`} draggable={false} />
      </div>
    </dialog>,
    document.body,
  );
}
