import { useState, useMemo } from "react";
import { ChevronDown, ChevronRight, Server, Wrench, Search } from "lucide-react";
import type { McpToolDefinition, McpToolsResponse } from "../api";

interface Props {
  mcpTools: McpToolsResponse | null;
  loading: boolean;
}

const CATEGORY_STYLES: Record<string, { color: string; bg: string; label: string }> = {
  platform: { color: "var(--accent-text)", bg: "var(--accent-bg)", label: "platform" },
  proxy: { color: "var(--badge-info)", bg: "var(--info-bg)", label: "proxy" },
  agent: { color: "var(--success)", bg: "var(--success-bg)", label: "agent" },
  external: { color: "var(--warning)", bg: "var(--warning-bg)", label: "external" },
};

function CategoryBadge({ category }: { category: string }) {
  const style = CATEGORY_STYLES[category] || CATEGORY_STYLES.external;
  return (
    <span
      style={{
        fontSize: "10px",
        color: style.color,
        background: style.bg,
        padding: "2px 6px",
        borderRadius: "4px",
        fontWeight: 600,
        textTransform: "uppercase" as const,
        letterSpacing: "0.03em",
      }}
    >
      {style.label}
    </span>
  );
}

function ToolCard({ tool }: { tool: McpToolDefinition }) {
  const [expanded, setExpanded] = useState(false);
  const hasParams = tool.parameters.length > 0;

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "6px",
        overflow: "hidden",
      }}
    >
      <button
        onClick={() => hasParams && setExpanded(!expanded)}
        style={{
          width: "100%",
          padding: "10px 12px",
          background: "transparent",
          border: "none",
          textAlign: "left" as const,
          cursor: hasParams ? "pointer" : "default",
          display: "flex",
          alignItems: "flex-start",
          gap: "8px",
          transition: "background 0.15s ease",
        }}
        onMouseEnter={(e) => {
          if (hasParams) e.currentTarget.style.background = "var(--accent-bg)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        {hasParams ? (
          expanded ? (
            <ChevronDown size={14} color="var(--text-muted)" style={{ marginTop: 2, flexShrink: 0 }} />
          ) : (
            <ChevronRight size={14} color="var(--text-muted)" style={{ marginTop: 2, flexShrink: 0 }} />
          )
        ) : (
          <Wrench size={14} color="var(--text-muted)" style={{ marginTop: 2, flexShrink: 0 }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <code
            style={{
              fontSize: "13px",
              fontFamily: "var(--font-mono)",
              color: "var(--accent-text)",
              fontWeight: 600,
            }}
          >
            {tool.name}
          </code>
          <p
            style={{
              margin: "2px 0 0",
              fontSize: "12px",
              color: "var(--text-muted)",
              lineHeight: 1.4,
            }}
          >
            {tool.description}
          </p>
        </div>
      </button>

      {expanded && hasParams && (
        <div
          style={{
            padding: "0 12px 10px 34px",
            borderTop: "1px solid var(--border)",
          }}
        >
          <p
            style={{
              margin: "8px 0 6px",
              fontSize: "11px",
              color: "var(--text-muted)",
              fontWeight: 600,
              textTransform: "uppercase" as const,
              letterSpacing: "0.04em",
            }}
          >
            Parameters
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            {tool.parameters.map((param) => (
              <div
                key={param.name}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "6px",
                  fontSize: "12px",
                }}
              >
                <code
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--text)",
                    fontWeight: 500,
                    flexShrink: 0,
                  }}
                >
                  {param.name}
                </code>
                <span style={{ color: "var(--text-muted)", fontSize: "11px", flexShrink: 0 }}>
                  {param.type}
                  {param.enumValues ? ` (${param.enumValues.join(" | ")})` : ""}
                </span>
                {!param.required && (
                  <span
                    style={{
                      fontSize: "10px",
                      color: "var(--text-muted)",
                      background: "var(--bg-secondary)",
                      padding: "1px 4px",
                      borderRadius: "3px",
                      flexShrink: 0,
                    }}
                  >
                    optional
                  </span>
                )}
                {param.description && (
                  <span style={{ color: "var(--text-muted)", fontSize: "11px" }}> — {param.description}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function McpToolsPanel({ mcpTools, loading }: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedServers, setCollapsedServers] = useState<Set<string>>(new Set());

  // Group tools by server
  const toolsByServer = useMemo(() => {
    if (!mcpTools) return new Map<string, McpToolDefinition[]>();
    const map = new Map<string, McpToolDefinition[]>();
    for (const tool of mcpTools.tools) {
      const existing = map.get(tool.serverName) || [];
      existing.push(tool);
      map.set(tool.serverName, existing);
    }
    return map;
  }, [mcpTools]);

  // Filter by search query
  const filteredToolsByServer = useMemo(() => {
    if (!searchQuery.trim()) return toolsByServer;
    const q = searchQuery.toLowerCase();
    const filtered = new Map<string, McpToolDefinition[]>();
    for (const [serverName, tools] of toolsByServer) {
      const matching = tools.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.serverLabel.toLowerCase().includes(q),
      );
      if (matching.length > 0) {
        filtered.set(serverName, matching);
      }
    }
    return filtered;
  }, [toolsByServer, searchQuery]);

  const toggleServer = (name: string) => {
    setCollapsedServers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  if (loading) {
    return (
      <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)" }}>
        Loading tools...
      </div>
    );
  }

  if (!mcpTools || mcpTools.tools.length === 0) {
    return (
      <div style={{ padding: "20px", textAlign: "center", color: "var(--text-muted)" }}>
        <p>No MCP tools available.</p>
      </div>
    );
  }

  // Build ordered server list (platform first, then proxy, agent, external)
  const categoryOrder = ["platform", "proxy", "agent", "external"];
  const orderedServers = [...(mcpTools.servers || [])].sort((a, b) => {
    const ai = categoryOrder.indexOf(a.category);
    const bi = categoryOrder.indexOf(b.category);
    return ai - bi;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Search */}
      <div style={{ position: "relative" }}>
        <Search
          size={14}
          color="var(--text-muted)"
          style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)" }}
        />
        <input
          type="text"
          placeholder="Filter tools..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            width: "100%",
            padding: "8px 12px 8px 30px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            fontSize: "13px",
            color: "var(--text)",
            outline: "none",
            boxSizing: "border-box",
          }}
        />
      </div>

      {/* Tool groups by server */}
      {orderedServers.map((server) => {
        const tools = filteredToolsByServer.get(server.name);
        if (!tools || tools.length === 0) {
          // Show external servers even with no known tools
          if (server.category !== "external") return null;
        }
        const isCollapsed = collapsedServers.has(server.name);

        return (
          <div key={server.name}>
            {/* Server header */}
            <button
              onClick={() => toggleServer(server.name)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "0 0 8px",
                background: "none",
                border: "none",
                cursor: "pointer",
                textAlign: "left" as const,
              }}
            >
              {isCollapsed ? (
                <ChevronRight size={14} color="var(--text-muted)" />
              ) : (
                <ChevronDown size={14} color="var(--text-muted)" />
              )}
              <Server size={14} color="var(--text-muted)" />
              <span
                style={{
                  fontSize: "13px",
                  fontWeight: 600,
                  color: "var(--text)",
                }}
              >
                {server.label}
              </span>
              <CategoryBadge category={server.category} />
              <span
                style={{
                  fontSize: "11px",
                  color: "var(--text-muted)",
                  marginLeft: "auto",
                }}
              >
                {server.category === "external"
                  ? "tools discovered at runtime"
                  : `${tools?.length ?? 0} tool${(tools?.length ?? 0) !== 1 ? "s" : ""}`}
              </span>
              {!server.enabled && (
                <span
                  style={{
                    fontSize: "10px",
                    color: "var(--warning)",
                    background: "var(--warning-bg)",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    fontWeight: 600,
                  }}
                >
                  not configured
                </span>
              )}
            </button>

            {/* Tool cards */}
            {!isCollapsed && tools && tools.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px", paddingLeft: "4px" }}>
                {tools.map((tool) => (
                  <ToolCard key={tool.qualifiedName} tool={tool} />
                ))}
              </div>
            )}

            {/* External servers with no known tools */}
            {!isCollapsed && server.category === "external" && (!tools || tools.length === 0) && (
              <p
                style={{
                  margin: "0 0 0 4px",
                  fontSize: "12px",
                  color: "var(--text-muted)",
                  fontStyle: "italic",
                }}
              >
                Tools are discovered when a session connects to this server.
              </p>
            )}
          </div>
        );
      })}

      {filteredToolsByServer.size === 0 && searchQuery && (
        <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
          No tools matching &ldquo;{searchQuery}&rdquo;
        </div>
      )}
    </div>
  );
}
