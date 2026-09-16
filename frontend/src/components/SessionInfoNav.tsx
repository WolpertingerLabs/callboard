import { useState } from "react";
import { Slash, Wrench, ChevronDown, ChevronRight } from "lucide-react";
import type { McpToolsResponse } from "../api";

type Section = "commands" | "tools";

interface Props {
  slashCommands: string[];
  mcpTools: McpToolsResponse | null;
  /** Drop text into the composer (already includes its trailing space). */
  onInsertPrompt: (value: string) => void;
  /** Open the full modal on the given tab. */
  onOpenModal: (tab: Section) => void;
  /**
   * False when the launchpad above is already showing the commands grid.
   *
   * With nothing starred, that fallback and this pill are two surfaces for one
   * list on one screen — the exact duplication this component exists to
   * remove. The parent decides which one wins, because only the parent can see
   * both.
   */
  showCommands?: boolean;
}

const PANEL_ID: Record<Section, string> = {
  commands: "session-info-commands-panel",
  tools: "session-info-tools-panel",
};

const pillStyle = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 8,
  border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
  background: active ? "var(--accent-bg)" : "var(--bg)",
  color: active ? "var(--accent-text)" : "var(--text-muted)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
});

const countStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 400,
  color: "var(--text-muted)",
};

const panelStyle: React.CSSProperties = {
  marginTop: 10,
  padding: "12px 14px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  maxHeight: 220,
  overflowY: "auto",
};

const viewAllStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--accent-text)",
  fontSize: 12,
  cursor: "pointer",
  padding: 0,
};

/**
 * The secondary, collapsed inventory of what the chat about to be started will
 * have available — slash commands and MCP tools.
 *
 * This exists because the new-chat screen had grown into three stacked cards of
 * roughly equal weight, two of which were reference material: a grid of every
 * slash command, and a grid of six of the forty-odd tool names. Neither is
 * something the user *acts on* to start work, and together they pushed the
 * thing they do act on below the fold.
 *
 * So they collapse to a count. Both sections are closed on mount and at most
 * one opens at a time — the whole point is that the screen shows one thing at a
 * time, and two expanded panels would restore exactly the stack this replaced.
 *
 * Deliberately NOT persisted. An expanded section is a "what's in here?" glance
 * answered in the moment, not a preference; restoring it on every new chat
 * would hand back the crowding to anyone who ever looked once.
 */
export default function SessionInfoNav({ slashCommands, mcpTools, onInsertPrompt, onOpenModal, showCommands = true }: Props) {
  const [open, setOpen] = useState<Section | null>(null);

  const toolCount = mcpTools?.tools.length ?? 0;
  const hasCommands = showCommands && slashCommands.length > 0;
  const hasTools = toolCount > 0;
  if (!hasCommands && !hasTools) return null;

  const toggle = (section: Section) => setOpen((prev) => (prev === section ? null : section));

  // A plain render helper, not a component: declaring one inside the body
  // remounts it on every render (and the lint rule that forbids it is right).
  const chevron = (section: Section) => (open === section ? <ChevronDown size={12} /> : <ChevronRight size={12} />);

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {hasCommands && (
          <button
            onClick={() => toggle("commands")}
            style={pillStyle(open === "commands")}
            aria-expanded={open === "commands"}
            aria-controls={open === "commands" ? PANEL_ID.commands : undefined}
          >
            {chevron("commands")}
            <Slash size={13} />
            Commands
            <span style={countStyle}>{slashCommands.length}</span>
          </button>
        )}
        {hasTools && (
          <button
            onClick={() => toggle("tools")}
            style={pillStyle(open === "tools")}
            aria-expanded={open === "tools"}
            aria-controls={open === "tools" ? PANEL_ID.tools : undefined}
          >
            {chevron("tools")}
            <Wrench size={13} />
            Tools
            <span style={countStyle}>{toolCount}</span>
          </button>
        )}
      </div>

      {hasCommands && open === "commands" && (
        <div id={PANEL_ID.commands} style={panelStyle}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {slashCommands.map((cmd) => (
              <button
                key={cmd}
                onClick={() => onInsertPrompt(`/${cmd} `)}
                style={{
                  background: "var(--bg-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: 6,
                  padding: "4px 10px",
                  fontSize: 12,
                  color: "var(--accent-text)",
                  cursor: "pointer",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {cmd}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <button onClick={() => onOpenModal("commands")} style={viewAllStyle}>
              Open commands browser
            </button>
          </div>
        </div>
      )}

      {open === "tools" && mcpTools && (
        <div id={PANEL_ID.tools} style={panelStyle}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {mcpTools.tools.map((tool) => (
              <div key={tool.qualifiedName} style={{ display: "flex", alignItems: "baseline", gap: 8, fontSize: 12 }}>
                <code style={{ fontFamily: "var(--font-mono)", color: "var(--text)", flexShrink: 0 }}>{tool.name}</code>
                <span
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 11,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tool.serverLabel}
                </span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10 }}>
            <button onClick={() => onOpenModal("tools")} style={viewAllStyle}>
              Open tool browser
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
