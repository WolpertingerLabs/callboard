import type { AgentProviderKind, EffortLevel } from "../utils/localStorage";
import OpenRouterModelSelector from "./OpenRouterModelSelector";
import ClaudeModelSelector from "./ClaudeModelSelector";
import CodexModelSelector from "./CodexModelSelector";
import AcpModelSelector from "./AcpModelSelector";
import ClineModelSelector from "./ClineModelSelector";
import PiModelSelector from "./PiModelSelector";

export type ProviderConfigPickerMode = "panel" | "inline";

interface ProviderConfigPickerProps {
  provider: AgentProviderKind;
  onProviderChange: (provider: AgentProviderKind) => void;
  effort: EffortLevel | undefined;
  onEffortChange: (effort: EffortLevel | undefined) => void;
  // Anthropic model for Claude Code chats (alias like "opus" or full ID like
  // "claude-sonnet-4-6"). Empty string = "use global default from Settings →
  // API". Kept separate from each other provider's model so toggling providers
  // restores each one's prior selection. Free-form text; the CLI validates
  // server-side.
  claudeModel: string;
  onClaudeModelChange: (model: string) => void;
  // Codex model (e.g. "gpt-5.5"). Empty string = "use global default from
  // Settings → API". Kept separate from `claudeModel` so toggling providers
  // restores each one's prior selection. Optional — callers that
  // don't surface a Codex per-chat model omit it (the selector then hides).
  codexModel?: string;
  onCodexModelChange?: (model: string) => void;
  // `null`/undefined while /system-info is in flight (or when the caller
  // doesn't gate Codex) — Codex is treated as available until an explicit
  // false disables the button.
  codexConfigured?: boolean | null;
  // ACP vendors, from /api/system-info. One button each rather than an "ACP"
  // button plus a sub-picker: `acp` is a wire format, not a harness, and a user
  // picks OpenCode the same way they pick Codex. The kind travels as "acp" with
  // the id alongside it — see acpProviderId below. Omitted/empty renders nothing,
  // so callers that don't offer ACP are unaffected.
  acpProviders?: Array<{ id: string; label: string; available: boolean; command: string }>;
  // Which ACP vendor is selected. Only meaningful when provider === "acp".
  acpProviderId?: string;
  // Selecting an ACP vendor sets BOTH the kind and the id, so callers wire this
  // together with onProviderChange rather than as an independent control.
  onAcpProviderChange?: (providerId: string) => void;
  // Per-chat ACP model, as the vendor names it. Empty = this vendor's default
  // from Settings → API (`AgentSettings.acpProviderModels`, keyed by vendor id),
  // and when that is blank too, the vendor CLI's own configured model. Kept
  // separate from the other providers' model values so switching the toggle
  // restores each one's prior selection, the same way `model` / `claudeModel` /
  // `codexModel` already do. Optional — callers that don't surface a per-chat
  // ACP model omit it and the field hides.
  acpModel?: string;
  onAcpModelChange?: (model: string) => void;
  // Per-chat Cline model, within the provider configured in Settings → API.
  // Empty = that global default. Kept separate from the other providers' model
  // values for the same reason `acpModel` is: switching the toggle restores each
  // one's prior selection. Optional — callers that don't surface it omit it and
  // the field hides.
  clineModel?: string;
  onClineModelChange?: (model: string) => void;
  /**
   * Which Cline provider the catalog is scoped to, from `/api/system-info`.
   * Empty falls back to `anthropic`, the adapter's own default. This is what
   * makes the picker offer OpenRouter models when the user has selected that
   * provider — Cline ships `openrouter` as a provider id, so no special case is
   * needed.
   */
  clineProviderId?: string;
  // Per-chat pi model, within the provider configured in Settings → API. Same
  // contract as `clineModel`; kept separate so switching the toggle restores
  // each provider's prior selection.
  piModel?: string;
  onPiModelChange?: (model: string) => void;
  // Opens Settings → API (caller decides how to close any wrapping panel first).
  onOpenApiSettings: () => void;
  // Layout mode. `panel` (default) renders the original stacked vertical
  // layout used in NewChatPanel and the cron form. `inline` renders a
  // compact horizontal row suitable for the chat composer's expandable
  // toggle panel — smaller labels, narrower controls, no help text.
  mode?: ProviderConfigPickerMode;
  // When false, the provider toggle is hidden entirely.
  // Use for the chat composer, where the provider is already pinned for the
  // lifetime of the chat and only model/effort are mutable. Defaults true.
  showProviderToggle?: boolean;
  // True when the native Claude Code harness is routed through OpenRouter — the
  // Claude model picker then lists OpenRouter slugs (anthropic/* first).
  claudeCodeUseOpenRouter?: boolean;
  // True when the native Codex harness is routed through OpenRouter — the Codex
  // model picker then lists OpenRouter slugs (openai/* first).
  codexUseOpenRouter?: boolean;
}

