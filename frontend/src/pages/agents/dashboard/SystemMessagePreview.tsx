import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Check, Info } from "lucide-react";
import type { SystemMessagePreview as SystemMessagePreviewData, SystemPromptSection } from "../../../api";

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return `~${tokens} tokens`;
  return `~${(tokens / 1000).toFixed(1)}k tokens`;
}

function TokenBadge({ tokens }: { tokens: number }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontFamily: "monospace",
        color: "var(--accent)",
        background: "color-mix(in srgb, var(--accent) 12%, transparent)",
        padding: "2px 8px",
        borderRadius: 6,
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      {formatTokenCount(tokens)}
    </span>
  );
}

function ContentBlock({ content }: { content: string }) {
  return (
    <div
      style={{
        background: "var(--bg-secondary)",
        borderTop: "1px solid var(--border)",
        padding: 16,
        fontSize: 13,
        lineHeight: 1.7,
        whiteSpace: "pre-wrap",
        fontFamily: "monospace",
        maxHeight: 480,
        overflowY: "auto",
        color: "var(--text)",
        wordBreak: "break-word",
      }}
    >
      {content}
    </div>
  );
}

function SectionRow({ section, isLast }: { section: SystemPromptSection; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={{ borderBottom: !isLast ? "1px solid var(--border)" : "none" }}>
      <button
        onClick={section.included ? () => setExpanded((e) => !e) : undefined}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "10px 14px",
          background: "transparent",
          textAlign: "left",
          cursor: section.included ? "pointer" : "default",
          opacity: section.included ? 1 : 0.55,
          transition: "background 0.1s",
        }}
        onMouseEnter={(e) => {
          if (section.included) e.currentTarget.style.background = "var(--bg-secondary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        {section.included ? (
          expanded ? (
            <ChevronDown size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          ) : (
            <ChevronRight size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
          )
        ) : (
          <span style={{ width: 14, flexShrink: 0 }} />
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{section.label}</div>
          <div style={{ fontSize: 11, fontFamily: "monospace", color: "var(--text-muted)" }}>{section.key}</div>
        </div>
        {section.included ? (
          <TokenBadge tokens={section.estTokens} />
        ) : (
          <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap", flexShrink: 0 }}>empty — not included</span>
        )}
      </button>
      {expanded && section.included && <ContentBlock content={section.content} />}
    </div>
  );
}

export default function SystemMessagePreview({ preview }: { preview: SystemMessagePreviewData | null }) {
  const [showFull, setShowFull] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!preview) {
    return <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--text-muted)", fontSize: 14 }}>Loading system message preview…</div>;
  }

  const includedCount = preview.sections.filter((s) => s.included).length;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(preview.fullPrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div>
      {/* Summary header */}
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ fontSize: 15, fontWeight: 600 }}>System Message</h3>
        <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Sent with every session this agent starts — manual chats, cron jobs, triggers, and events.</p>
      </div>

      {/* Stats */}
      <div
        style={{
          display: "flex",
          gap: 24,
          flexWrap: "wrap",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: "14px 16px",
          marginBottom: 12,
        }}
      >
        {[
          { label: "Estimated tokens", value: formatTokenCount(preview.totalEstTokens).replace("~", "") },
          { label: "Characters", value: preview.totalChars.toLocaleString() },
          { label: "Sections included", value: `${includedCount} of ${preview.sections.length}` },
        ].map((stat) => (
          <div key={stat.label}>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "monospace" }}>{stat.value}</div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Caveats */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 16 }}>
        <Info size={13} style={{ color: "var(--text-muted)", flexShrink: 0, marginTop: 2 }} />
        <p style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {preview.notes.basePrompt} {preview.notes.runtimeAdditions}
        </p>
      </div>

      {/* Section list */}
      <h3
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          marginBottom: 8,
        }}
      >
        Sections
      </h3>
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
          marginBottom: 16,
        }}
      >
        {preview.sections.map((section, i) => (
          <SectionRow key={section.key} section={section} isLast={i === preview.sections.length - 1} />
        ))}
      </div>

      {/* Full assembled prompt */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <button
            onClick={() => setShowFull((s) => !s)}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 14px",
              background: "transparent",
              textAlign: "left",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 500,
              transition: "background 0.1s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {showFull ? <ChevronDown size={14} style={{ color: "var(--text-muted)" }} /> : <ChevronRight size={14} style={{ color: "var(--text-muted)" }} />}
            View full assembled system message
          </button>
          <button
            onClick={handleCopy}
            title="Copy full system message"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              marginRight: 8,
              borderRadius: 6,
              fontSize: 12,
              color: "var(--text-muted)",
              background: "transparent",
              cursor: "pointer",
              transition: "background 0.1s",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        {showFull && <ContentBlock content={preview.fullPrompt || "Nothing is currently appended — the agent has no identity fields or workspace content."} />}
      </div>
    </div>
  );
}
