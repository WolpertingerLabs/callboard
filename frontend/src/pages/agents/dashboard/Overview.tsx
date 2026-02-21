import { useState, useEffect } from "react";
import { useOutletContext, useNavigate } from "react-router-dom";
import { MessageSquare, Plug, Clock, Radio, ChevronRight, Bot, Save, Check } from "lucide-react";
import { useIsMobile } from "../../../hooks/useIsMobile";
import { updateAgent, getAgentCronJobs, getAgentActivity } from "../../../api";
import type { AgentConfig, ActivityEntry } from "../../../api";

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
  const { agent, onAgentUpdate } = useOutletContext<{ agent: AgentConfig; onAgentUpdate?: (agent: AgentConfig) => void }>();
  const navigate = useNavigate();
  const isMobile = useIsMobile();

  // Identity form state
  const [emoji, setEmoji] = useState(agent.emoji || "");
  const [personality, setPersonality] = useState(agent.personality || "");
  const [role, setRole] = useState(agent.role || "");
  const [tone, setTone] = useState(agent.tone || "");
  const [pronouns, setPronouns] = useState(agent.pronouns || "");
  const [userName, setUserName] = useState(agent.userName || "");
  const [userTimezone, setUserTimezone] = useState(agent.userTimezone || "");
  const [userLocation, setUserLocation] = useState(agent.userLocation || "");
  const [userContext, setUserContext] = useState(agent.userContext || "");
  const [heartbeatEnabled, setHeartbeatEnabled] = useState(agent.heartbeat?.enabled || false);
  const [heartbeatInterval, setHeartbeatInterval] = useState(agent.heartbeat?.intervalMinutes || 30);
  const [quietStart, setQuietStart] = useState(agent.heartbeat?.quietHoursStart || "");
  const [quietEnd, setQuietEnd] = useState(agent.heartbeat?.quietHoursEnd || "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Stats from real APIs
  const [cronCount, setCronCount] = useState(0);
  const [cronTotal, setCronTotal] = useState(0);
  const [recentActivity, setRecentActivity] = useState<ActivityEntry[]>([]);

  const eventSubs = agent.eventSubscriptions || [];
  const activeSubscriptions = eventSubs.filter((s) => s.enabled).length;

  useEffect(() => {
    // Fetch real cron job stats
    getAgentCronJobs(agent.alias)
      .then((jobs) => {
        setCronTotal(jobs.length);
        setCronCount(jobs.filter((j) => j.status === "active").length);
      })
      .catch(() => {
        setCronTotal(0);
        setCronCount(0);
      });

    // Fetch recent activity
    getAgentActivity(agent.alias, undefined, 5)
      .then(setRecentActivity)
      .catch(() => setRecentActivity([]));
  }, [agent.alias]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await updateAgent(agent.alias, {
        emoji: emoji || undefined,
        personality: personality || undefined,
        role: role || undefined,
        tone: tone || undefined,
        pronouns: pronouns || undefined,
        userName: userName || undefined,
        userTimezone: userTimezone || undefined,
        userLocation: userLocation || undefined,
        userContext: userContext || undefined,
        heartbeat: {
          enabled: heartbeatEnabled,
          intervalMinutes: heartbeatInterval,
          quietHoursStart: quietStart || undefined,
          quietHoursEnd: quietEnd || undefined,
        },
      });
      onAgentUpdate?.(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const stats = [
    { label: "Cron Jobs", value: cronCount, total: cronTotal, icon: Clock, color: "var(--success)" },
    { label: "Events", value: activeSubscriptions, total: eventSubs.length, icon: Radio, color: "var(--warning)" },
  ];

  const basePath = `/agents/${agent.alias}`;

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "10px 12px",
    fontSize: 14,
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: 12,
    fontWeight: 500,
    color: "var(--text-muted)",
    marginBottom: 4,
  };

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
              fontSize: agent.emoji ? 22 : undefined,
            }}
          >
            {agent.emoji || <Bot size={22} style={{ color: "var(--accent)" }} />}
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700 }}>{agent.name}</h1>
            <p style={{ fontSize: 14, color: "var(--text-muted)", marginTop: 2 }}>
              {agent.role ? `${agent.role} — ` : ""}
              {agent.description}
            </p>
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "repeat(2, 1fr)",
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
                  <span style={{ fontSize: 13, fontWeight: 400, color: "var(--text-muted)" }}>/{stat.total}</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Active {stat.label}</div>
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

      {/* Identity Settings */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Identity Settings</h2>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 14px",
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              background: "var(--accent)",
              color: "#fff",
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saved ? <Check size={14} /> : <Save size={14} />}
            {saving ? "Saving..." : saved ? "Saved" : "Save"}
          </button>
        </div>
        <div
          style={{
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 20,
            display: "grid",
            gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
            gap: 14,
          }}
        >
          <div>
            <label style={labelStyle}>Emoji</label>
            <input type="text" value={emoji} onChange={(e) => setEmoji(e.target.value)} placeholder="🤖" maxLength={4} style={{ ...inputStyle, width: 80 }} />
          </div>
          <div>
            <label style={labelStyle}>Role</label>
            <input type="text" value={role} onChange={(e) => setRole(e.target.value)} placeholder="e.g. DevOps Assistant" style={inputStyle} />
          </div>
          <div style={{ gridColumn: isMobile ? undefined : "1 / -1" }}>
            <label style={labelStyle}>Personality</label>
            <textarea
              value={personality}
              onChange={(e) => setPersonality(e.target.value)}
              placeholder="Describe the agent's personality..."
              rows={2}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </div>
          <div>
            <label style={labelStyle}>Tone</label>
            <input type="text" value={tone} onChange={(e) => setTone(e.target.value)} placeholder="e.g. casual, professional" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Pronouns</label>
            <input type="text" value={pronouns} onChange={(e) => setPronouns(e.target.value)} placeholder="e.g. they/them" style={inputStyle} />
          </div>

          {/* User context section */}
          <div style={{ gridColumn: isMobile ? undefined : "1 / -1", borderTop: "1px solid var(--border)", paddingTop: 14, marginTop: 4 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
              Your Human
            </p>
          </div>
          <div>
            <label style={labelStyle}>Name</label>
            <input type="text" value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Your name" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Timezone</label>
            <input type="text" value={userTimezone} onChange={(e) => setUserTimezone(e.target.value)} placeholder="e.g. US/Eastern" style={inputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Location</label>
            <input type="text" value={userLocation} onChange={(e) => setUserLocation(e.target.value)} placeholder="e.g. New York" style={inputStyle} />
          </div>
          <div style={{ gridColumn: isMobile ? undefined : "1 / -1" }}>
            <label style={labelStyle}>Additional Context</label>
            <textarea
              value={userContext}
              onChange={(e) => setUserContext(e.target.value)}
              placeholder="Anything else the agent should know about you..."
              rows={2}
              style={{ ...inputStyle, resize: "vertical" }}
            />
          </div>

          {/* Heartbeat section */}
          <div style={{ gridColumn: isMobile ? undefined : "1 / -1", borderTop: "1px solid var(--border)", paddingTop: 14, marginTop: 4 }}>
            <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>
              Heartbeat
            </p>
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
              Periodic check-ins where the agent reads HEARTBEAT.md and decides what to do.
            </p>
          </div>
          <div>
            <label style={labelStyle}>Enabled</label>
            <button
              type="button"
              onClick={() => setHeartbeatEnabled(!heartbeatEnabled)}
              style={{
                padding: "8px 18px",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 500,
                background: heartbeatEnabled ? "var(--success)" : "var(--bg)",
                color: heartbeatEnabled ? "#fff" : "var(--text-muted)",
                border: heartbeatEnabled ? "1px solid var(--success)" : "1px solid var(--border)",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              {heartbeatEnabled ? "On" : "Off"}
            </button>
          </div>
          <div>
            <label style={labelStyle}>Interval (minutes)</label>
            <input
              type="number"
              value={heartbeatInterval}
              onChange={(e) => setHeartbeatInterval(parseInt(e.target.value) || 30)}
              min={5}
              max={1440}
              disabled={!heartbeatEnabled}
              style={{ ...inputStyle, opacity: heartbeatEnabled ? 1 : 0.5 }}
            />
          </div>
          <div>
            <label style={labelStyle}>Quiet Hours Start</label>
            <input
              type="time"
              value={quietStart}
              onChange={(e) => setQuietStart(e.target.value)}
              disabled={!heartbeatEnabled}
              style={{ ...inputStyle, opacity: heartbeatEnabled ? 1 : 0.5 }}
            />
          </div>
          <div>
            <label style={labelStyle}>Quiet Hours End</label>
            <input
              type="time"
              value={quietEnd}
              onChange={(e) => setQuietEnd(e.target.value)}
              disabled={!heartbeatEnabled}
              style={{ ...inputStyle, opacity: heartbeatEnabled ? 1 : 0.5 }}
            />
          </div>
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
          <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Recent Activity</h2>
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
        {recentActivity.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "32px 20px",
              color: "var(--text-muted)",
              fontSize: 14,
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
            }}
          >
            No activity yet. Activity will appear here as the agent runs.
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
                <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>{timeAgo(entry.timestamp)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
