import { useOutletContext, useNavigate } from "react-router-dom";
import {
  MessageSquare,
  Plug,
  Clock,
  Radio,
  ChevronRight,
  Bot,
} from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { mockActivity, mockConnections, mockCronJobs, mockEventSubscriptions } from "./mockData";
import type { AgentConfig } from "shared";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const typeColors: Record<string, string> = {
  chat: "var(--accent)",
  event: "var(--warning)",
  cron: "var(--success)",
  connection: "#58a6ff",
  system: "var(--text-muted)",
};

export default function Overview() {
  const { agent } = useOutletContext<{ agent: AgentConfig }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  const activeConnections = mockConnections.filter((c) => c.status === "connected").length;
  const activeCrons = mockCronJobs.filter((c) => c.status === "active").length;
  const activeSubscriptions = mockEventSubscriptions.filter((s) => s.enabled).length;
  const recentActivity = mockActivity.slice(0, 5);

  const stats = [
    { label: "Connections", value: activeConnections, total: mockConnections.length, icon: Plug, color: "#58a6ff" },
    { label: "Cron Jobs", value: activeCrons, total: mockCronJobs.length, icon: Clock, color: "var(--success)" },
    { label: "Events", value: activeSubscriptions, total: mockEventSubscriptions.length, icon: Radio, color: "var(--warning)" },
  ];

  const basePath = `/agents/${agent.alias}`;

  return (
    <div style={{ padding: isMobile ? "16px" : "24px 32px", maxWidth: 800, margin: "0 auto" }}>
      {/* Agent header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 8 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Bot size={22} style={{ color: "var(--accent)" }} />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700 }}>{agent.name}</h1>
            <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 2 }}>
              {agent.description}
            </p>
          </div>
        </div>

        {agent.systemPrompt && (
          <div
            style={{
              marginTop: 12,
              padding: "12px 14px",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontSize: 13,
              color: "var(--text-muted)",
              lineHeight: 1.6,
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              maxHeight: 120,
              overflow: "auto",
            }}
          >
            {agent.systemPrompt}
          </div>
        )}
      </div>

      {/* Stat cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)",
          gap: 12,
          marginBottom: 28,
        }}
      >
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div
              key={stat.label}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "16px 18px",
                display: "flex",
                alignItems: "center",
                gap: 14,
              }}
            >
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: `color-mix(in srgb, ${stat.color} 12%, transparent)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Icon size={18} style={{ color: stat.color }} />
              </div>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>
                  {stat.value}
                  <span style={{ fontSize: 13, fontWeight: 400, color: "var(--text-muted)" }}>
                    /{stat.total}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  Active {stat.label}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Quick actions */}
      <div style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-muted)", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Quick Actions
        </h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={() => navigate(`${basePath}/chat`)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "var(--accent)",
              color: "#fff",
              padding: "10px 18px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent)")}
          >
            <MessageSquare size={16} />
            Open Chat
          </button>
          <button
            onClick={() => navigate(`${basePath}/connections`)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "transparent",
              color: "var(--text-muted)",
              padding: "10px 18px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              border: "1px solid var(--border)",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <Plug size={16} />
            View Connections
          </button>
          <button
            onClick={() => navigate(`${basePath}/events`)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: "transparent",
              color: "var(--text-muted)",
              padding: "10px 18px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              border: "1px solid var(--border)",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <Radio size={16} />
            Manage Events
          </button>
        </div>
      </div>

      {/* Recent activity */}
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Recent Activity
          </h2>
          <button
            onClick={() => navigate(`${basePath}/activity`)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              background: "transparent",
              color: "var(--accent)",
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            View all
            <ChevronRight size={14} />
          </button>
        </div>
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
          }}
        >
          {recentActivity.map((entry, i) => (
            <div
              key={entry.id}
              style={{
                padding: "12px 16px",
                display: "flex",
                alignItems: "center",
                gap: 12,
                borderBottom: i < recentActivity.length - 1 ? "1px solid var(--border)" : "none",
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: typeColors[entry.type] || "var(--text-muted)",
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <p
                  style={{
                    fontSize: 13,
                    lineHeight: 1.5,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {entry.message}
                </p>
              </div>
              <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
                {timeAgo(entry.timestamp)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
