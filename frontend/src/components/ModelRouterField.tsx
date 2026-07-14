import type { ModelRoutingConfig } from "shared/types/index.js";
import OpenRouterModelSelector from "./OpenRouterModelSelector";

interface ModelRouterFieldProps {
  // `panel` stacks the hint text; `inline` (chat composer) drops it for space.
  mode?: "panel" | "inline";
  routingConfig: ModelRoutingConfig | null;
  // false = pick a model manually; true = let the router classify the prompt.
  useRouter: boolean;
  onUseRouterChange: (v: boolean) => void;
  rankId: string;
  onRankChange: (v: string) => void;
  // Manual OpenRouter slug. Empty string = "use global default from Settings → API".
  model: string;
  onModelChange: (v: string) => void;
  // Disambiguates input ids when the field renders more than once on a page.
  idPrefix?: string;
}

/**
 * OpenRouter model selection with a Manual ↔ Router segmented switch.
 *
 * Replaces the old "always-visible model picker + separate 'Use model router'
 * checkbox" layout, where the router silently overrode a still-visible model
 * field. Here the two are mutually exclusive: flipping the switch swaps the
 * manual model selector for the router's tier picker, so only the control that
 * actually applies is ever shown. Rendered inside {@link ProviderConfigPicker}'s
 * OpenRouter model slot so it sits beside the reasoning-effort selector.
 */
export default function ModelRouterField({
  mode = "panel",
  routingConfig,
  useRouter,
  onUseRouterChange,
  rankId,
  onRankChange,
  model,
  onModelChange,
  idPrefix = "modelRouter",
}: ModelRouterFieldProps) {
  const inline = mode === "inline";
  const ranks = [...(routingConfig?.ranks ?? [])].sort((a, b) => a.order - b.order);

  const segButton = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: inline ? "3px 8px" : "4px 10px",
    fontSize: inline ? 11 : 12,
    fontWeight: active ? 600 : 500,
    borderRadius: 5,
    border: "none",
    background: active ? "var(--surface)" : "transparent",
    color: active ? "var(--text)" : "var(--text-muted)",
    boxShadow: active ? "var(--shadow-sm)" : "none",
    cursor: "pointer",
    transition: "all 0.15s",
  });

  const controlStyle: React.CSSProperties = {
    width: "100%",
    padding: inline ? "6px 8px" : "8px 12px",
    fontSize: inline ? 12 : 13,
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    cursor: "pointer",
  };

  return (
    <div>
      {/* Header row: "Model" label + Manual/Router segmented switch. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: inline ? 4 : 6 }}>
        <label
          htmlFor={useRouter ? `${idPrefix}Rank` : `${idPrefix}Model`}
          style={{ fontSize: inline ? 11 : 13, fontWeight: 600, color: "var(--text-muted)" }}
        >
          Model
        </label>
        <div
          role="tablist"
          aria-label="Model selection mode"
          style={{
            display: "flex",
            gap: 2,
            padding: 2,
            borderRadius: 7,
            background: "var(--bg-secondary)",
            border: "1px solid var(--border)",
          }}
        >
          <button type="button" role="tab" aria-selected={!useRouter} onClick={() => onUseRouterChange(false)} style={segButton(!useRouter)}>
            Manual
          </button>
          <button type="button" role="tab" aria-selected={useRouter} onClick={() => onUseRouterChange(true)} style={segButton(useRouter)}>
            Router
          </button>
        </div>
      </div>

      {useRouter ? (
        <>
          <select id={`${idPrefix}Rank`} value={rankId} onChange={(e) => onRankChange(e.target.value)} style={controlStyle}>
            {ranks.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          {!inline && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              Classifies your first prompt, then picks a model for this tier automatically.
            </div>
          )}
        </>
      ) : (
        <>
          <OpenRouterModelSelector
            id={`${idPrefix}Model`}
            value={model}
            onChange={onModelChange}
            placeholder={inline ? "(default)" : "(default — uses Settings → API)"}
          />
          {!inline && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Optional — leave empty to use the global default from Settings → API.</div>
          )}
        </>
      )}
    </div>
  );
}
