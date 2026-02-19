import { useState, type CSSProperties } from "react";
import ModalOverlay from "./ModalOverlay";
import type { ChatFilters } from "../types/chatFilters";

interface ChatFilterModalProps {
  isOpen: boolean;
  onClose: () => void;
  filters: ChatFilters;
  onApply: (filters: ChatFilters) => void;
}

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern, "i");
    return true;
  } catch {
    return false;
  }
}

const toggleBtnStyle = (active: boolean): CSSProperties => ({
  padding: "4px 10px",
  borderRadius: 4,
  fontSize: 12,
  fontWeight: 600,
  border: "none",
  cursor: "pointer",
  minWidth: 50,
  background: active ? "var(--accent)" : "var(--bg-secondary)",
  color: active ? "#fff" : "var(--text-muted)",
  transition: "background 0.15s, color 0.15s",
});

const inputStyle = (hasError: boolean): CSSProperties => ({
  flex: 1,
  padding: "8px 10px",
  borderRadius: 6,
  fontSize: 14,
  background: "var(--surface)",
  border: `1px solid ${hasError ? "var(--danger, #dc3545)" : "var(--border)"}`,
  color: "var(--text)",
  outline: "none",
  fontFamily: "monospace",
});

const labelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: "var(--text)",
  marginBottom: 4,
};

export default function ChatFilterModal({ isOpen, onClose, filters, onApply }: ChatFilterModalProps) {
  const [local, setLocal] = useState<ChatFilters>(filters);

  // Reset local state when modal opens with new filters
  // (useEffect not needed since we only render when isOpen is true)
  if (!isOpen) return null;

  const update = <K extends keyof ChatFilters>(key: K, field: Partial<ChatFilters[K]>) => {
    setLocal((prev) => ({
      ...prev,
      [key]: { ...prev[key], ...field },
    }));
  };

  const handleApply = () => {
    onApply(local);
    onClose();
  };

  const handleReset = () => {
    const reset: ChatFilters = {
      directoryInclude: { value: "", active: false },
      directoryExclude: { value: "", active: false },
      dateMin: { value: "", active: false },
      dateMax: { value: "", active: false },
    };
    setLocal(reset);
  };

  const includeRegexValid = !local.directoryInclude.value || isValidRegex(local.directoryInclude.value);
  const excludeRegexValid = !local.directoryExclude.value || isValidRegex(local.directoryExclude.value);

  return (
    <ModalOverlay>
      <div
        style={{
          background: "var(--bg)",
          borderRadius: 8,
          padding: 24,
          width: "90%",
          maxWidth: 480,
          border: "1px solid var(--border)",
        }}
      >
        <h2 style={{ margin: "0 0 20px 0", fontSize: 18 }}>Chat Filters</h2>

        {/* Directory Include Regex */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>Directory Include (regex)</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="text"
              value={local.directoryInclude.value}
              onChange={(e) => update("directoryInclude", { value: e.target.value })}
              placeholder="e.g. my-project|other-repo"
              style={inputStyle(!includeRegexValid)}
            />
            <button type="button" onClick={() => update("directoryInclude", { active: !local.directoryInclude.active })} style={toggleBtnStyle(local.directoryInclude.active)}>
              {local.directoryInclude.active ? "On" : "Off"}
            </button>
          </div>
          {!includeRegexValid && <div style={{ fontSize: 12, color: "var(--danger, #dc3545)", marginTop: 4 }}>Invalid regex pattern</div>}
        </div>

        {/* Directory Exclude Regex */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>Directory Exclude (regex)</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="text"
              value={local.directoryExclude.value}
              onChange={(e) => update("directoryExclude", { value: e.target.value })}
              placeholder="e.g. node_modules|\.tmp"
              style={inputStyle(!excludeRegexValid)}
            />
            <button type="button" onClick={() => update("directoryExclude", { active: !local.directoryExclude.active })} style={toggleBtnStyle(local.directoryExclude.active)}>
              {local.directoryExclude.active ? "On" : "Off"}
            </button>
          </div>
          {!excludeRegexValid && <div style={{ fontSize: 12, color: "var(--danger, #dc3545)", marginTop: 4 }}>Invalid regex pattern</div>}
        </div>

        {/* Minimum Datetime */}
        <div style={{ marginBottom: 16 }}>
          <div style={labelStyle}>Updated After</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="datetime-local"
              value={local.dateMin.value}
              onChange={(e) => update("dateMin", { value: e.target.value })}
              style={{ ...inputStyle(false), fontFamily: "inherit" }}
            />
            <button type="button" onClick={() => update("dateMin", { active: !local.dateMin.active })} style={toggleBtnStyle(local.dateMin.active)}>
              {local.dateMin.active ? "On" : "Off"}
            </button>
          </div>
        </div>

        {/* Maximum Datetime */}
        <div style={{ marginBottom: 24 }}>
          <div style={labelStyle}>Updated Before</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="datetime-local"
              value={local.dateMax.value}
              onChange={(e) => update("dateMax", { value: e.target.value })}
              style={{ ...inputStyle(false), fontFamily: "inherit" }}
            />
            <button type="button" onClick={() => update("dateMax", { active: !local.dateMax.active })} style={toggleBtnStyle(local.dateMax.active)}>
              {local.dateMax.active ? "On" : "Off"}
            </button>
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 12, justifyContent: "space-between" }}>
          <button
            type="button"
            onClick={handleReset}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            Reset All
          </button>

          <div style={{ display: "flex", gap: 12 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                fontSize: 14,
                background: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                color: "var(--text)",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>

            <button
              type="button"
              onClick={handleApply}
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                fontSize: 14,
                background: "var(--accent)",
                color: "#fff",
                border: "none",
                cursor: "pointer",
              }}
            >
              Apply
            </button>
          </div>
        </div>
      </div>
    </ModalOverlay>
  );
}
