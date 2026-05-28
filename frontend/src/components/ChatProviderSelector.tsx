import type { AgentProviderKind, EffortLevel } from "../utils/localStorage";

interface ChatProviderSelectorProps {
  provider: AgentProviderKind;
  onProviderChange: (provider: AgentProviderKind) => void;
  effort: EffortLevel | undefined;
  onEffortChange: (effort: EffortLevel | undefined) => void;
  // `null` while /system-info is in flight — OR is treated as available until
  // we know otherwise (the disabled gate only kicks in on an explicit false).
  openRouterConfigured: boolean | null;
  // `null` while in flight or unreachable — the spend-cap line is suppressed.
  openRouterMaxBudgetUsd: number | null;
  // Opens Settings → API (caller decides how to close the panel first).
  onOpenApiSettings: () => void;
}

// Provider toggle (Claude Code vs. OpenRouter) plus the OpenRouter-only
// reasoning-effort knob. Shared between the folder and agent paths of
// NewChatPanel so the provider choice is visible and editable in both — the
// selection carries through to the chat regardless of which path is used.
export default function ChatProviderSelector({
  provider,
  onProviderChange,
  effort,
  onEffortChange,
  openRouterConfigured,
  openRouterMaxBudgetUsd,
  onOpenApiSettings,
}: ChatProviderSelectorProps) {
  return (
    <>
      {/* Provider toggle — Claude vs. OpenRouter. OR option is disabled
          until OPENROUTER_API_KEY is configured in Settings → API. */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)", marginBottom: 6 }}>Provider</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => onProviderChange("claude-code")}
            style={{
              flex: 1,
              padding: "8px 12px",
              fontSize: 13,
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
            onClick={() => openRouterConfigured !== false && onProviderChange("openrouter")}
            disabled={openRouterConfigured === false}
            title={openRouterConfigured === false ? "Configure your OpenRouter API key in Settings → API to enable this provider" : "Use OpenRouter for this chat"}
            style={{
              flex: 1,
              padding: "8px 12px",
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 6,
              border: provider === "openrouter" ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: provider === "openrouter" ? "var(--accent)" : "var(--surface)",
              color:
                openRouterConfigured === false
                  ? "var(--text-muted)"
                  : provider === "openrouter"
                    ? "var(--text-on-accent)"
                    : "var(--text)",
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
        {provider === "openrouter" && openRouterConfigured !== false && openRouterMaxBudgetUsd !== null && (
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

      {/* Reasoning effort — OpenRouter only. Hidden entirely for
          claude-code so the panel layout stays compact. OR maps the
          level to each provider's native parameter (Anthropic
          thinking.budget_tokens, OpenAI reasoning_effort, etc.);
          non-reasoning models silently ignore it. */}
      {provider === "openrouter" && openRouterConfigured !== false && (
        <div style={{ marginBottom: 12 }}>
          <label
            htmlFor="newChatEffort"
            style={{
              display: "block",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--text-muted)",
              marginBottom: 6,
            }}
          >
            Reasoning effort
          </label>
          <select
            id="newChatEffort"
            value={effort ?? ""}
            onChange={(e) => onEffortChange(e.target.value === "" ? undefined : (e.target.value as EffortLevel))}
            style={{
              width: "100%",
              padding: "8px 12px",
              fontSize: 13,
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            <option value="">(unset — model default)</option>
            <option value="none">none</option>
            <option value="minimal">minimal</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
          </select>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
            Maps to each provider&apos;s native thinking parameter. Non-reasoning models ignore this.
          </div>
        </div>
      )}
    </>
  );
}
