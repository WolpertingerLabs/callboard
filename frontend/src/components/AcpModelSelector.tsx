import { useEffect, useMemo, useRef, useState } from "react";
import { getAcpModels } from "../api";

interface Props {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Which ACP vendor's catalog to offer. Empty disables the suggestions. */
  providerId: string;
}

const MAX_RESULTS = 50;

interface AcpModelOption {
  value: string;
  displayName: string;
  description: string;
}

// No static fallback, deliberately. `acp` is one kind covering many vendors
// whose catalogs share nothing — there is no model id that is a sensible guess
// for "some ACP agent". An unseen vendor offers no suggestions and the field
// stays free text, which is the honest state rather than a wrong hint.

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
 * Model picker for ACP chats. Free-text input with suggestions from whatever
 * catalog the vendor has advertised on a previous session — see
 * `adapters/acp/modelCatalog.ts` for why nothing is probed to fill it.
 *
 * Interaction is deliberately identical to {@link CodexModelSelector} and
 * {@link ClaudeModelSelector}: three model fields that behaved differently would
 * cost more than one duplicated combobox.
 *
 * What empty means depends on which field this renders, because there are two
 * rungs below it: on a per-chat picker it falls back to this vendor's entry in
 * `AgentSettings.acpProviderModels` (Settings → API), and on that settings
 * field itself it falls back to the vendor CLI's own configured model. The
 * component takes no position on either — it reports "" and `resolveSessionModel`
 * in `services/claude.ts` walks the chain.
 *
 * Anything typed is sent as-is; unlike the other two the agent *rejects* an
 * unknown model rather than falling back, and the turn fails with the vendor's
 * own message — which is the right outcome, since running on a model the user
 * did not pick would bill them for it.
 */
export default function AcpModelSelector({ id, value, onChange, placeholder, providerId }: Props) {
  const [models, setModels] = useState<AcpModelOption[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!providerId) {
      setModels([]);
      return;
    }
    let cancelled = false;
    getAcpModels(providerId)
      .then((catalog) => {
        if (cancelled) return;
        setModels(catalog.models ?? []);
      })
      .catch(() => {
        // Unknown vendor or unreachable server — the field still works as free
        // text, which is the same contract the other model pickers keep.
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch when the user switches vendors: catalogs are per-vendor.
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

  const select = (model: AcpModelOption) => {
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
