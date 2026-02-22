import { useState, useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { getAgentActivity } from "../../../api";
import type { ActivityEntry, AgentConfig } from "../../../api";

const typeColors: Record<string, string> = {
  chat: "var(--accent)",
  event: "var(--warning)",
  cron: "var(--success)",
  connection: "#58a6ff",
  system: "var(--text-muted)",
  trigger: "#a78bfa",
  consolidation: "#f59e0b",
};

const typeLabels: Record<string, string> = {
  chat: "Chat",
  event: "Event",
  cron: "Cron",
  connection: "Connection",
  system: "System",
  trigger: "Trigger",
  consolidation: "Consolidation",
};

const filterOptions = ["all", "chat", "event", "cron", "connection", "system", "trigger", "consolidation"] as const;

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const isYesterday = new Date(now.getTime() - 86400000).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (isYesterday) return `Yesterday at ${time}`;

  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} at ${time}`;
}

export default function Activity() {
  const { agent } = useOutletContext<{ agent: AgentConfig }>();
  const isMobile = useIsMobile();
  const [filter, setFilter] = useState<(typeof filterOptions)[number]>("all");
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const type = filter === "all" ? undefined : filter;
    getAgentActivity(agent.alias, type, 100)
      .then((data) => {
        if (!cancelled) {
          setEntries(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEntries([]);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [agent.alias, filter]);

  return (
    <div style={{ padding: isMobile ? "16px" : "24px 32px", maxWidth: 800, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Activity</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>Timeline of agent actions and events</p>
      </div>

      {/* Filter pills */}
      <div
        style={{
          display: "flex",
          gap: 6,
          marginBottom: 20,
          flexWrap: "wrap",
        }}
      >
        {filterOptions.map((opt) => {
          const isActive = filter === opt;
          const color = opt === "all" ? "var(--text)" : typeColors[opt];
          return (
            <button
              key={opt}
              onClick={() => setFilter(opt)}
              style={{
                padding: "6px 14px",
                borderRadius: 20,
                fontSize: 13,
                fontWeight: isActive ? 600 : 400,
                background: isActive ? `color-mix(in srgb, ${color} 15%, transparent)` : "transparent",
                color: isActive ? color : "var(--text-muted)",
                border: isActive ? `1px solid color-mix(in srgb, ${color} 30%, transparent)` : "1px solid var(--border)",
                transition: "all 0.15s",
              }}
            >
              {opt === "all" ? "All" : typeLabels[opt]}
            </button>
          );
        })}
      </div>

      {/* Timeline */}
      {loading ? (
        <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--text-muted)", fontSize: 14 }}>Loading activity...</div>
      ) : entries.length === 0 ? (
        <div
          style={{
            textAlign: "center",
            padding: "48px 20px",
            color: "var(--text-muted)",
            fontSize: 14,
          }}
        >
          {filter === "all" ? "No activity yet. Activity will appear here as the agent runs." : "No activity matching this filter."}
        </div>
      ) : (
        <div style={{ position: "relative" }}>
          {/* Timeline line */}
          <div
            style={{
              position: "absolute",
              left: 15,
              top: 0,
              bottom: 0,
              width: 2,
              background: "var(--border)",
            }}
          />

          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {entries.map((entry) => {
              const color = typeColors[entry.type] || "var(--text-muted)";
              return (
                <div
                  key={entry.id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 14,
                    padding: "12px 0",
                    position: "relative",
                  }}
                >
                  {/* Dot */}
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: color,
                      flexShrink: 0,
                      marginTop: 4,
                      marginLeft: 11,
                      position: "relative",
                      zIndex: 1,
                      boxShadow: `0 0 0 3px var(--bg)`,
                    }}
                  />

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 3,
                      }}
                    >
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          color,
                          textTransform: "uppercase",
                          letterSpacing: "0.04em",
                        }}
                      >
                        {typeLabels[entry.type]}
                      </span>
                      <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{formatTimestamp(entry.timestamp)}</span>
                    </div>
                    <p style={{ fontSize: 14, lineHeight: 1.5 }}>{entry.message}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
