import { useEffect, useMemo, useRef, useState } from "react";
import { getSystemInfo, type SystemInfoModel } from "../api";

interface Props {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

const MAX_RESULTS = 50;

// Anthropic model aliases the Claude Code CLI always accepts, pinned above
// the SDK-reported model list. "opusplan" runs Opus for plan mode and Sonnet
// otherwise.
const STATIC_ALIASES: SystemInfoModel[] = [
  { value: "opus", displayName: "Opus", description: "Resolves to the default Opus model" },
  { value: "sonnet", displayName: "Sonnet", description: "Resolves to the default Sonnet model" },
  { value: "haiku", displayName: "Haiku", description: "Resolves to the default Haiku model" },
  { value: "opusplan", displayName: "Opus Plan", description: "Opus in plan mode, Sonnet otherwise" },
];

// Case-insensitive subsequence test: every char of `query` appears in `target`
// in order (not necessarily contiguous). "son46" matches "claude-sonnet-4-6".
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

// Module-level cache so the selector doesn't re-hit /system-info every time
// a picker mounts (NewChatPanel, composer popover, cron form).
let cachedModels: SystemInfoModel[] | null = null;

/**
 * Anthropic model picker for Claude Code chats. Free-text input with
 * suggestions: the static CLI aliases (opus/sonnet/haiku/opusplan) pinned
 * first, then the models the SDK reports as available for the configured
 * auth (from /system-info). Anything typed is accepted as-is — the list can
 * be empty (cold cache, fetch failure) and must never block selection.
 */
export default function ClaudeModelSelector({ id, value, onChange, placeholder }: Props) {
  const [models, setModels] = useState<SystemInfoModel[]>(cachedModels ?? []);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cachedModels) return;
    let cancelled = false;
    getSystemInfo()
      .then((info) => {
        if (cancelled) return;
        cachedModels = info.models ?? [];
        setModels(cachedModels);
      })
      .catch(() => {
        // Offline / cache not warm — the field still works as free text entry.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    const all = [...STATIC_ALIASES, ...models];
    const filtered = q === "" ? all : all.filter((m) => isSubsequence(q, m.value) || isSubsequence(q, m.displayName));
    return filtered.slice(0, MAX_RESULTS);
  }, [models, value]);

  const select = (model: SystemInfoModel) => {
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
