import { useState, useEffect } from "react";
import { Outlet, useParams, useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, LayoutDashboard, MessageSquare, Clock, Zap, Plug, Radio, Activity, Brain, Bot } from "lucide-react";
import { useIsMobile } from "../../hooks/useIsMobile";
import { getAgent as fetchAgent } from "../../api";
import type { AgentConfig } from "shared";

const navItems = [
  { key: "", label: "Overview", icon: LayoutDashboard },
  { key: "chat", label: "Chat", icon: MessageSquare },
  { key: "cron", label: "Cron Jobs", icon: Clock },
  { key: "triggers", label: "Triggers", icon: Zap },
  { key: "connections", label: "Connections", icon: Plug },
  { key: "events", label: "Events", icon: Radio },
  { key: "activity", label: "Activity", icon: Activity },
  { key: "memory", label: "Memory", icon: Brain },
];

export default function AgentDashboard() {
  const { alias } = useParams<{ alias: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [agent, setAgent] = useState<AgentConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!alias) return;
    fetchAgent(alias)
      .then((a) => setAgent(a))
      .catch(() => setAgent(null))
      .finally(() => setLoading(false));
  }, [alias]);

  // Determine active tab from the URL
  const basePath = `/agents/${alias}`;
  const subPath = location.pathname.replace(basePath, "").replace(/^\//, "");
  const activeKey = navItems.find((n) => n.key === subPath)?.key ?? "";

  if (loading) return null;

  if (!agent) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
        }}
      >
        <Bot size={40} style={{ color: "var(--text-muted)" }} />
        <p style={{ color: "var(--text-muted)", fontSize: 16 }}>Agent not found</p>
        <button
          onClick={() => navigate("/agents")}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "var(--accent)",
            color: "#fff",
            padding: "8px 16px",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          <ArrowLeft size={16} />
          Back to agents
        </button>
      </div>
    );
  }

  // ── Mobile layout: top header + content + bottom tab bar ──
  if (isMobile) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Mobile header */}
        <div
          style={{
            padding: "10px 16px",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <button
            onClick={() => navigate("/agents")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              padding: 6,
              borderRadius: 6,
            }}
          >
            <ArrowLeft size={20} style={{ color: "var(--text-muted)" }} />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                fontSize: 16,
                fontWeight: 600,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {agent.name}
            </h1>
          </div>
          <span
            style={{
              fontSize: 11,
              fontFamily: "monospace",
              color: "var(--accent)",
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              padding: "2px 8px",
              borderRadius: 6,
              flexShrink: 0,
            }}
          >
            {agent.alias}
          </span>
        </div>

        {/* Content area */}
        <div style={{ flex: 1, overflow: "auto" }}>
          <Outlet context={{ agent, onAgentUpdate: setAgent }} />
        </div>

        {/* Mobile bottom tab bar */}
        <div
          style={{
            borderTop: "1px solid var(--border)",
            background: "var(--surface)",
            display: "flex",
            overflowX: "auto",
            flexShrink: 0,
            paddingBottom: "var(--safe-bottom)",
          }}
        >
          {navItems.map((item) => {
            const isActive = activeKey === item.key;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                onClick={() => navigate(item.key ? `${basePath}/${item.key}` : basePath)}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 2,
                  padding: "8px 12px",
                  minWidth: 64,
                  flex: "0 0 auto",
                  background: "transparent",
                  color: isActive ? "var(--accent)" : "var(--text-muted)",
                  fontSize: 10,
                  fontWeight: isActive ? 600 : 400,
                  transition: "color 0.15s",
                }}
              >
                <Icon size={18} />
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Desktop layout: sidebar + content ──
  return (
    <div style={{ height: "100%", display: "flex", overflow: "hidden" }}>
      {/* Sidebar */}
      <div
        style={{
          width: 220,
          flexShrink: 0,
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          background: "var(--surface)",
        }}
      >
        {/* Agent info */}
        <div style={{ padding: "20px 16px 16px", borderBottom: "1px solid var(--border)" }}>
          <h2
            style={{
              fontSize: 15,
              fontWeight: 600,
              marginBottom: 4,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {agent.name}
          </h2>
          <span
            style={{
              fontSize: 11,
              fontFamily: "monospace",
              color: "var(--accent)",
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              padding: "2px 8px",
              borderRadius: 6,
              display: "inline-block",
            }}
          >
            {agent.alias}
          </span>
        </div>

        {/* Nav items */}
        <nav style={{ flex: 1, padding: "8px", display: "flex", flexDirection: "column", gap: 2 }}>
          {navItems.map((item) => {
            const isActive = activeKey === item.key;
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                onClick={() => navigate(item.key ? `${basePath}/${item.key}` : basePath)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "10px 12px",
                  borderRadius: 8,
                  fontSize: 14,
                  fontWeight: isActive ? 600 : 400,
                  background: isActive ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
                  color: isActive ? "var(--accent)" : "var(--text-muted)",
                  transition: "background 0.15s, color 0.15s",
                  textAlign: "left",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = "var(--bg-secondary)";
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = "transparent";
                }}
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Back button */}
        <div style={{ padding: "12px", borderTop: "1px solid var(--border)" }}>
          <button
            onClick={() => navigate("/agents")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "10px 12px",
              borderRadius: 8,
              fontSize: 13,
              color: "var(--text-muted)",
              background: "transparent",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <ArrowLeft size={16} />
            All Agents
          </button>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflow: "auto" }}>
        <Outlet context={{ agent }} />
      </div>
    </div>
  );
}
