import { useState, useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import { Radio, CircleOff, Loader2 } from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { updateAgent, getAgentActivity, getProxyIngestors } from "../../../api";
import type { AgentConfig, ActivityEntry, IngestorStatus } from "../../../api";
import type { EventSubscription } from "shared";

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
  const { agent, onAgentUpdate } = useOutletContext<{ agent: AgentConfig; onAgentUpdate?: (agent: AgentConfig) => void }>();
  const isMobile = useIsMobile();
  const [subscriptions, setSubscriptions] = useState<EventSubscription[]>([]);
  const [eventActivity, setEventActivity] = useState<ActivityEntry[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadingIngestors, setLoadingIngestors] = useState(true);
  const [ingestors, setIngestors] = useState<IngestorStatus[]>([]);

  // Fetch live ingestor connections from mcp-secure-proxy
  useEffect(() => {
    setLoadingIngestors(true);
    getProxyIngestors()
      .then((data) => setIngestors(data.ingestors))
      .catch(() => setIngestors([]))
      .finally(() => setLoadingIngestors(false));
  }, []);

  // Merge agent subscriptions with live ingestor connections
  useEffect(() => {
    if (loadingIngestors) return;

    const existing = agent.eventSubscriptions || [];
    const existingAliases = new Set(existing.map((s) => s.connectionAlias));

    // Get unique connection aliases from ingestors
    const ingestorAliases = [...new Set(ingestors.map((i) => i.connection))];

    const merged = [
      ...existing,
      ...ingestorAliases.filter((alias) => !existingAliases.has(alias)).map((alias) => ({ connectionAlias: alias, enabled: false })),
    ];
    setSubscriptions(merged);
  }, [agent.eventSubscriptions, ingestors, loadingIngestors]);

  // Load event activity
  useEffect(() => {
    getAgentActivity(agent.alias, "event", 20)
      .then(setEventActivity)
      .catch(() => setEventActivity([]));
  }, [agent.alias]);

  const toggleSubscription = async (alias: string) => {
    const updated = subscriptions.map((s) => (s.connectionAlias === alias ? { ...s, enabled: !s.enabled } : s));
    setSubscriptions(updated);

    setSaving(true);
    try {
      const updatedAgent = await updateAgent(agent.alias, { eventSubscriptions: updated });
      onAgentUpdate?.(updatedAgent);
    } catch {
      setSubscriptions(subscriptions);
    } finally {
      setSaving(false);
    }
  };

  // Build a lookup for ingestor info
  const ingestorByConnection = new Map<string, IngestorStatus>();
  for (const ing of ingestors) {
    // Keep first per connection (they're unique in practice)
    if (!ingestorByConnection.has(ing.connection)) {
      ingestorByConnection.set(ing.connection, ing);
    }
  }

  const enabledCount = subscriptions.filter((s) => s.enabled).length;

  return (
    <div style={{ padding: isMobile ? "16px" : "24px 32px", maxWidth: 800, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Events</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>Connections this agent monitors for new events</p>
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
          Subscriptions ({enabledCount}/{subscriptions.length}){saving && <span style={{ fontSize: 11, fontWeight: 400, marginLeft: 8 }}>Saving...</span>}
        </h2>

        {loadingIngestors ? (
          <div
            style={{
              textAlign: "center",
              padding: "32px 20px",
              color: "var(--text-muted)",
              fontSize: 13,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
            }}
          >
            <Loader2 size={20} style={{ animation: "spin 1s linear infinite", marginBottom: 8 }} />
            <p>Loading ingestors from proxy...</p>
          </div>
        ) : subscriptions.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "32px 20px",
              color: "var(--text-muted)",
              fontSize: 13,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
            }}
          >
            No ingestors configured in mcp-secure-proxy. Add event sources to the proxy to enable subscriptions.
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
            {subscriptions.map((sub, i) => {
              const ingStatus = ingestorByConnection.get(sub.connectionAlias);
              return (
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
                        background: sub.enabled ? "color-mix(in srgb, var(--success) 12%, transparent)" : "var(--bg-secondary)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {sub.enabled ? <Radio size={16} style={{ color: "var(--success)" }} /> : <CircleOff size={16} style={{ color: "var(--text-muted)" }} />}
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
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        {sub.enabled ? "Listening" : "Disabled"}
                        {ingStatus && (
                          <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>
                            &middot; {ingStatus.type} &middot; {ingStatus.totalEventsReceived} events
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => toggleSubscription(sub.connectionAlias)}
                    disabled={saving}
                    style={{
                      padding: "6px 14px",
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 500,
                      background: "transparent",
                      color: sub.enabled ? "var(--warning)" : "var(--success)",
                      border: `1px solid color-mix(in srgb, ${sub.enabled ? "var(--warning)" : "var(--success)"} 30%, transparent)`,
                      transition: "background 0.15s",
                      cursor: saving ? "not-allowed" : "pointer",
                      opacity: saving ? 0.6 : 1,
                    }}
                    onMouseEnter={(e) =>
                      !saving &&
                      (e.currentTarget.style.background = `color-mix(in srgb, ${sub.enabled ? "var(--warning)" : "var(--success)"} 10%, transparent)`)
                    }
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    {sub.enabled ? "Disable" : "Enable"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
          The agent receives all events from enabled connections and decides how to respond based on its personality and guidelines. Connections are configured
          in mcp-secure-proxy.
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
            No event activity yet. Events will appear here when the agent responds to external events.
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
                <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>{timeAgo(entry.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
