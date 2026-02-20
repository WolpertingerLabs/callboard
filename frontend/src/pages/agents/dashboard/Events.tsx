import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { Radio, CircleOff } from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { mockEventSubscriptions, mockActivity } from "./mockData";
import type { EventSubscription, ActivityEntry } from "./mockData";
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

export default function Events() {
  useOutletContext<{ agent: AgentConfig }>();
  const isMobile = useIsMobile();
  const [subscriptions, setSubscriptions] = useState<EventSubscription[]>(mockEventSubscriptions);

  const eventActivity: ActivityEntry[] = mockActivity.filter((a) => a.type === "event");

  const toggleSubscription = (alias: string) => {
    setSubscriptions((prev) =>
      prev.map((s) =>
        s.connectionAlias === alias ? { ...s, enabled: !s.enabled } : s,
      ),
    );
  };

  const enabledCount = subscriptions.filter((s) => s.enabled).length;

  return (
    <div style={{ padding: isMobile ? "16px" : "24px 32px", maxWidth: 800, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Events</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
          Connections this agent monitors for new events
        </p>
      </div>

      {/* Event Subscriptions */}
      <div style={{ marginBottom: 32 }}>
        <h2
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginBottom: 12,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Subscriptions ({enabledCount}/{subscriptions.length})
        </h2>
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            overflow: "hidden",
          }}
        >
          {subscriptions.map((sub, i) => (
            <div
              key={sub.connectionAlias}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: isMobile ? "12px 14px" : "14px 20px",
                borderBottom: i < subscriptions.length - 1 ? "1px solid var(--border)" : "none",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    background: sub.enabled
                      ? "color-mix(in srgb, var(--success) 12%, transparent)"
                      : "var(--bg-secondary)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {sub.enabled ? (
                    <Radio size={16} style={{ color: "var(--success)" }} />
                  ) : (
                    <CircleOff size={16} style={{ color: "var(--text-muted)" }} />
                  )}
                </div>
                <div>
                  <span
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      fontFamily: "monospace",
                    }}
                  >
                    {sub.connectionAlias}
                  </span>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      marginTop: 2,
                      color: sub.enabled ? "var(--success)" : "var(--text-muted)",
                    }}
                  >
                    {sub.enabled ? "Listening" : "Disabled"}
                  </div>
                </div>
              </div>
              <button
                onClick={() => toggleSubscription(sub.connectionAlias)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 500,
                  background: "transparent",
                  color: sub.enabled ? "var(--warning)" : "var(--success)",
                  border: `1px solid color-mix(in srgb, ${sub.enabled ? "var(--warning)" : "var(--success)"} 30%, transparent)`,
                  transition: "background 0.15s",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.background = `color-mix(in srgb, ${sub.enabled ? "var(--warning)" : "var(--success)"} 10%, transparent)`)
                }
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {sub.enabled ? "Disable" : "Enable"}
              </button>
            </div>
          ))}
        </div>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
          The agent receives all events from enabled connections and decides how to respond based on its
          personality and guidelines. Connections are configured in mcp-secure-proxy.
        </p>
      </div>

      {/* Event Activity Feed */}
      <div>
        <h2
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "var(--text-muted)",
            marginBottom: 12,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Recent Event Activity
        </h2>
        {eventActivity.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "48px 20px",
              color: "var(--text-muted)",
              fontSize: 14,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
            }}
          >
            No event activity yet.
          </div>
        ) : (
          <div
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              overflow: "hidden",
            }}
          >
            {eventActivity.map((entry, i) => (
              <div
                key={entry.id}
                style={{
                  padding: "12px 16px",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  borderBottom: i < eventActivity.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "var(--warning)",
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
        )}
      </div>
    </div>
  );
}
