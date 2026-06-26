import { useEffect, useMemo, useRef, useState } from "react";
import { getOpenRouterCatalog, type OpenRouterModelInfo, type OpenRouterModelAliasInfo } from "../api";

interface Props {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /**
   * Hide user-defined aliases from the dropdown. Used by the alias manager's
   * target picker — alias targets must be real model slugs, not other aliases.
   */
  excludeAliases?: boolean;
  /**
   * Float models whose slug starts with this prefix to the top of the list
   * (e.g. "anthropic/" for the Claude Code picker, "openai/" for Codex), while
   * still listing every model. Stable — relative order is otherwise preserved.
   */
  priorityPrefix?: string;
}

const MAX_RESULTS = 50;

// One dropdown row — either a user-defined alias (pinned first) or a model.
type Entry = { kind: "alias"; alias: OpenRouterModelAliasInfo } | { kind: "model"; model: OpenRouterModelInfo };

// Case-insensitive subsequence test: every char of `query` appears in `target`
// in order (not necessarily contiguous). "claop" matches "anthropic/claude-opus".
function isSubsequence(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let i = 0;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) i++;
  }
  return i === q.length;
}

// Convert OpenRouter's per-token USD price into a clean per-1M-token display:
//  - free  -> "0"
//  - whole dollars >= 1 -> no decimals ("$30")
//  - otherwise -> two decimals ("$1.25", "$0.08")
function formatPrice(perToken: string): string {
  const perMillion = parseFloat(perToken) * 1_000_000;
  if (!isFinite(perMillion) || perMillion <= 0) return "0";
  const rounded = Math.round(perMillion * 100) / 100;
  if (rounded >= 1 && Number.isInteger(rounded)) return `$${rounded}`;
  return `$${rounded.toFixed(2)}`;
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

export default function OpenRouterModelSelector({ id, value, onChange, placeholder, excludeAliases, priorityPrefix }: Props) {
  const [models, setModels] = useState<OpenRouterModelInfo[]>([]);
  const [aliases, setAliases] = useState<OpenRouterModelAliasInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    getOpenRouterCatalog()
      .then(({ models: m, aliases: a }) => {
        if (cancelled) return;
        setModels(m);
        setAliases(a);
      })
      .catch(() => {
        // Offline / not configured — the field still works as free text entry.
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

  // Aliases match on either the alias name or the target slug, and are
  // pinned above the model list so custom names surface first.
  const matches = useMemo(() => {
    const q = value.trim();
    const aliasMatches = excludeAliases ? [] : q === "" ? aliases : aliases.filter((a) => isSubsequence(q, a.alias) || isSubsequence(q, a.modelId));
    let modelMatches = q === "" ? models : models.filter((m) => isSubsequence(q, m.id));
    // Float the harness's native family to the top (stable partition) when a
    // priority prefix is given, so e.g. anthropic/* surfaces first for Claude Code.
    if (priorityPrefix) {
      const prefixed = modelMatches.filter((m) => m.id.startsWith(priorityPrefix));
      const rest = modelMatches.filter((m) => !m.id.startsWith(priorityPrefix));
      modelMatches = [...prefixed, ...rest];
    }
    const entries: Entry[] = [
      ...aliasMatches.map((alias) => ({ kind: "alias" as const, alias })),
      ...modelMatches.map((model) => ({ kind: "model" as const, model })),
    ];
    return entries.slice(0, MAX_RESULTS);
  }, [models, aliases, value, excludeAliases, priorityPrefix]);

  const select = (entry: Entry) => {
    onChange(entry.kind === "alias" ? entry.alias.alias : entry.model.id);
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
            boxShadow: "0 6px 20px rgba(0,0,0,0.25)",
          }}
        >
          {matches.map((entry, i) => {
            const key = entry.kind === "alias" ? `alias:${entry.alias.alias}` : entry.model.id;
            const title = entry.kind === "alias" ? (entry.alias.name ?? entry.alias.modelId) : entry.model.name;
            const promptPrice = entry.kind === "alias" ? entry.alias.promptPrice : entry.model.promptPrice;
            const completionPrice = entry.kind === "alias" ? entry.alias.completionPrice : entry.model.completionPrice;
            const hasPricing = promptPrice !== undefined && completionPrice !== undefined;
            return (
              <div
                key={key}
                onMouseDown={(e) => {
                  // mousedown (not click) so it fires before the input blur.
                  e.preventDefault();
                  select(entry);
                }}
                onMouseEnter={() => setHighlight(i)}
                title={title}
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
                {entry.kind === "alias" ? (
                  <span style={rowLabelStyle}>
                    <span style={{ color: "var(--accent)" }}>{entry.alias.alias}</span>
                    <span style={{ color: "var(--text-muted)" }}> → {entry.alias.modelId}</span>
                  </span>
                ) : (
                  <span style={rowLabelStyle}>{entry.model.id}</span>
                )}
                <span
                  title={hasPricing ? `Pricing per 1M tokens — in: ${formatPrice(promptPrice)}, out: ${formatPrice(completionPrice)}` : "Pricing unknown"}
                  style={{
                    flexShrink: 0,
                    fontSize: 11,
                    color: "var(--text-muted)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {hasPricing ? `${formatPrice(promptPrice)} / ${formatPrice(completionPrice)}` : "—"}
                </span>
              </div>
            );
          })}
          <div style={{ padding: "4px 12px", fontSize: 10, color: "var(--text-muted)", textAlign: "right" }}>in / out per 1M tokens</div>
        </div>
      )}
    </div>
  );
}
