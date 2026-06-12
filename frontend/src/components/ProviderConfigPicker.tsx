import type { AgentProviderKind, EffortLevel } from "../utils/localStorage";
import OpenRouterModelSelector from "./OpenRouterModelSelector";
import ClaudeModelSelector from "./ClaudeModelSelector";

export type ProviderConfigPickerMode = "panel" | "inline";

interface ProviderConfigPickerProps {
  provider: AgentProviderKind;
  onProviderChange: (provider: AgentProviderKind) => void;
  effort: EffortLevel | undefined;
  onEffortChange: (effort: EffortLevel | undefined) => void;
  // OpenRouter model. Empty string = "use global default from Settings → API".
  // Free-form text; OR validates the slug server-side.
  model: string;
  onModelChange: (model: string) => void;
  // Anthropic model for Claude Code chats (alias like "opus" or full ID like
  // "claude-sonnet-4-6"). Empty string = "use global default from Settings →
  // API". Kept separate from `model` so toggling providers restores each
  // one's prior selection. Free-form text; the CLI validates server-side.
  claudeModel: string;
  onClaudeModelChange: (model: string) => void;
  // `null` while /system-info is in flight — OR is treated as available until
  // we know otherwise (the disabled gate only kicks in on an explicit false).
  openRouterConfigured: boolean | null;
  // `null` while in flight or unreachable — the spend-cap line is suppressed.
  // Only consulted in `panel` mode; `inline` mode hides the cap line for space.
  openRouterMaxBudgetUsd: number | null;
  // Opens Settings → API (caller decides how to close any wrapping panel first).
  onOpenApiSettings: () => void;
  // Layout mode. `panel` (default) renders the original stacked vertical
  // layout used in NewChatPanel and the cron form. `inline` renders a
  // compact horizontal row suitable for the chat composer's expandable
  // toggle panel — smaller labels, narrower controls, no spend-cap hint.
  mode?: ProviderConfigPickerMode;
  // When false, the Claude Code vs. OpenRouter toggle is hidden entirely.
  // Use for the chat composer, where the provider is already pinned for the
  // lifetime of the chat and only model/effort are mutable. Defaults true.
  showProviderToggle?: boolean;
}

/**
 * Provider/model/effort picker. Used in three places:
 *  - NewChatPanel — full panel layout, all controls visible.
 *  - CronJobs form — same panel layout, all controls visible.
 *  - Chat.tsx composer — inline horizontal layout, provider toggle hidden
 *    (each chat is pinned to one provider at creation time).
 *
 * The OR-specific knobs (effort, model) only render when the active
 * provider is "openrouter" AND OR is configured (`openRouterConfigured !==
 * false`). Claude Code shows its own model knob (Anthropic alias or full
 * ID, no effort). Each provider's model value lives in a separate prop —
 * switching the toggle swaps the controls while preserving both values, so
 * toggling back restores the prior selection.
 */
