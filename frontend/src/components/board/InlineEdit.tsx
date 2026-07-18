import { useState, useRef, useEffect, type CSSProperties } from "react";

interface InlineEditProps {
  value: string;
  onSave: (value: string) => void;
  placeholder?: string;
  /** Render a textarea instead of a single-line input. */
  multiline?: boolean;
  /** Mount straight into the editor — for callers whose display state isn't clickable. */
  startEditing?: boolean;
  /** Fired when editing ends, whether committed or cancelled. */
  onEditingEnd?: () => void;
  style?: CSSProperties;
  inputStyle?: CSSProperties;
}

/**
 * Click-to-edit text. Enter (or blur) commits, Escape cancels. The multiline
 * variant commits on blur only — Enter inserts newlines.
 */
export default function InlineEdit({ value, onSave, placeholder, multiline, startEditing, onEditingEnd, style, inputStyle }: InlineEditProps) {
  const [editing, setEditing] = useState(startEditing ?? false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    onEditingEnd?.();
    if (draft !== value) onSave(draft);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
    onEditingEnd?.();
  };

  if (!editing) {
    return (
      <span
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        title="Click to edit"
        style={{ cursor: "text", ...(!value && { color: "var(--text-muted)", fontStyle: "italic" }), ...style }}
      >
        {value || placeholder || "Click to edit"}
      </span>
    );
  }

  const sharedStyle: CSSProperties = {
    width: "100%",
    background: "var(--bg)",
    color: "var(--text)",
    border: "1px solid var(--accent)",
    borderRadius: 6,
    padding: "4px 8px",
    font: "inherit",
    ...inputStyle,
  };

  if (multiline) {
    return (
      <textarea
        ref={(el) => {
          ref.current = el;
        }}
        value={draft}
        rows={Math.max(4, draft.split("\n").length + 1)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
        }}
        placeholder={placeholder}
        style={{ ...sharedStyle, resize: "vertical" }}
      />
    );
  }

  return (
    <input
      ref={(el) => {
        ref.current = el;
      }}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") cancel();
      }}
      placeholder={placeholder}
      style={sharedStyle}
    />
  );
}
