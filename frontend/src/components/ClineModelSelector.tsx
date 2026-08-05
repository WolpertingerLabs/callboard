import { useEffect, useMemo, useRef, useState } from "react";
import { getClineModels } from "../api";

interface Props {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /**
   * Which Cline provider's catalog to offer — the one configured in
   * Settings → API, surfaced on `/api/system-info` as `clineProviderId`.
   *
   * This is what makes "use my OpenRouter models" work without a special case:
   * Cline ships `openrouter` as a provider id, so a user who selects it gets
   * OpenRouter's ~270 slugs here, and one on `anthropic` gets Anthropic's.
   * Empty falls back to `anthropic`, the adapter's own default.
   */
  providerId: string;
}

const MAX_RESULTS = 50;

interface ClineModelOption {
  value: string;
  displayName: string;
  description: string;
}

// No static fallback, and unlike the ACP selector none is needed: Cline answers
// from its provider layer without a session ever having run, so a user who has
// never opened a Cline chat still gets a full list. An empty list here means the
// provider could not be reached — the field stays free text either way.

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
 * Model picker for Cline chats. Free-text input with suggestions scoped to the
 * configured Cline provider.
 *
 * Interaction is deliberately identical to {@link AcpModelSelector},
 * {@link CodexModelSelector} and {@link ClaudeModelSelector}: four model fields
 * that behaved differently would cost more than one duplicated combobox.
 *
 * Empty means "use the default from Settings → API", and when that is blank too
 * the adapter asks the SDK for the provider's own default rather than sending
 * nothing — an empty model id is rejected by Cline's config schema, which is
 * what once surfaced to a user as a raw validator dump. See
 * `cline/optionsAdapter.resolveDefaultModelId`.
 */
export default function ClineModelSelector({ id, value, onChange, placeholder, providerId }: Props) {
  const [models, setModels] = useState<ClineModelOption[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!providerId) {
      setModels([]);
      return;
    }
    let cancelled = false;
    getClineModels(providerId)
      .then((catalog) => {
        if (cancelled) return;
        setModels(catalog.models ?? []);
      })
      .catch(() => {
        // Unreachable server or a provider whose catalog needs credentials —
        // the field still works as free text, the same contract every other
        // model picker keeps.
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch when the configured provider changes: catalogs are per-provider,
    // and this is what swaps in OpenRouter's list when the user selects it.
  }, [providerId]);

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
    const filtered = q === "" ? models : models.filter((m) => isSubsequence(q, m.value) || isSubsequence(q, m.displayName));
    return filtered.slice(0, MAX_RESULTS);
  }, [models, value]);

  const select = (model: ClineModelOption) => {
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