/**
 * Provider/model/effort picker. Used in three places:
 *  - NewChatPanel — full panel layout, all controls visible.
 *  - CronJobs form — same panel layout, all controls visible.
 *  - Chat.tsx composer — inline horizontal layout, provider toggle hidden
 *    (each chat is pinned to one provider at creation time).
 *
 * Reasoning effort renders for the reasoning-capable providers — Codex, Cline
 * and pi — and maps to each one's native knob (Codex `modelReasoningEffort`,
 * Cline `thinking`/`reasoningEffort`, pi `thinkingLevel`). Each provider also
 * shows its own model control; Claude Code has no effort. Each provider's model
 * value lives in a separate prop — switching the toggle swaps the controls while
 * preserving every value, so toggling back restores the prior selection.
 */
export default function ProviderConfigPicker({
  provider,
  onProviderChange,
  effort,
  onEffortChange,
  claudeModel,
  onClaudeModelChange,
  codexModel,
  onCodexModelChange,
  codexConfigured,
  acpProviders,
  acpProviderId,
  onAcpProviderChange,
  acpModel,
  onAcpModelChange,
  clineModel,
  piModel,
  onPiModelChange,
  onClineModelChange,
  clineProviderId,
  onOpenApiSettings,
  mode = "panel",
  showProviderToggle = true,
  claudeCodeUseOpenRouter = false,
  codexUseOpenRouter = false,
}: ProviderConfigPickerProps) {
  const inline = mode === "inline";
  const showClaudeKnobs = provider === "claude-code";
  // Codex per-chat model only renders when the caller wired a change handler.
  const showCodexKnobs = provider === "codex" && onCodexModelChange !== undefined;
  // Reasoning effort is shared by every reasoning-capable provider (Codex →
  // `modelReasoningEffort`, Cline → `thinking`/`reasoningEffort`, pi →
  // `thinkingLevel`).
  const showEffort = provider === "codex" || provider === "cline" || provider === "pi";

  // The reasoning-effort selector, shared by each provider's control row. Only
  // one provider's row renders at a time, so the element id never collides.
  const effortControl = showEffort ? (
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
          {provider === "codex"
            ? "How hard the Codex model reasons. “none” hides reasoning summaries."
            : "Maps to each provider’s native thinking parameter. Non-reasoning models ignore this."}
        </div>
      )}
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
      {claudeCodeUseOpenRouter ? (
        <OpenRouterModelSelector
          id={inline ? "inlineClaudeModel" : "newChatClaudeModel"}
          value={claudeModel}
          onChange={onClaudeModelChange}
          priorityPrefix="anthropic/"
          placeholder={inline ? "(default)" : "(default — uses Settings → API)"}
        />
      ) : (
        <ClaudeModelSelector
          id={inline ? "inlineClaudeModel" : "newChatClaudeModel"}
          value={claudeModel}
          onChange={onClaudeModelChange}
          placeholder={inline ? "(default)" : "(default — uses Settings → API)"}
        />
      )}
      {!inline && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
          {claudeCodeUseOpenRouter
            ? "Optional — an OpenRouter slug (anthropic/* recommended). Leave empty to use the global default from Settings → API."
            : "Optional — alias (opus, sonnet, haiku, opusplan) or full model ID. Leave empty to use the global default from Settings → API."}
        </div>
      )}
    </div>
  ) : null;

  // Codex controls — reasoning effort (always) + per-chat model (when the caller
  // wired a change handler). Empty model falls back to the global default in
  // Settings → API; sandbox mode is a global Codex setting, not a per-chat knob.
  const codexControls =
    provider === "codex" ? (
      <div style={inline ? { display: "flex", gap: 8, alignItems: "flex-start" } : { display: "block" }}>
        {effortControl}
        {showCodexKnobs && (
          <div style={{ marginBottom: inline ? 0 : 12, flex: inline ? "1 1 auto" : undefined, minWidth: inline ? 180 : 0 }}>
            <label
              htmlFor={inline ? "inlineCodexModel" : "newChatCodexModel"}
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
            {codexUseOpenRouter ? (
              <OpenRouterModelSelector
                id={inline ? "inlineCodexModel" : "newChatCodexModel"}
                value={codexModel ?? ""}
                onChange={onCodexModelChange ?? (() => {})}
                priorityPrefix="openai/"
                placeholder={inline ? "(default)" : "(default — uses Settings → API)"}
              />
            ) : (
              <CodexModelSelector
                id={inline ? "inlineCodexModel" : "newChatCodexModel"}
                value={codexModel ?? ""}
                onChange={onCodexModelChange ?? (() => {})}
                placeholder={inline ? "(default)" : "(default — uses Settings → API)"}
              />
            )}
            {!inline && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                {codexUseOpenRouter
                  ? "Optional — an OpenRouter slug (openai/* recommended). Leave empty to use the global default from Settings → API."
                  : "Optional — a Codex model slug. Leave empty to use the global default from Settings → API."}
              </div>
            )}
          </div>
        )}
      </div>
    ) : null;

  // ACP model — only when the caller wired a change handler, like Codex's. There
  // is no effort control: ACP has no reasoning-effort concept to map onto.
  const acpControls =
    provider === "acp" && onAcpModelChange !== undefined ? (
      <div style={{ marginBottom: inline ? 0 : 12, flex: inline ? "1 1 auto" : undefined, minWidth: inline ? 180 : 0 }}>
        <label
          htmlFor={inline ? "inlineAcpModel" : "newChatAcpModel"}
          style={{ display: "block", fontSize: inline ? 11 : 13, fontWeight: 600, color: "var(--text-muted)", marginBottom: inline ? 4 : 6 }}
        >
          Model
        </label>
        <AcpModelSelector
          id={inline ? "inlineAcpModel" : "newChatAcpModel"}
          value={acpModel ?? ""}
          onChange={onAcpModelChange}
          providerId={acpProviderId ?? ""}
          placeholder={inline ? "(default)" : "(default — uses Settings → API)"}
        />
        {!inline && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
            Optional — leave empty to use this vendor&rsquo;s default model from Settings → API, and the vendor&rsquo;s own configured model when that is blank
            too. Suggestions come from models this agent has advertised before. Any model it does not have is refused outright rather than swapped for a
            default.
          </div>
        )}
      </div>
    ) : null;

  // Cline — effort plus a per-chat model. Unlike the ACP selector there is no
  // vendor to scope the catalog to: the Cline provider is a global setting, so
  // the suggestions come from whichever one Settings → API names.
  const clineControls =
    provider === "cline" ? (
      <div style={inline ? { display: "flex", gap: 8, alignItems: "flex-start" } : { display: "block" }}>
        {effortControl}
        {onClineModelChange !== undefined && (
          <div style={{ marginBottom: inline ? 0 : 12, flex: inline ? "1 1 auto" : undefined, minWidth: inline ? 180 : 0 }}>
            <label
              htmlFor={inline ? "inlineClineModel" : "newChatClineModel"}
              style={{ display: "block", fontSize: inline ? 11 : 13, fontWeight: 600, color: "var(--text-muted)", marginBottom: inline ? 4 : 6 }}
            >
              Model
            </label>
            <ClineModelSelector
              id={inline ? "inlineClineModel" : "newChatClineModel"}
              value={clineModel ?? ""}
              onChange={onClineModelChange}
              providerId={clineProviderId ?? ""}
              placeholder={inline ? "(default)" : "(leave empty to use the default from Settings → API)"}
            />
            {!inline && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                Suggestions come from your configured Cline provider
                {clineProviderId ? ` (${clineProviderId})` : ""}. Free text is accepted — the provider validates the model.
              </div>
            )}
          </div>
        )}
      </div>
    ) : null;

  // pi — effort plus a per-chat model. Unlike the Cline field this is a
  // filtering combobox: pi's OpenRouter catalog answers with ~300 models, and a
  // plain input with a datalist that long is a scroll rather than a picker.
  const piControls =
    provider === "pi" ? (
      <div style={inline ? { display: "flex", gap: 8, alignItems: "flex-start" } : { display: "block" }}>
        {effortControl}
        {onPiModelChange !== undefined && (
          <div style={{ marginBottom: inline ? 0 : 12, flex: inline ? "1 1 auto" : undefined, minWidth: inline ? 180 : 0 }}>
            <label
              htmlFor={inline ? "inlinePiModel" : "newChatPiModel"}
              style={{ display: "block", fontSize: inline ? 11 : 13, fontWeight: 600, color: "var(--text-muted)", marginBottom: inline ? 4 : 6 }}
            >
              Model
            </label>
            <PiModelSelector
              id={inline ? "inlinePiModel" : "newChatPiModel"}
              value={piModel ?? ""}
              onChange={onPiModelChange}
              placeholder={inline ? "(default)" : "(leave empty to use the default from Settings → API)"}
              compact={inline}
            />
            {!inline && (
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                Optional — a model id within your configured pi provider. Type to filter; free text is accepted for slugs newer than the catalog.
              </div>
            )}
          </div>
        )}
      </div>
    ) : null;

  return (
    <>
      {showProviderToggle && (
        <div style={{ marginBottom: inline ? 8 : 12 }}>
          <div style={{ fontSize: inline ? 11 : 13, fontWeight: 600, color: "var(--text-muted)", marginBottom: inline ? 4 : 6 }}>Provider</div>
          {/* Wraps: the row held three buttons when it was written, and each ACP
              vendor adds another. `flex: 1` alone cannot shrink a button below
              its label (min-width defaults to auto), so a fifth entry pushed
              the last one outside the sidebar rather than onto a second line. */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => onProviderChange("claude-code")}
              title="Use Claude for this chat"
              style={{
                flex: "1 1 64px",
                padding: inline ? "4px 6px" : "6px 8px",
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
              Claude
            </button>
            <button
              type="button"
              onClick={() => codexConfigured !== false && onProviderChange("codex")}
              disabled={codexConfigured === false}
              title={codexConfigured === false ? "Configure Codex in Settings → API to enable this provider" : "Use OpenAI Codex for this chat"}
              style={{
                flex: "1 1 64px",
                padding: inline ? "4px 6px" : "6px 8px",
                fontSize: inline ? 12 : 13,
                fontWeight: 500,
                borderRadius: 6,
                border: provider === "codex" ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: provider === "codex" ? "var(--accent)" : "var(--surface)",
                color: codexConfigured === false ? "var(--text-muted)" : provider === "codex" ? "var(--text-on-accent)" : "var(--text)",
                cursor: codexConfigured === false ? "not-allowed" : "pointer",
                opacity: codexConfigured === false ? 0.6 : 1,
                transition: "all 0.15s",
              }}
            >
              Codex
            </button>
            <button
              type="button"
              onClick={() => onProviderChange("cline")}
              // No `configured` gate, unlike Codex above. Cline is an
              // embedded SDK rather than a binary to install or an account to
              // sign into: it falls back to the backend's own environment
              // credentials, so there is no state in which the button would be
              // honestly disabled. A genuinely missing key surfaces as the
              // provider's own error on the first turn, which says more than a
              // greyed-out button could.
              title="Use the Cline agent runtime for this chat"
              style={{
                flex: "1 1 64px",
                padding: inline ? "4px 6px" : "6px 8px",
                fontSize: inline ? 12 : 13,
                fontWeight: 500,
                borderRadius: 6,
                border: provider === "cline" ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: provider === "cline" ? "var(--accent)" : "var(--surface)",
                color: provider === "cline" ? "var(--text-on-accent)" : "var(--text)",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              Cline
            </button>
            <button
              type="button"
              onClick={() => onProviderChange("pi")}
              // No `configured` gate, for the same reason as Cline: pi is an
              // embedded runtime, and it falls back to the backend's own
              // environment credentials. A genuinely missing key surfaces as the
              // provider's own error on the first turn.
              title="Use the pi agent runtime for this chat"
              style={{
                flex: "1 1 64px",
                padding: inline ? "4px 6px" : "6px 8px",
                fontSize: inline ? 12 : 13,
                fontWeight: 500,
                borderRadius: 6,
                border: provider === "pi" ? "1px solid var(--accent)" : "1px solid var(--border)",
                background: provider === "pi" ? "var(--accent)" : "var(--surface)",
                color: provider === "pi" ? "var(--text-on-accent)" : "var(--text)",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              pi
            </button>
            {(acpProviders ?? []).map((vendor) => {
              // Selected only when BOTH the kind and the id match — two ACP
              // vendors must never light up together.
              const selected = provider === "acp" && acpProviderId === vendor.id;
              return (
                <button
                  key={vendor.id}
                  type="button"
                  onClick={() => {
                    if (!vendor.available) return;
                    onAcpProviderChange?.(vendor.id);
                    onProviderChange("acp");
                  }}
                  disabled={!vendor.available}
                  title={vendor.available ? `Use ${vendor.label} for this chat` : `Install the \`${vendor.command}\` CLI to enable this provider`}
                  style={{
                    flex: "1 1 64px",
                    padding: inline ? "4px 6px" : "6px 8px",
                    fontSize: inline ? 12 : 13,
                    fontWeight: 500,
                    borderRadius: 6,
                    border: selected ? "1px solid var(--accent)" : "1px solid var(--border)",
                    background: selected ? "var(--accent)" : "var(--surface)",
                    color: !vendor.available ? "var(--text-muted)" : selected ? "var(--text-on-accent)" : "var(--text)",
                    cursor: vendor.available ? "pointer" : "not-allowed",
                    opacity: vendor.available ? 1 : 0.6,
                    transition: "all 0.15s",
                  }}
                >
                  {vendor.label}
                </button>
              );
            })}
          </div>
          {provider === "acp" && !inline && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              Credentials for this harness live in its own CLI. Callboard gates every tool call it makes.
            </div>
          )}
          {codexConfigured === false && provider === "codex" && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              Configure{" "}
              <a
                href="/settings/api"
                style={{ color: "var(--accent-text)", textDecoration: "underline" }}
                onClick={(e) => {
                  e.preventDefault();
                  onOpenApiSettings();
                }}
              >
                Codex
              </a>{" "}
              to enable.
            </div>
          )}
        </div>
      )}

      {claudeControls}
      {codexControls}
      {acpControls}
      {clineControls}
      {piControls}
    </>
  );
}
