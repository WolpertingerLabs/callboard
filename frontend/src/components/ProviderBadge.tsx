interface ProviderBadgeProps {
  // Chat provider from metadata. "openrouter" → "OR", "codex" → "CX",
  // "cline" → "CL", "pi" → "PI", "acp" → the vendor's tag. Anything else (including undefined/null, which is
  // how Claude Code chats are stored — only the alternative providers are
  // persisted to metadata) renders as the "CC" default.
  provider?: string | null;
  // Which ACP vendor, for chats on the ACP kind — the `acpProviderId` in chat
  // metadata. Ignored for every other provider. Absent or unrecognized falls
  // back to the family tag; see ACP_VENDOR_TAGS.
  acpProviderId?: string | null;
  // Smaller variant for dense list rows; the default sizing suits the chat header.
  compact?: boolean;
}

// Short tags for the ACP vendors callboard ships a preset for.
//
// ACP originally got one badge for the whole family, on the reasoning that the
// chat list rows carried only the provider KIND. They carry the vendor too — it
// was always in the same metadata blob — and "ACP" names a wire format rather
// than the harness the user picked, which is the same reason the chat header's
// status line says "OpenCode is thinking" and not "ACP is thinking".
//
// A lookup rather than a derivation because no rule produces "OC" from
// "opencode": initials need word boundaries the id does not have, and the first
// two letters give "OP". Vendors are a shipped table (`vendors.ts`), so a second
// short table is the honest way to spell their tags. A vendor with no entry —
// including one wired in by hand through the preset override — falls back to
// "ACP", which is correct if unspecific.
const ACP_VENDOR_TAGS: Record<string, { tag: string; label: string }> = {
  opencode: { tag: "OC", label: "OpenCode" },
};

// Small tag marking which provider a chat runs on: "OR" for OpenRouter,
// "CX" for Codex, "CL" for Cline, "PI" for pi, the vendor's own tag for an ACP agent,
// "CC" (Claude Code) otherwise. Shared by the chat header, the chat list, and the folder list so
// the indicator is consistent everywhere.
export default function ProviderBadge({ provider, acpProviderId, compact }: ProviderBadgeProps) {
  const isOpenRouter = provider === "openrouter";
  const isCodex = provider === "codex";
  const isAcp = provider === "acp";
  const isCline = provider === "cline";
  const isPi = provider === "pi";
  const vendor = isAcp && acpProviderId ? ACP_VENDOR_TAGS[acpProviderId] : undefined;

  const label = isOpenRouter ? "OR" : isCodex ? "CX" : isCline ? "CL" : isPi ? "PI" : isAcp ? (vendor?.tag ?? "ACP") : "CC";
  const title = isOpenRouter
    ? "This chat is routed through OpenRouter"
    : isCodex
      ? "This chat runs on OpenAI Codex"
      : isCline
        ? "This chat runs on the Cline agent runtime"
        : isPi
          ? "This chat runs on the pi agent runtime"
          : isAcp
            ? `This chat runs on ${vendor?.label ?? "an ACP agent"}`
            : "This chat runs on Claude Code";

  const palette = isOpenRouter
    ? { background: "var(--badge-provider-openrouter-bg)", color: "var(--badge-provider-text)" }
    : isCodex
      ? { background: "var(--badge-provider-codex-bg)", color: "var(--badge-provider-text)" }
      : isCline
        ? { background: "var(--badge-provider-cline-bg)", color: "var(--badge-provider-text)" }
        : isPi
          ? { background: "var(--badge-provider-pi-bg)", color: "var(--badge-provider-text)" }
        : isAcp
          ? { background: "var(--badge-provider-acp-bg)", color: "var(--badge-provider-text)" }
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
