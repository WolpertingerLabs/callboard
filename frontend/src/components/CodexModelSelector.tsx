import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

const MAX_RESULTS = 50;

interface CodexModelOption {
  value: string;
  displayName: string;
  description: string;
}

// OpenAI models the Codex CLI accepts. Hardcoded v1 (the plan defers a live
// `list_codex_models` endpoint) — gpt-5.x agentic-coding models pinned first,
// then the `o`-series reasoning models. Free text is always accepted, so this
// list is only a suggestion surface and can lag the API without blocking use.
const STATIC_MODELS: CodexModelOption[] = [
  { value: "gpt-5.5", displayName: "GPT-5.5", description: "Latest GPT-5 agentic coding model" },
  { value: "gpt-5.5-codex", displayName: "GPT-5.5 Codex", description: "Codex-tuned GPT-5.5" },
  { value: "gpt-5.1", displayName: "GPT-5.1", description: "GPT-5.1 agentic coding model" },
  { value: "gpt-5.1-codex", displayName: "GPT-5.1 Codex", description: "Codex-tuned GPT-5.1" },
  { value: "gpt-5", displayName: "GPT-5", description: "GPT-5 base model" },
  { value: "gpt-5-codex", displayName: "GPT-5 Codex", description: "Codex-tuned GPT-5" },
  { value: "o4-mini", displayName: "o4-mini", description: "Compact o-series reasoning model" },
  { value: "o3", displayName: "o3", description: "o-series reasoning model" },
  { value: "o3-mini", displayName: "o3-mini", description: "Compact o3 reasoning model" },
];

// Case-insensitive subsequence test: every char of `query` appears in `target`
// in order (not necessarily contiguous). "g55" matches "gpt-5.5".
function isSubsequence(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++;
  }
  return i === q.length;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "monospace",
  boxSizing: "border-box",
};

const rowLabelStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 12,
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/**
 * OpenAI model picker for Codex chats. Free-text input with suggestions: the
 * static gpt-5.x + o-series list. Anything typed is accepted as-is — the CLI
 * validates the model server-side, so the field never blocks selection.
 * Mirrors {@link ClaudeModelSelector}'s interaction model.
 */
export default function CodexModelSelector({ id, value, onChange, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close the dropdown when clicking outside the component.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  const matches = useMemo(() => {
    const q = value.trim();
    const filtered = q === "" ? STATIC_MODELS : STATIC_MODELS.filter((m) => isSubsequence(q, m.value) || isSubsequence(q, m.displayName));
    return filtered.slice(0, MAX_RESULTS);
  }, [value]);

  const select = (model: CodexModelOption) => {
    onChange(model.value);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      if (open && matches[highlight]) {
        e.preventDefault();
        select(matches[highlight]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        style={inputStyle}
      />
      {open && matches.length > 0 && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 20,
            maxHeight: 280,
            overflowY: "auto",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "var(--shadow-md)",
          }}
        >
          {matches.map((model, i) => (
            <div
              key={model.value}
              onMouseDown={(e) => {
                // mousedown (not click) so it fires before the input blur.
                e.preventDefault();
                select(model);
              }}
              onMouseEnter={() => setHighlight(i)}
              title={model.description || model.displayName}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "8px 12px",
                cursor: "pointer",
                background: i === highlight ? "var(--chatlist-item-active-bg)" : "transparent",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <span style={rowLabelStyle}>{model.value}</span>
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 11,
                  color: "var(--text-muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "50%",
                }}
              >
                {model.displayName}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
