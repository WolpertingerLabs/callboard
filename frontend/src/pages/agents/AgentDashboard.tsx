import { useState, useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { ChevronLeft, LayoutDashboard, MessageSquare, Clock, Zap, Plug, Radio, Activity, Brain, Bot, ArrowLeft } from "lucide-react";
import { useIsMobile } from "../../hooks/useIsMobile";
import { getAgent as fetchAgent, getAgentIdentityPrompt } from "../../api";
import type { AgentConfig, DefaultPermissions } from "shared";

// Dashboard sub-pages
import Overview from "./dashboard/Overview";

import CronJobs from "./dashboard/CronJobs";
import Triggers from "./dashboard/Triggers";
import Connections from "./dashboard/Connections";
import Events from "./dashboard/Events";
import AgentActivity from "./dashboard/Activity";
import Memory from "./dashboard/Memory";

const navItems = [
  { key: "", label: "Overview", icon: LayoutDashboard },
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

  // Render the active sub-page based on URL path
  const renderSubPage = () => {
    if (!agent) return null;
    switch (subPath) {
      case "cron":
        return <CronJobs agent={agent} />;
      case "triggers":
        return <Triggers agent={agent} />;
      case "connections":
        return <Connections agent={agent} />;
      case "events":
        return <Events agent={agent} />;
      case "activity":
        return <AgentActivity agent={agent} />;
      case "memory":
        return <Memory agent={agent} />;
      default:
        return <Overview agent={agent} onAgentUpdate={setAgent} />;
    }
  };

  // Start a new chat with this agent (same flow as ChatList's handleAgentCreate)
  const handleStartChat = async () => {
    if (!agent?.workspacePath) return;

    const agentPermissions: DefaultPermissions = {
      fileRead: "allow",
      fileWrite: "allow",
      codeExecution: "allow",
      webAccess: "allow",
    };

    let systemPrompt: string | undefined;
    try {
      systemPrompt = await getAgentIdentityPrompt(agent.alias);
    } catch {
      // Continue without identity prompt if fetch fails
    }

    navigate(`/chat/new?folder=${encodeURIComponent(agent.workspacePath)}`, {
      state: {
        defaultPermissions: agentPermissions,
        systemPrompt,
        agentAlias: agent.alias,
      },
    });
  };

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

  // ── Unified layout: header + tab bar + content (both mobile & desktop) ──
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexShrink: 0,
        }}
      >
        {isMobile && (
          <button
            onClick={() => navigate("/agents")}
            style={{
              background: "none",
              border: "none",
              padding: "4px 8px",
              cursor: "pointer",
              color: "var(--text)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <ChevronLeft size={20} />
          </button>
        )}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div
            style={{
              fontSize: 18,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {agent.name}
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
        <button
          onClick={handleStartChat}
          disabled={!agent.workspacePath}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            fontSize: 13,
            fontWeight: 500,
            cursor: agent.workspacePath ? "pointer" : "not-allowed",
            padding: "8px 14px",
            borderRadius: 8,
            transition: "background 0.15s",
            flexShrink: 0,
            opacity: agent.workspacePath ? 1 : 0.5,
          }}
          onMouseEnter={(e) => {
            if (agent.workspacePath) e.currentTarget.style.background = "var(--accent-hover)";
          }}
          onMouseLeave={(e) => {
            if (agent.workspacePath) e.currentTarget.style.background = "var(--accent)";
          }}
          title={agent.workspacePath ? "Start a new chat with this agent" : "Set a workspace path to enable chat"}
        >
          <MessageSquare size={14} />
          {!isMobile && "Chat"}
        </button>
        {!isMobile && (
          <button
            onClick={() => navigate("/agents")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              fontSize: 13,
              cursor: "pointer",
              padding: "6px 10px",
              borderRadius: 8,
              transition: "background 0.15s",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <ArrowLeft size={14} />
            All Agents
          </button>
        )}
      </header>

      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "8px 16px",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
          overflowX: "auto",
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
                alignItems: "center",
                gap: 6,
                padding: "8px 16px",
                borderRadius: 8,
                border: "none",
                fontSize: 13,
                fontWeight: isActive ? 600 : 500,
                background: isActive ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent",
                color: isActive ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                transition: "background 0.15s, color 0.15s",
                whiteSpace: "nowrap",
                flex: isMobile ? 1 : undefined,
                justifyContent: isMobile ? "center" : undefined,
              }}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.background = "var(--bg-secondary)";
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.background = "transparent";
              }}
            >
              <Icon size={14} />
              {item.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 16 }}>{renderSubPage()}</div>
    </div>
  );
}
