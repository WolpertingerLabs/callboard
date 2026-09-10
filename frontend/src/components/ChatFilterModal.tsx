import { useState, type CSSProperties } from "react";
import ModalOverlay from "./ModalOverlay";
import type { ChatFilters, ChatViewOptions } from "../types/chatFilters";

interface ChatFilterModalProps {
  onClose: () => void;
  filters: ChatFilters;
  /**
   * Not edited here — carried, so that `onApply` keeps its one signature and
   * this dialog cannot reset a scope it does not show. See the note below.
   */
  viewOptions: ChatViewOptions;
  /** The filters are staged locally and committed on Apply. */
  onApply: (filters: ChatFilters, viewOptions: ChatViewOptions) => void;
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
  color: active ? "var(--text-on-accent)" : "var(--text-muted)",
  transition: "background 0.15s, color 0.15s",
});

const inputStyle = (hasError: boolean): CSSProperties => ({
  flex: 1,
  padding: "8px 10px",
  borderRadius: 6,
  fontSize: 14,
  background: "var(--surface)",
  border: `1px solid ${hasError ? "var(--danger)" : "var(--border)"}`,
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

/**
 * Staged editor for the sidebar's four field filters — nothing takes effect
 * until Apply, so a half-typed regex never reshuffles the list.
 *
 * It owns nothing else. All three view options are toggle buttons in the filter
 * bar now, committed on the click, and this dialog does not display them — so
 * `viewOptions` is carried from prop straight back to `onApply` and never
 * copied into state.
 *
 * That is the whole defence, and it is worth knowing what it replaced. A
 * `localView` snapshot used to be seeded at mount and never re-synced, which
 * made this modal capable of writing a value it did not show: the bar and the
 * modal are siblings and the overlay stops the mouse but not the keyboard, so
 * one Tab out of the filters button reaches a scope toggle and Space commits
 * it — and an Apply after that handed back the stale mount-time value,
 * reverting a change the user had just watched take effect. Reading the live
 * prop instead removes the hazard rather than guarding against it; there is no
 * staged copy left to go stale, and Reset All resets the filters only for the
 * same reason.
 *
 * The caller mounts this only while it is open, which is what makes the
 * `useState(prop)` seeding correct for the filters it DOES own: every open
 * starts from the live values, so Cancel genuinely discards instead of leaving
 * edits staged for next time.
 */
export default function ChatFilterModal({ onClose, filters, viewOptions, onApply }: ChatFilterModalProps) {
  const [local, setLocal] = useState<ChatFilters>(filters);

  const update = <K extends keyof ChatFilters>(key: K, field: Partial<ChatFilters[K]>) => {
    setLocal((prev) => ({
      ...prev,
      [key]: { ...prev[key], ...field },
    }));
  };

  const handleApply = () => {
    // The view options come off the live prop: the bar can have committed one
    // while this dialog was open, and this dialog has no opinion about them.
    onApply(local, viewOptions);
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
    // "All" is all of what this dialog shows. The scopes survive it, because
    // resetting them from here would silently switch off toggle buttons the
    // user can see lit in the bar behind the dialog, from a control they
    // cannot see at all.
  };

  const includeRegexValid = !local.directoryInclude.value || isValidRegex(local.directoryInclude.value);
  const excludeRegexValid = !local.directoryExclude.value || isValidRegex(local.directoryExclude.value);

  return (
    <ModalOverlay onClose={onClose}>
      <div
        style={{
          background: "var(--bg)",
          borderRadius: 8,
          padding: 24,
          width: "90%",
          maxWidth: 480,
          border: "1px solid var(--border)",
          // Four fields fit on a phone in landscape; the View section that used
          // to sit above them did not, and Apply went off the bottom with it.
          // Kept anyway, because a scrollable dialog costs nothing when it does
          // not need to scroll.
          maxHeight: "85vh",
          overflowY: "auto",
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
            <button
              type="button"
              onClick={() => update("directoryInclude", { active: !local.directoryInclude.active })}
              style={toggleBtnStyle(local.directoryInclude.active)}
            >
              {local.directoryInclude.active ? "On" : "Off"}
            </button>
          </div>
          {!includeRegexValid && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>Invalid regex pattern</div>}
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
            <button
              type="button"
              onClick={() => update("directoryExclude", { active: !local.directoryExclude.active })}
              style={toggleBtnStyle(local.directoryExclude.active)}
            >
              {local.directoryExclude.active ? "On" : "Off"}
            </button>
          </div>
          {!excludeRegexValid && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 4 }}>Invalid regex pattern</div>}
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
                color: "var(--text-on-accent)",
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
