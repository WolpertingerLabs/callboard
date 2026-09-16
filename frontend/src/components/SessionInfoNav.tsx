import { useState } from "react";
import { Slash, Wrench, ChevronDown, ChevronRight } from "lucide-react";
import type { McpToolsResponse } from "../api";

type Section = "commands" | "tools";

interface Props {
  slashCommands: string[];
  mcpTools: McpToolsResponse | null;
  /**
   * Put a command in the composer (the string already includes its trailing
   * space). The parent *prefixes* rather than overwrites — anything already
   * typed becomes the command's argument. See `Chat.tsx`'s
   * `insertCommandPrompt`.
   */
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

/**
 * How many rows a panel renders before it defers to the browser modal.
 *
 * The panel is a peek, not a viewer — the modal is the viewer, and the link to
 * it is the panel's only escape hatch. With 82 MCP tools and no cap, that link
 * sat 1442px below a 220px window on an overlay scrollbar barely visible as a
 * hairline: in practice unreachable, and nothing on screen said the list even
 * continued. So the list is cut to a number, the footer that names the full
 * count and carries the link sits OUTSIDE the scrolling region, and both are
 * always on screen.
 *
 * One constant for both sections. Commands happens to fit today (4 of them),
 * which is a fact about one install and not a reason for the two panels to
 * behave differently on the next one.
 */
const PANEL_LIMIT = 12;

/**
 * Minimum touch target, in px. The new-chat screen is a phone screen as often
 * as not — remote access is the point of the tunnel — and these pills measured
 * 28px tall before this floor, against the 44px both platform guidelines ask
 * for. Applied as `minHeight` plus a padding bump rather than a font change:
 * the pills are meant to read as secondary, and growing the type would undo
 * the whole reason this component collapses its contents to a count.
 */
export const MIN_TAP_TARGET = 44;

const pillStyle = (active: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 12px",
  minHeight: MIN_TAP_TARGET,
  boxSizing: "border-box",
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
};

/**
 * The scrolling half of a panel. The footer below it is deliberately NOT in
 * here — see {@link PANEL_LIMIT}.
 */
const scrollStyle: React.CSSProperties = {
  maxHeight: 220,
  overflowY: "auto",
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  flexWrap: "wrap",
  marginTop: 10,
};

const truncationStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
};

const viewAllStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--accent-text)",
  fontSize: 12,
  cursor: "pointer",
  padding: "8px 0",
  minHeight: MIN_TAP_TARGET,
  boxSizing: "border-box",
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
 *
 * An expanded panel is capped and its footer sits outside the scroll — see
 * {@link PANEL_LIMIT}.
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

  /**
   * The always-visible bottom of a panel: what got cut, and the way out. Named
   * counts ("Showing 12 of 82") rather than a "+70 more" chip, because the
   * question the truncation raises is how much is missing, not that some is.
   */
  const panelFooter = (total: number, section: Section, label: string) => (
    <div style={footerStyle}>
      <span style={truncationStyle}>{total > PANEL_LIMIT ? `Showing ${PANEL_LIMIT} of ${total}` : `${total} total`}</span>
      <button onClick={() => onOpenModal(section)} style={viewAllStyle}>
        {label}
      </button>
    </div>
  );

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
          <div style={scrollStyle}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {slashCommands.slice(0, PANEL_LIMIT).map((cmd) => (
                <button
                  key={cmd}
                  onClick={() => onInsertPrompt(`/${cmd} `)}
                  style={{
                    background: "var(--bg-secondary)",
                    border: "1px solid var(--border)",
                    borderRadius: 6,
                    padding: "8px 10px",
                    minHeight: MIN_TAP_TARGET,
                    boxSizing: "border-box",
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
          </div>
          {panelFooter(slashCommands.length, "commands", "Open commands browser")}
        </div>
      )}

      {open === "tools" && mcpTools && (
        <div id={PANEL_ID.tools} style={panelStyle}>
          <div style={scrollStyle}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {mcpTools.tools.slice(0, PANEL_LIMIT).map((tool) => (
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
          </div>
          {panelFooter(toolCount, "tools", "Open tool browser")}
        </div>
      )}
    </div>
  );
}