export default function ProviderConfigPicker({
  provider,
  onProviderChange,
  effort,
  onEffortChange,
  model,
  onModelChange,
  claudeModel,
  onClaudeModelChange,
  openRouterConfigured,
  openRouterMaxBudgetUsd,
  onOpenApiSettings,
  mode = "panel",
  showProviderToggle = true,
}: ProviderConfigPickerProps) {
  const inline = mode === "inline";
  const showOrKnobs = provider === "openrouter" && openRouterConfigured !== false;
  const showClaudeKnobs = provider === "claude-code";

  // `inline` mode lays the OR controls side-by-side; `panel` mode stacks
  // them. Hoisted so both render paths share the same controls below.
  const orControls = showOrKnobs ? (
    <div style={inline ? { display: "flex", gap: 8, alignItems: "flex-start" } : { display: "block" }}>
      {/* Reasoning effort — OpenRouter only. OR maps the level to each
          provider's native parameter (Anthropic thinking.budget_tokens,
          OpenAI reasoning_effort, etc.); non-reasoning models silently
          ignore it. */}
      <div style={{ marginBottom: inline ? 0 : 12, flex: inline ? "0 0 auto" : undefined, width: inline ? 90 : undefined }}>
        <label
          htmlFor={inline ? "inlineEffort" : "newChatEffort"}
          style={{
            display: "block",
            fontSize: inline ? 11 : 13,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginBottom: inline ? 4 : 6,
          }}
        >
          {inline ? "Effort" : "Reasoning effort"}
        </label>
        <select
          id={inline ? "inlineEffort" : "newChatEffort"}
          value={effort ?? ""}
          onChange={(e) => onEffortChange(e.target.value === "" ? undefined : (e.target.value as EffortLevel))}
          style={{
            width: "100%",
            padding: inline ? "6px 8px" : "8px 12px",
            fontSize: inline ? 12 : 13,
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--surface)",
            color: "var(--text)",
            cursor: "pointer",
          }}
        >
          <option value="">(default)</option>
          <option value="none">none</option>
          <option value="minimal">minimal</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
        </select>
        {!inline && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
            Maps to each provider&apos;s native thinking parameter. Non-reasoning models ignore this.
          </div>
        )}
      </div>

      {/* Per-chat model override — OpenRouter only. Empty value falls back to
          the global default configured in Settings → API. */}
      <div style={{ marginBottom: inline ? 0 : 12, flex: inline ? "1 1 auto" : undefined, minWidth: inline ? 180 : 0 }}>
        <label
          htmlFor={inline ? "inlineModel" : "newChatModel"}
          style={{
            display: "block",
            fontSize: inline ? 11 : 13,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginBottom: inline ? 4 : 6,
          }}
        >
          Model
        </label>
        <OpenRouterModelSelector
          id={inline ? "inlineModel" : "newChatModel"}
          value={model}
          onChange={onModelChange}
          placeholder={inline ? "(default)" : "(default — uses Settings → API)"}
        />
        {!inline && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Optional — leave empty to use the global default from Settings → API.</div>
        )}
      </div>
    </div>
  ) : null;

  // Per-chat Anthropic model — Claude Code only. Empty value falls back to
  // the global default configured in Settings → API (ANTHROPIC_MODEL).
  const claudeControls = showClaudeKnobs ? (
    <div style={{ marginBottom: inline ? 0 : 12, flex: inline ? "1 1 auto" : undefined, minWidth: inline ? 180 : 0 }}>
      <label
        htmlFor={inline ? "inlineClaudeModel" : "newChatClaudeModel"}
        style={{
          display: "block",
          fontSize: inline ? 11 : 13,
          fontWeight: 600,
          color: "var(--text-muted)",
          marginBottom: inline ? 4 : 6,
        }}
      >
        Model
      </label>
      <ClaudeModelSelector
        id={inline ? "inlineClaudeModel" : "newChatClaudeModel"}
        value={claudeModel}
        onChange={onClaudeModelChange}
        placeholder={inline ? "(default)" : "(default — uses Settings → API)"}
      />
      {!inline && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          Optional — alias (opus, sonnet, haiku, opusplan) or full model ID. Leave empty to use the global default from Settings → API.
        </div>
      )}
    </div>
  ) : null;

  return (
    <>
      {showProviderToggle && (
        <div style={{ marginBottom: inline ? 8 : 12 }}>
          <div style={{ fontSize: inline ? 11 : 13, fontWeight: 600, color: "var(--text-muted)", marginBottom: inline ? 4 : 6 }}>Provider</div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              onClick={() => onProviderChange("claude-code")}
              style={{
                flex: 1,
                padding: inline ? "6px 10px" : "8px 12px",
                fontSize: inline ? 12 : 13,
                fontWeight: 500,
                borderRadius: 6,
                border: provider === "claude-code" ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: provider === "claude-code" ? "var(--accent)" : "var(--surface)",
                color: provider === "claude-code" ? "var(--text-on-accent)" : "var(--text)",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              Claude Code
            </button>
            <button
              type="button"
              onClick={() => openRouterConfigured !== false && onProviderChange("openrouter")}
              disabled={openRouterConfigured === false}
              title={
                openRouterConfigured === false ? "Configure your OpenRouter API key in Settings → API to enable this provider" : "Use OpenRouter for this chat"
              }
              style={{
                flex: 1,
                padding: inline ? "6px 10px" : "8px 12px",
                fontSize: inline ? 12 : 13,
                fontWeight: 500,
                borderRadius: 6,
                border: provider === "openrouter" ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: provider === "openrouter" ? "var(--accent)" : "var(--surface)",
                color: openRouterConfigured === false ? "var(--text-muted)" : provider === "openrouter" ? "var(--text-on-accent)" : "var(--text)",
                cursor: openRouterConfigured === false ? "not-allowed" : "pointer",
                opacity: openRouterConfigured === false ? 0.6 : 1,
                transition: "all 0.15s",
              }}
            >
              OpenRouter
            </button>
          </div>
          {openRouterConfigured === false && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              Configure your{" "}
              <a
                href="/settings/api"
                style={{ color: "var(--accent)", textDecoration: "underline" }}
                onClick={(e) => {
                  e.preventDefault();
                  onOpenApiSettings();
                }}
              >
                OpenRouter API key
              </a>{" "}
              to enable.
            </div>
          )}
          {!inline && provider === "openrouter" && openRouterConfigured !== false && openRouterMaxBudgetUsd !== null && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              Spend cap: ${openRouterMaxBudgetUsd.toFixed(2)} per session.{" "}
              <a
                href="/settings/api"
                style={{ color: "var(--accent)", textDecoration: "underline" }}
                onClick={(e) => {
                  e.preventDefault();
                  onOpenApiSettings();
                }}
              >
                Adjust in Settings → API
              </a>
              .
            </div>
          )}
        </div>
      )}

      {orControls}
      {claudeControls}
    </>
  );
}
