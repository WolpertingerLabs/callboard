import { useState, type CSSProperties, type ReactNode } from "react";
import { ArrowUpNarrowWide, Bookmark, Zap, LayoutGrid, SunDim } from "lucide-react";
import ModalOverlay from "./ModalOverlay";
import { DEFAULT_CHAT_VIEW_OPTIONS, type CardLifecycleFilter, type ChatFilters, type ChatViewOptions } from "../types/chatFilters";

interface ChatFilterModalProps {
  onClose: () => void;
  filters: ChatFilters;
  viewOptions: ChatViewOptions;
  /** Both halves are staged locally and committed together on Apply. */
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

const sectionHeadingStyle: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.6,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  marginBottom: 10,
};

/** One switch row: icon, label, one line of why-you'd-want-it, and the switch. */
function SwitchRow({
  icon,
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  checked: boolean;
  onChange: () => void;
  /** Inert because another option has already decided this one. The hint says which. */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 10px",
        borderRadius: 8,
        border: "none",
        background: checked && !disabled ? "var(--accent-bg)" : "transparent",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
        textAlign: "left",
        transition: "background 0.15s",
      }}
    >
      <span style={{ display: "flex", color: checked ? "var(--accent-text)" : "var(--text-muted)", flexShrink: 0, transition: "color 0.15s" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{label}</span>
        <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>{hint}</span>
      </span>
      <span
        style={{
          position: "relative",
          width: 36,
          height: 20,
          borderRadius: 999,
          flexShrink: 0,
          background: checked ? "var(--accent)" : "var(--border)",
          transition: "background 0.15s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: checked ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "var(--toggle-knob)",
            transition: "left 0.15s",
          }}
        />
      </span>
    </button>
  );
}

/**
 * One three-way choice: icon, label, hint, and a segmented control.
 *
 * A segmented control rather than a third switch because the states are
 * mutually exclusive and one of them is the default: two toggles would need a
 * rule for what both-off means, and the whole point of this option is that
 * "neither active nor inactive" is a real, distinct answer (show everything).
 */
function ChoiceRow<T extends string>({
  icon,
  label,
  hint,
  value,
  options,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  const isDefault = value === options[0].value;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 10px",
        borderRadius: 8,
        background: isDefault ? "transparent" : "var(--accent-bg)",
        transition: "background 0.15s",
      }}
    >
      <span style={{ display: "flex", color: isDefault ? "var(--text-muted)" : "var(--accent-text)", flexShrink: 0, transition: "color 0.15s" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text)" }}>{label}</span>
        <span style={{ display: "block", fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>{hint}</span>
      </span>
      <span style={{ display: "flex", gap: 4, flexShrink: 0 }} role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            style={{
              padding: "4px 8px",
              borderRadius: 4,
              fontSize: 11,
              fontWeight: 600,
              border: "none",
              cursor: "pointer",
              background: value === option.value ? "var(--accent)" : "var(--bg-secondary)",
              color: value === option.value ? "var(--text-on-accent)" : "var(--text-muted)",
              transition: "background 0.15s, color 0.15s",
            }}
          >
            {option.label}
          </button>
        ))}
      </span>
    </div>
  );
}

const CARD_LIFECYCLE_OPTIONS: { value: CardLifecycleFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
];

const CARD_LIFECYCLE_HINTS: Record<CardLifecycleFilter, string> = {
  all: "Every chat, whatever its card is doing",
  active: "Only chats on an open card, plus their descendants",
  inactive: "Only chats on a closed card — or on no card at all",
};

/**
 * Staged editor for the sidebar's filters AND view options — nothing takes
 * effect until Apply, so a half-typed regex never reshuffles the list.
 *
 * The caller mounts this only while it is open, which is what makes the
 * `useState(prop)` seeding correct: every open starts from the live values, so
 * Cancel genuinely discards instead of leaving edits staged for next time.
 */
