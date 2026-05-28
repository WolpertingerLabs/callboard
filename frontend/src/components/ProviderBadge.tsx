interface ProviderBadgeProps {
  // Chat provider from metadata. Anything other than "openrouter" (including
  // undefined/null, which is how Claude Code chats are stored — only OpenRouter
  // is persisted to metadata) renders as the "CC" default.
  provider?: string | null;
  // Smaller variant for dense list rows; the default sizing suits the chat header.
  compact?: boolean;
}

// Small tag marking which provider a chat runs on: "OR" for OpenRouter,
// "CC" (Claude Code) otherwise. Shared by the chat header, the chat list,
// and the folder list so the indicator is consistent everywhere.
export default function ProviderBadge({ provider, compact }: ProviderBadgeProps) {
  const isOpenRouter = provider === "openrouter";
  const label = isOpenRouter ? "OR" : "CC";
  const title = isOpenRouter ? "This chat is routed through OpenRouter" : "This chat runs on Claude Code";

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
        ...(isOpenRouter
          ? { background: "var(--badge-worktree)", color: "var(--text-on-accent)" }
          : { background: "var(--surface)", color: "var(--text-muted)", border: "1px solid var(--border)" }),
      }}
    >
      {label}
    </span>
  );
}
