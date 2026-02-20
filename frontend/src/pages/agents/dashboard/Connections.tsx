import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Plus, Wifi, WifiOff, AlertTriangle, MessageCircle, Hash, Mail, Cpu, LayoutGrid, MessagesSquare } from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { mockConnections } from "./mockData";
import type { MockConnection } from "./mockData";
import type { AgentConfig } from "shared";

const serviceIcons: Record<string, typeof MessageCircle> = {
  Discord: MessageCircle,
  Slack: MessagesSquare,
  Google: LayoutGrid,
  OpenRouter: Cpu,
  Trello: Hash,
  Gmail: Mail,
};

const statusConfig: Record<string, { color: string; label: string; icon: typeof Wifi }> = {
  connected: { color: "var(--success)", label: "Connected", icon: Wifi },
  disconnected: { color: "var(--text-muted)", label: "Disconnected", icon: WifiOff },
  error: { color: "var(--danger)", label: "Error", icon: AlertTriangle },
};

const typeLabels: Record<string, string> = {
  bot: "Bot",
  api: "API Key",
  oauth: "OAuth",
};

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

export default function Connections() {
  useOutletContext<{ agent: AgentConfig }>();
  const isMobile = useIsMobile();
  const [connections, setConnections] = useState<MockConnection[]>(mockConnections);

  const toggleConnection = (id: string) => {
    setConnections((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              status: c.status === "connected" ? "disconnected" : "connected",
              connectedAt: c.status !== "connected" ? Date.now() : c.connectedAt,
            }
          : c,
      ),
    );
  };

  return (
    <div style={{ padding: isMobile ? "16px" : "24px 32px", maxWidth: 800, margin: "0 auto" }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 20,
        }}
      >
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Connections</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
            Remote services and integrations
          </p>
        </div>
        <button
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "var(--accent)",
            color: "#fff",
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 14,
            fontWeight: 500,
            transition: "background 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-hover)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent)")}
        >
          <Plus size={16} />
          {!isMobile && "Add Connection"}
        </button>
      </div>

      {/* Connection cards grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "repeat(2, 1fr)",
          gap: 12,
        }}
      >
        {connections.map((conn) => {
          const sConf = statusConfig[conn.status];
          const StatusIcon = sConf.icon;
          const ServiceIcon = serviceIcons[conn.service] || Cpu;

          return (
            <div
              key={conn.id}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius)",
                padding: "16px 18px",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              {/* Top: icon, name, status */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: `color-mix(in srgb, ${sConf.color} 12%, transparent)`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <ServiceIcon size={18} style={{ color: sConf.color }} />
                  </div>
                  <div>
                    <h3 style={{ fontSize: 15, fontWeight: 600 }}>{conn.service}</h3>
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--text-muted)",
                        background: "var(--bg-secondary)",
                        padding: "1px 6px",
                        borderRadius: 4,
                      }}
                    >
                      {typeLabels[conn.type]}
                    </span>
                  </div>
                </div>
                {/* Status dot + label */}
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <StatusIcon size={14} style={{ color: sConf.color }} />
                  <span style={{ fontSize: 12, fontWeight: 500, color: sConf.color }}>
                    {sConf.label}
                  </span>
                </div>
              </div>

              {/* Description */}
              <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
                {conn.description}
              </p>

              {/* Footer */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  paddingTop: 10,
                  borderTop: "1px solid var(--border)",
                }}
              >
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {conn.connectedAt ? `Since ${timeAgo(conn.connectedAt)}` : "Never connected"}
                </span>
                <button
                  onClick={() => toggleConnection(conn.id)}
                  style={{
                    padding: "5px 12px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: 500,
                    background: "transparent",
                    color: conn.status === "connected" ? "var(--danger)" : "var(--success)",
                    border: `1px solid color-mix(in srgb, ${conn.status === "connected" ? "var(--danger)" : "var(--success)"} 30%, transparent)`,
                    transition: "background 0.15s",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = `color-mix(in srgb, ${conn.status === "connected" ? "var(--danger)" : "var(--success)"} 10%, transparent)`)
                  }
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  {conn.status === "connected" ? "Disconnect" : "Connect"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
