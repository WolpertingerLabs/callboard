import { useState, useEffect, useRef } from "react";
import { useOutletContext } from "react-router-dom";
import { Radio, Loader2, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { getProxyEvents, getProxyIngestors } from "../../../api";
import type { StoredEvent, IngestorStatus, AgentConfig } from "../../../api";

const POLL_INTERVAL = 5_000; // refresh event list every 5s

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 10) return "Just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Color for an ingestor state badge */
function stateColor(state: string): string {
  switch (state) {
    case "connected":
      return "var(--success)";
    case "starting":
    case "reconnecting":
      return "var(--warning)";
    case "stopped":
      return "var(--text-muted)";
    case "error":
      return "var(--error)";
    default:
      return "var(--text-muted)";
  }
}

export default function Events() {
  const { agent } = useOutletContext<{ agent: AgentConfig }>();
  const isMobile = useIsMobile();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [activeSource, setActiveSource] = useState<string | null>(null); // null = all
  const [loading, setLoading] = useState(true);
  const [ingestors, setIngestors] = useState<IngestorStatus[]>([]);
  const [refreshingIngestors, setRefreshingIngestors] = useState(false);
  const [expandedEvent, setExpandedEvent] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasKeys = agent.mcpKeyAliases && agent.mcpKeyAliases.length > 0;

  // Manual refresh handler (with spinner)
  const refreshIngestors = () => {
    setRefreshingIngestors(true);
    getProxyIngestors()
      .then((data) => setIngestors(data.ingestors))
      .catch(() => setIngestors([]))
      .finally(() => setRefreshingIngestors(false));
  };

  // Initial fetch on mount
  useEffect(() => {
    if (!hasKeys) return;
    getProxyIngestors()
      .then((data) => setIngestors(data.ingestors))
      .catch(() => setIngestors([]));
  }, [hasKeys]);

  // Poll events on interval
  useEffect(() => {
    if (!hasKeys) return;
    const fetchEvents = () => {
      getProxyEvents(100)
        .then((data) => {
          setEvents(data.events);
          setSources(data.sources);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    };

    fetchEvents();
    intervalRef.current = setInterval(fetchEvents, POLL_INTERVAL);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [hasKeys]);

  // Filter events by active source
  const filteredEvents = activeSource ? events.filter((e) => e.source === activeSource) : events;

  // Build ingestor lookup
  const ingestorMap = new Map<string, IngestorStatus>();
  for (const ing of ingestors) {
    if (!ingestorMap.has(ing.connection)) ingestorMap.set(ing.connection, ing);
  }

  // Guard: no key aliases assigned
  if (!hasKeys) {
    return (
      <div style={{ padding: isMobile ? "16px" : "24px 32px", maxWidth: 900, margin: "0 auto" }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700 }}>Events</h1>
          <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>Live event feed from all proxy ingestors</p>
        </div>
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
          <Radio size={32} style={{ marginBottom: 12, opacity: 0.5 }} />
          <p style={{ fontWeight: 600, marginBottom: 4 }}>No proxy key assigned</p>
          <p style={{ fontSize: 12 }}>Assign an MCP key alias to this agent in the Overview tab to enable event monitoring.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: isMobile ? "16px" : "24px 32px", maxWidth: 900, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>Events</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>Live event feed from all proxy ingestors — polled every 3 seconds</p>
      </div>

      {/* Ingestor status cards */}
      {ingestors.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <h2 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", margin: 0 }}>
              Ingestors
            </h2>
            <button
              onClick={refreshIngestors}
              disabled={refreshingIngestors}
              style={{
                background: "none",
                border: "none",
                padding: 2,
                cursor: refreshingIngestors ? "not-allowed" : "pointer",
                color: "var(--text-muted)",
                display: "flex",
                alignItems: "center",
                opacity: refreshingIngestors ? 0.4 : 0.7,
                transition: "opacity 0.15s",
              }}
              onMouseEnter={(e) => !refreshingIngestors && (e.currentTarget.style.opacity = "1")}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = refreshingIngestors ? "0.4" : "0.7")}
              title="Refresh ingestor status"
            >
              <RefreshCw size={13} style={refreshingIngestors ? { animation: "spin 1s linear infinite" } : undefined} />
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {ingestors.map((ing) => (
              <div
                key={ing.connection}
                style={{
                  padding: "10px 14px",
                  background: "var(--surface)",
                  border: `1px solid ${ing.state === "connected" ? "color-mix(in srgb, var(--success) 30%, var(--border))" : "var(--border)"}`,
                  borderRadius: 10,
                  fontSize: 12,
                  minWidth: 180,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: stateColor(ing.state), flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, fontFamily: "monospace", fontSize: 13 }}>{ing.connection}</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, color: "var(--text-muted)", fontSize: 11 }}>
                  <span
                    style={{
                      padding: "1px 6px",
                      borderRadius: 4,
                      background: "var(--bg-secondary)",
                      fontWeight: 500,
                      color: stateColor(ing.state),
                    }}
                  >
                    {ing.state}
                  </span>
                  <span>{ing.type}</span>
                  <span>{ing.totalEventsReceived} events</span>
                  {ing.lastEventAt && <span>last: {timeAgo(new Date(ing.lastEventAt).getTime())}</span>}
                </div>
                {ing.error && <div style={{ fontSize: 11, color: "var(--error)", marginTop: 4 }}>{ing.error}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Source filter pills */}
      {sources.length > 1 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
          <button
            onClick={() => setActiveSource(null)}
            style={{
              padding: "5px 12px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 500,
              background: activeSource === null ? "var(--accent)" : "var(--surface)",
              color: activeSource === null ? "#fff" : "var(--text)",
              border: activeSource === null ? "1px solid var(--accent)" : "1px solid var(--border)",
              cursor: "pointer",
            }}
          >
            All ({events.length})
          </button>
          {sources.map((src) => {
            const count = events.filter((e) => e.source === src).length;
            return (
              <button
                key={src}
                onClick={() => setActiveSource(src)}
                style={{
                  padding: "5px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                  fontWeight: 500,
                  fontFamily: "monospace",
                  background: activeSource === src ? "var(--accent)" : "var(--surface)",
                  color: activeSource === src ? "#fff" : "var(--text)",
                  border: activeSource === src ? "1px solid var(--accent)" : "1px solid var(--border)",
                  cursor: "pointer",
                }}
              >
                {src} ({count})
              </button>
            );
          })}
        </div>
      )}

      {/* Event list */}
      {loading ? (
        <div
          style={{
            textAlign: "center",
            padding: "48px 20px",
            color: "var(--text-muted)",
            fontSize: 13,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
          }}
        >
          <Loader2 size={20} style={{ animation: "spin 1s linear infinite", marginBottom: 8 }} />
          <p>Loading events...</p>
        </div>
      ) : filteredEvents.length === 0 ? (
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
          <Radio size={24} style={{ marginBottom: 8, opacity: 0.4 }} />
          <p>No events yet</p>
          <p style={{ fontSize: 12, marginTop: 4 }}>Events from proxy ingestors will appear here as they arrive.</p>
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
          {filteredEvents.map((event, i) => {
            const isExpanded = expandedEvent === event.id;
            const dataPreview = typeof event.data === "string" ? event.data.slice(0, 120) : JSON.stringify(event.data).slice(0, 120);

            return (
              <div
                key={`${event.source}-${event.id}`}
                style={{
                  borderBottom: i < filteredEvents.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                {/* Event row */}
                <div
                  onClick={() => setExpandedEvent(isExpanded ? null : event.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: isMobile ? "10px 12px" : "12px 16px",
                    cursor: "pointer",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-secondary)")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  {isExpanded ? (
                    <ChevronDown size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                  ) : (
                    <ChevronRight size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
                  )}

                  {/* Source badge */}
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      fontFamily: "monospace",
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                      color: "var(--accent)",
                      flexShrink: 0,
                    }}
                  >
                    {event.source}
                  </span>

                  {/* Event type */}
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      fontFamily: "monospace",
                      flexShrink: 0,
                    }}
                  >
                    {event.eventType}
                  </span>

                  {/* Data preview */}
                  <span
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {dataPreview}
                  </span>

                  {/* Timestamp */}
                  <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>{timeAgo(event.storedAt)}</span>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div
                    style={{
                      padding: "0 16px 14px 40px",
                      fontSize: 12,
                    }}
                  >
                    <div style={{ display: "flex", gap: 16, marginBottom: 8, color: "var(--text-muted)" }}>
                      <span>ID: {event.id}</span>
                      <span>Received: {new Date(event.receivedAt).toLocaleString()}</span>
                      <span>Stored: {new Date(event.storedAt).toLocaleString()}</span>
                    </div>
                    <pre
                      style={{
                        background: "var(--bg-secondary)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                        padding: 12,
                        fontSize: 11,
                        fontFamily: "monospace",
                        overflow: "auto",
                        maxHeight: 300,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-all",
                      }}
                    >
                      {typeof event.data === "string" ? event.data : JSON.stringify(event.data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
