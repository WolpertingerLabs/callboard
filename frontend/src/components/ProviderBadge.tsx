interface ProviderBadgeProps {
  // Chat provider from metadata. "openrouter" → "OR", "codex" → "CX".
  // Anything else (including undefined/null, which is how Claude Code chats are
  // stored — only the alternative providers are persisted to metadata) renders
  // as the "CC" default.
  provider?: string | null;
  // Smaller variant for dense list rows; the default sizing suits the chat header.
  compact?: boolean;
}

// Small tag marking which provider a chat runs on: "OR" for OpenRouter,
// "CX" for Codex, "CC" (Claude Code) otherwise. Shared by the chat header,
// the chat list, and the folder list so the indicator is consistent everywhere.
export default function ProviderBadge({ provider, compact }: ProviderBadgeProps) {
  const isOpenRouter = provider === "openrouter";
  const isCodex = provider === "codex";
  const label = isOpenRouter ? "OR" : isCodex ? "CX" : "CC";
  const title = isOpenRouter
    ? "This chat is routed through OpenRouter"
    : isCodex
      ? "This chat runs on OpenAI Codex"
      : "This chat runs on Claude Code";

  const palette = isOpenRouter
    ? { background: "var(--badge-provider-openrouter-bg)", color: "var(--badge-provider-text)" }
    : isCodex
      ? { background: "var(--badge-provider-codex-bg)", color: "var(--badge-provider-text)" }
      : { background: "var(--surface)", color: "var(--text-muted)", border: "1px solid var(--border)" };

  return (
    <span
      title={title}
      style={{
        fontSize: compact ? 10 : 11,
        fontWeight: 600,
        letterSpacing: 0.3,
        padding: compact ? "1px 5px" : "2px 6px",
        borderRadius: 4,
        flexShrink: 0,
        ...palette,
      }}
    >
      {label}
    </span>
  );
}
