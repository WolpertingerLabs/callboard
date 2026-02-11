import { useState } from "react";
import { X } from "lucide-react";
import ModalOverlay from "./ModalOverlay";
import { getMaxTurns, saveMaxTurns } from "../utils/localStorage";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Inner content rendered only when the modal is open.
 * Mounting fresh each time ensures state is initialized from localStorage.
 */
function SettingsModalContent({ onClose }: { onClose: () => void }) {
  const [maxTurns, setMaxTurns] = useState(() => getMaxTurns());

  const handleSave = () => {
    const clamped = Math.max(1, Math.min(10000, maxTurns || 200));
    saveMaxTurns(clamped);
    onClose();
  };

  return (
    <ModalOverlay>
      <div
        style={{
          background: "var(--bg)",
          borderRadius: 12,
          border: "1px solid var(--border)",
          width: "90%",
          maxWidth: 420,
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Settings</h2>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: 4,
              display: "flex",
              alignItems: "center",
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div style={{ padding: "20px" }}>
          <div style={{ marginBottom: 6 }}>
            <label
              htmlFor="maxTurns"
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text)",
              }}
            >
              Max Iterations
            </label>
          </div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
            Maximum number of agent turns per message. The agent will stop after this many iterations. Default is 200.
          </div>
          <input
            id="maxTurns"
            type="number"
            min={1}
            max={10000}
            value={maxTurns}
            onChange={(e) => setMaxTurns(parseInt(e.target.value, 10) || 0)}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 14,
              boxSizing: "border-box",
            }}
          />
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 20px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <button
            onClick={onClose}
            style={{
              background: "var(--bg-secondary)",
              color: "var(--text)",
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            style={{
              background: "var(--accent)",
              color: "#fff",
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Save
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  if (!isOpen) return null;
  return <SettingsModalContent onClose={onClose} />;
}
