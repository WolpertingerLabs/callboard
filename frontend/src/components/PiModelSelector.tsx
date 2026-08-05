import { useEffect, useMemo, useRef, useState } from "react";
import { getPiModels } from "../api";

interface Props {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Which pi provider's catalog to offer. Empty falls back to `openrouter`. */
  providerId?: string;
  /** Smaller metrics for the inline (sidebar) placement. */
  compact?: boolean;
}

/**
 * pi's OpenRouter catalog alone is ~300 models, so the list is *always*
 * filtered rather than merely capped for tidiness. Fifty is the same ceiling the
 * ACP and Codex selectors use; the difference is that here it is doing real
 * work on every keystroke.
 */
const MAX_RESULTS = 50;

/** pi's default provider, matching `DEFAULT_PI_PROVIDER_ID` on the backend. */
const DEFAULT_PROVIDER_ID = "openrouter";

interface PiModelOption {
  value: string;
  displayName: string;
  description: string;
}

// No static fallback, deliberately: the catalog ships inside the pi package and
// is answered offline, so there is never a reason to guess. An unreachable
// backend leaves the field as free text, which is the honest state.

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

function inputStyle(compact: boolean): React.CSSProperties {
  return {
    width: "100%",
    padding: compact ? "6px 8px" : "10px 12px",
    borderRadius: compact ? 6 : 8,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontSize: compact ? 12 : 13,
    fontFamily: "monospace",
    boxSizing: "border-box",
  };
}

const rowLabelStyle: React.CSSProperties = {
  fontFamily: "monospace",
  fontSize: 12,
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/**
 * Model picker for pi chats.
 *
 * ## Why a filtering combobox rather than the Cline field
 *
 * The Cline model field is an `<input list>` over a `<datalist>`, which is fine
 * for a catalog of a few dozen. pi's is **~300 models for OpenRouter alone**,
 * measured against the real endpoint, and a native datalist that long is a
 * scroll rather than a picker.
 *
 * So this reuses the {@link AcpModelSelector} shape instead — subsequence
 * filtering, capped results, keyboard navigation. Duplicated rather than
 * abstracted, which is this codebase's explicit stance: "three model fields that
 * behaved differently would cost more than one duplicated combobox". A fourth
 * that behaved differently would cost more still.
 *
 * Subsequence matching means `g36f` finds `google/gemini-3.6-flash` without
 * typing the separators — worth more here than in the smaller catalogs, since
 * pi's ids are all `vendor/model-version-variant`.
 *
 * Empty means "use the default from Settings → API". Anything typed is sent
 * as-is: a slug newer than the bundled catalog still works, because
 * `findPiModel` falls back to pi's own default rather than failing the turn.
 */
export default function PiModelSelector({ id, value, onChange, placeholder, providerId, compact = false }: Props) {
  const [models, setModels] = useState<PiModelOption[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const effectiveProviderId = providerId?.trim() || DEFAULT_PROVIDER_ID;

  useEffect(() => {
    let cancelled = false;
    getPiModels(effectiveProviderId)
      .then((catalog) => {
        if (cancelled) return;
        setModels(catalog.models ?? []);
      })
      .catch(() => {
        // Unreachable server — the field still works as free text, which is the
        // same contract the other model pickers keep.
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch when the user switches providers: catalogs are per-provider.
  }, [effectiveProviderId]);

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

  const { matches, totalMatched } = useMemo(() => {
    const q = value.trim();
    const filtered = q === "" ? models : models.filter((m) => isSubsequence(q, m.value) || isSubsequence(q, m.displayName));
    return { matches: filtered.slice(0, MAX_RESULTS), totalMatched: filtered.length };
  }, [models, value]);

  const select = (model: PiModelOption) => {
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
        style={inputStyle(compact)}
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
          {totalMatched > matches.length && (
            <div
              style={{
                padding: "6px 12px",
                fontSize: 11,
                color: "var(--text-muted)",
                borderBottom: "1px solid var(--border)",
                position: "sticky",
                top: 0,
                background: "var(--surface)",
              }}
            >
              {/* Silence about the cap would read as "these are all of them" on a
                  300-model catalog. Saying so is what turns the cap from a
                  truncation into a prompt to type more. */}
              Showing {matches.length} of {totalMatched} — keep typing to narrow
            </div>
          )}
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