export default function ChatFilterModal({ onClose, filters, viewOptions, onApply }: ChatFilterModalProps) {
  const [local, setLocal] = useState<ChatFilters>(filters);
  const [localView, setLocalView] = useState<ChatViewOptions>(viewOptions);

  const toggleView = (key: "bookmarked" | "showTriggered" | "dimCardless" | "sortByCardActive") =>
    setLocalView((prev) => ({ ...prev, [key]: !prev[key] }));

  /**
   * `cardsOnly` is written alongside, in lock-step: it is the deprecated alias
   * of `active`, persisted by older bundles, and keeping the pair consistent is
   * what makes a downgrade land on the same scope instead of silently widening
   * the sidebar to everything.
   */
  const setCardLifecycle = (cardLifecycle: CardLifecycleFilter) =>
    setLocalView((prev) => ({ ...prev, cardLifecycle, cardsOnly: cardLifecycle === "active" }));

  const update = <K extends keyof ChatFilters>(key: K, field: Partial<ChatFilters[K]>) => {
    setLocal((prev) => ({
      ...prev,
      [key]: { ...prev[key], ...field },
    }));
  };

  const handleApply = () => {
    onApply(local, localView);
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
    setLocalView(DEFAULT_CHAT_VIEW_OPTIONS);
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
          // The View section doubles this modal's height — on a phone in
          // landscape it would otherwise run off the bottom with Apply
          // unreachable.
          maxHeight: "85vh",
          overflowY: "auto",
        }}
      >
        <h2 style={{ margin: "0 0 20px 0", fontSize: 18 }}>Chat Filters</h2>

        {/* View — what the sidebar is scoped to. Resolved server-side (or by
            how the list renders what it holds), unlike the client-side field
            filters below. */}
        <div style={{ marginBottom: 20 }}>
          <div style={sectionHeadingStyle}>View</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <ChoiceRow
              icon={<LayoutGrid size={16} />}
              label="Card lifecycle"
              hint={CARD_LIFECYCLE_HINTS[localView.cardLifecycle]}
              value={localView.cardLifecycle}
              options={CARD_LIFECYCLE_OPTIONS}
              onChange={setCardLifecycle}
            />
            {/* Directly under the scope rather than last in the block: it is
                the option that makes this one inert, and a disabled switch whose
                reason is three rows away reads as a bug. Either non-default
                scope already answers the question these two ask — every row on
                screen is then on the same side of the split. */}
            <SwitchRow
              icon={<SunDim size={16} />}
              label="Dim inactive chats"
              hint={
                localView.cardLifecycle !== "all"
                  ? `Nothing to dim — the list is already scoped to ${localView.cardLifecycle} cards`
                  : "Fade chats with no card, or a closed one"
              }
              checked={localView.dimCardless}
              onChange={() => toggleView("dimCardless")}
              disabled={localView.cardLifecycle !== "all"}
            />
            <SwitchRow
              icon={<ArrowUpNarrowWide size={16} />}
              label="Active cards first"
              hint={
                localView.cardLifecycle !== "all"
                  ? `Nothing to split — the list is already scoped to ${localView.cardLifecycle} cards`
                  : "Group chats on an open card above the rest, under headers"
              }
              checked={localView.sortByCardActive}
              onChange={() => toggleView("sortByCardActive")}
              disabled={localView.cardLifecycle !== "all"}
            />
            <SwitchRow
              icon={<Bookmark size={16} fill={localView.bookmarked ? "currentColor" : "none"} />}
              label="Bookmarked only"
              hint="Chats you've starred"
              checked={localView.bookmarked}
              onChange={() => toggleView("bookmarked")}
            />
            <SwitchRow
              icon={<Zap size={16} fill={localView.showTriggered ? "currentColor" : "none"} />}
              label="Show triggered chats"
              hint="Include runs started by cron, triggers and jobs"
              checked={localView.showTriggered}
              onChange={() => toggleView("showTriggered")}
            />
          </div>
        </div>

        <div style={{ height: 1, background: "var(--border)", margin: "0 0 20px 0" }} />
        <div style={sectionHeadingStyle}>Filters</div>

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
