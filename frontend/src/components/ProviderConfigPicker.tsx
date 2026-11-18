import { useEffect, useState } from "react";
import { getReasoningCapability } from "../api";
import type { AgentProviderKind, EffortLevel } from "../utils/localStorage";
import OpenRouterModelSelector from "./OpenRouterModelSelector";
import ClaudeModelSelector from "./ClaudeModelSelector";
import CodexModelSelector from "./CodexModelSelector";
import PiModelSelector from "./PiModelSelector";

export type ProviderConfigPickerMode = "panel" | "inline";

interface ProviderConfigPickerProps {
  provider: AgentProviderKind;
  /** Actual execution directory, used for project-scoped runtime settings. */
  cwd?: string;
  onProviderChange: (provider: AgentProviderKind) => void;
  effort: EffortLevel | undefined;
  onEffortChange: (effort: EffortLevel | undefined) => void;
  /**
   * Reports whether the current effort is unsupported (or still unverified) for
   * the selected provider/model/route. The select flags this via
   * `setCustomValidity`, but nothing submits a form here, so a caller that
   * creates a chat on click must be told explicitly to hold off — otherwise a
   * stale stored effort creates a chat that fails on its first message.
   */
  onEffortValidityChange?: (unsupported: boolean) => void;
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
  // Per-chat pi model, within the provider configured in Settings → API.
  // Empty = that global default. Kept separate from the other providers' model
  // values so switching the toggle restores each
  // provider's prior selection. Optional — callers that don't surface it omit it
  // and the field hides.
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
 * Reasoning effort renders for the reasoning-capable providers — Codex and pi
 * — and maps to each one's native knob (Codex `modelReasoningEffort`, pi
 * `thinkingLevel`). Each provider also
 * shows its own model control; Claude Code has no effort. Each provider's model
 * value lives in a separate prop — switching the toggle swaps the controls while
 * preserving every value, so toggling back restores the prior selection.
 */
export default function ProviderConfigPicker({
  provider,
  cwd,
  onProviderChange,
  effort,
  onEffortChange,
  onEffortValidityChange,
  claudeModel,
  onClaudeModelChange,
  codexModel,
  onCodexModelChange,
  codexConfigured,
  piModel,
  onPiModelChange,
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
  // `modelReasoningEffort`, pi → `thinkingLevel`).
  const showEffort = provider === "codex" || provider === "pi";

  const selectedModel = provider === "codex" ? codexModel : provider === "pi" ? piModel : claudeModel;
  // Key the result as well as cancelling the request: a changed selection must
  // never render the previous model's tiers, even for the frame before effects.
  const capabilityKey = JSON.stringify([provider, selectedModel ?? "", cwd, codexUseOpenRouter, claudeCodeUseOpenRouter]);
  const [result, setResult] = useState<{ key: string; capability: Awaited<ReturnType<typeof getReasoningCapability>> }>();
  useEffect(() => {
    if (!showEffort) return;
    let cancelled = false;
    getReasoningCapability(provider, selectedModel ?? "", cwd)
      .then((capability) => {
        if (!cancelled) setResult({ key: capabilityKey, capability });
      })
      .catch(() => {
        if (!cancelled)
          setResult({
            key: capabilityKey,
            capability: {
              provider,
              route: "unknown",
              status: "unknown",
              efforts: [],
              message: "Reasoning capabilities unavailable. Clear the override to use the runtime default.",
            },
          });
      });
    return () => {
      cancelled = true;
    };
  }, [capabilityKey, provider, selectedModel, showEffort, cwd]);
  const capability = result?.key === capabilityKey ? result.capability : undefined;
  const efforts = capability?.efforts ?? [];
  const legacyNone = effort === "none" && capability?.legacySummaryNone === true;
  const unsupported = effort !== undefined && !efforts.includes(effort) && !legacyNone;
  // Block callers only on a known answer. While the capability is still loading
  // (every keystroke in a folder field re-keys the fetch, and the Codex probe
  // takes up to ~1s) `unsupported` is merely "unverified"; the server validates
  // fail-closed on creation anyway, so holding the button here only gets in
  // the way of a supported effort.
  const effortBlocked = showEffort && capability !== undefined && unsupported;
  useEffect(() => {
    onEffortValidityChange?.(effortBlocked);
  }, [effortBlocked, onEffortValidityChange]);
  const routedCodexViaOpenRouter = capability ? capability.route === "openrouter" : codexUseOpenRouter;

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
        ref={(node) => {
          node?.setCustomValidity(unsupported ? "Choose a supported reasoning effort or clear this override." : "");
        }}
        aria-invalid={unsupported || undefined}
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
        {legacyNone && <option value="none">none (legacy: hide summaries; default effort)</option>}
        {unsupported && (
          <option value={effort} disabled>
            {effort} ({capability ? "unsupported / unverified" : "checking…"})
          </option>
        )}
        {efforts.map((level) => (
          <option key={level} value={level}>
            {level}
          </option>
        ))}
      </select>
      <div role={unsupported && capability ? "alert" : "status"} style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
        {!capability
          ? "Loading reasoning capabilities…"
          : unsupported
            ? `Saved effort “${effort}” is not supported or verified for this model and route. Choose a supported level or clear it.`
            : (capability.message ??
              (efforts.length === 0
                ? "No effort selection available; runtime default applies."
                : !inline
                  ? "Efforts supported by the selected model and route."
                  : ""))}
        {effort !== undefined && (
          <button type="button" onClick={() => onEffortChange(undefined)}>
            Clear effort
          </button>
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
            {routedCodexViaOpenRouter ? (
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
                {routedCodexViaOpenRouter
                  ? "Optional — an OpenRouter slug (openai/* recommended). Leave empty to use the global default from Settings → API."
                  : "Optional — a Codex model slug. Leave empty to use the global default from Settings → API."}
              </div>
            )}
          </div>
        )}
      </div>
    ) : null;

  // pi — effort plus a per-chat model. This is a
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
          {/* Wraps: `flex: 1` alone cannot shrink a button below its label
              (min-width defaults to auto), so when the retired ACP harness added
              a button per vendor, a fifth entry pushed the last one outside the
              sidebar rather than onto a second line. */}
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
              onClick={() => onProviderChange("pi")}
              // No `configured` gate, unlike Codex above. pi is an embedded
              // runtime rather than a binary to install or an account to sign
              // into: it falls back to the backend's own environment
              // credentials, so there is no state in which the button would be
              // honestly disabled. A genuinely missing key surfaces as the
              // provider's own error on the first turn, which says more than a
              // greyed-out button could.
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
          </div>
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
      {piControls}
    </>
  );
}
