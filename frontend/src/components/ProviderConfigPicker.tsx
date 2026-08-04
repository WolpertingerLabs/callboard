import type { AgentProviderKind, EffortLevel } from "../utils/localStorage";
import OpenRouterModelSelector from "./OpenRouterModelSelector";
import ClaudeModelSelector from "./ClaudeModelSelector";
import CodexModelSelector from "./CodexModelSelector";
import AcpModelSelector from "./AcpModelSelector";

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
  // Codex model (e.g. "gpt-5.5"). Empty string = "use global default from
  // Settings → API". Kept separate from `model`/`claudeModel` so toggling
  // providers restores each one's prior selection. Optional — callers that
  // don't surface a Codex per-chat model omit it (the selector then hides).
  codexModel?: string;
  onCodexModelChange?: (model: string) => void;
  // `null`/undefined while /system-info is in flight (or when the caller
  // doesn't gate Codex) — Codex is treated as available until an explicit
  // false disables the button (mirrors `openRouterConfigured`).
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
  // Per-chat ACP model, as the vendor names it. Empty = leave the vendor CLI's
  // own configured model alone. Kept separate from the other providers' model
  // values so switching the toggle restores each one's prior selection, the same
  // way `model` / `claudeModel` / `codexModel` already do. Optional — callers
  // that don't surface a per-chat ACP model omit it and the field hides.
  acpModel?: string;
  onAcpModelChange?: (model: string) => void;
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
  // True when the native Claude Code harness is routed through OpenRouter — the
  // Claude model picker then lists OpenRouter slugs (anthropic/* first).
  claudeCodeUseOpenRouter?: boolean;
  // True when the native Codex harness is routed through OpenRouter — the Codex
  // model picker then lists OpenRouter slugs (openai/* first).
  codexUseOpenRouter?: boolean;
  // When provided (OpenRouter only), renders in place of the per-chat model
  // field — used to swap in the Manual/Router model switcher. Sits beside the
  // reasoning-effort selector so both share the OpenRouter control row.
  openRouterModelSlot?: React.ReactNode;
}

/**
 * Provider/model/effort picker. Used in three places:
 *  - NewChatPanel — full panel layout, all controls visible.
 *  - CronJobs form — same panel layout, all controls visible.
 *  - Chat.tsx composer — inline horizontal layout, provider toggle hidden
 *    (each chat is pinned to one provider at creation time).
 *
 * Reasoning effort renders for the two reasoning-capable providers —
 * OpenRouter (when configured) and Codex — and maps to each one's native
 * knob (OR `reasoning.effort`, Codex `modelReasoningEffort`). Each provider
 * also shows its own model control (OR slug, Anthropic alias/ID, or Codex
 * model); Claude Code has no effort. Each provider's model value lives in a
 * separate prop — switching the toggle swaps the controls while preserving
 * both values, so toggling back restores the prior selection.
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
  codexModel,
  onCodexModelChange,
  codexConfigured,
  acpProviders,
  acpProviderId,
  onAcpProviderChange,
  acpModel,
  onAcpModelChange,
  openRouterConfigured,
  openRouterMaxBudgetUsd,
  onOpenApiSettings,
  mode = "panel",
  showProviderToggle = true,
  claudeCodeUseOpenRouter = false,
  codexUseOpenRouter = false,
  openRouterModelSlot,
}: ProviderConfigPickerProps) {
  const inline = mode === "inline";
  const showOrKnobs = provider === "openrouter" && openRouterConfigured !== false;
  const showClaudeKnobs = provider === "claude-code";
  // Codex per-chat model only renders when the caller wired a change handler.
  const showCodexKnobs = provider === "codex" && onCodexModelChange !== undefined;
  // Reasoning effort is shared by the two reasoning-capable providers
  // (OpenRouter → OR `reasoning.effort`, Codex → `modelReasoningEffort`).
  const showEffort = showOrKnobs || provider === "codex";

  // The reasoning-effort selector, shared by the OR and Codex control rows. Only
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

  // `inline` mode lays the controls side-by-side; `panel` mode stacks them.
  const orControls = showOrKnobs ? (
    <div style={inline ? { display: "flex", gap: 8, alignItems: "flex-start" } : { display: "block" }}>
      {effortControl}

      {/* Per-chat model override — OpenRouter only. When the caller supplies a
          slot (the Manual/Router switcher) it replaces the plain model field;
          otherwise the field falls back to the global default from Settings → API. */}
      <div style={{ marginBottom: inline ? 0 : 12, flex: inline ? "1 1 auto" : undefined, minWidth: inline ? 180 : 0 }}>
        {openRouterModelSlot ?? (
          <>
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
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                Optional — leave empty to use the global default from Settings → API.
              </div>
            )}
          </>
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
          placeholder={inline ? "(vendor default)" : "(leave empty to use the vendor's own configured model)"}
        />
        {!inline && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
            Suggestions come from models this agent has advertised before. Any model it does not have is refused outright rather than swapped for a default.
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
              style={{
                flex: "1 1 84px",
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
                flex: "1 1 84px",
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
            <button
              type="button"
              onClick={() => codexConfigured !== false && onProviderChange("codex")}
              disabled={codexConfigured === false}
              title={codexConfigured === false ? "Configure Codex in Settings → API to enable this provider" : "Use OpenAI Codex for this chat"}
              style={{
                flex: "1 1 84px",
                padding: inline ? "6px 10px" : "8px 12px",
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
                    flex: "1 1 84px",
                    padding: inline ? "6px 10px" : "8px 12px",
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
          {openRouterConfigured === false && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              Configure your{" "}
              <a
                href="/settings/api"
                style={{ color: "var(--accent-text)", textDecoration: "underline" }}
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
                style={{ color: "var(--accent-text)", textDecoration: "underline" }}
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
      {codexControls}
      {acpControls}
    </>
  );
}
