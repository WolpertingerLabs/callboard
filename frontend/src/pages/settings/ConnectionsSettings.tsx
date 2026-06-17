import { useState, useEffect } from "react";
import { ExternalLink, Wifi, WifiOff, Server, Monitor, Globe, KeyRound, Loader2, ArrowRight } from "lucide-react";
import { getDaemonStatus } from "../../api";
import type { DaemonStatus } from "../../api";

interface ConnectionsSettingsProps {
  onSwitchTab?: (tab: string) => void;
}

function formatUptime(seconds?: number): string | null {
  if (seconds === undefined || seconds === null) return null;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export default function ConnectionsSettings({ onSwitchTab }: ConnectionsSettingsProps) {
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDaemonStatus()
      .then(setStatus)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const healthy = status?.health?.status === "ok";

  const cardStyle = {
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: 20,
    background: "var(--surface)",
    marginBottom: 16,
  } as const;

  if (loading) {
    return (
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        <div style={{ textAlign: "center", padding: "48px 20px", color: "var(--text-muted)", fontSize: 14 }}>
          <Loader2 size={24} style={{ animation: "spin 1s linear infinite", marginBottom: 12 }} />
          <p>Loading daemon status...</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      {/* Daemon status card */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <Server size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>drawlatch daemon</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.6 }}>
          callboard delegates all proxy, connection, secret, listener and webhook-tunnel management to the drawlatch daemon. This panel only shows
          connectivity — open the dashboard below to manage everything else.
        </div>

        {error && (
          <div
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              fontSize: 12,
              lineHeight: 1.5,
              border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
              background: "var(--danger-bg)",
              color: "var(--danger)",
              marginBottom: 16,
            }}
          >
            {error}
          </div>
        )}

        {status && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {/* Mode */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {status.mode === "local" ? (
                <Monitor size={15} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
              ) : (
                <Globe size={15} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
              )}
              <div style={{ fontSize: 13 }}>
                <span style={{ color: "var(--text-muted)" }}>Mode: </span>
                <span style={{ fontWeight: 600, color: "var(--text)" }}>
                  {status.mode === "local" ? (status.managed ? "Managed local" : "Local") : "Remote"}
                </span>
                {status.managed && status.pid !== undefined && (
                  <span style={{ color: "var(--text-muted)", marginLeft: 6, fontFamily: "monospace", fontSize: 11 }}>(pid {status.pid})</span>
                )}
              </div>
            </div>

            {/* URL */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Globe size={15} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
              <div style={{ fontSize: 13, minWidth: 0 }}>
                <span style={{ color: "var(--text-muted)" }}>URL: </span>
                {status.url ? (
                  <code style={{ fontFamily: "monospace", fontSize: 12, color: "var(--text)" }}>{status.url}</code>
                ) : (
                  <span style={{ color: "var(--text-muted)" }}>not configured</span>
                )}
              </div>
            </div>

            {/* Reachability / health */}
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                padding: "10px 14px",
                borderRadius: 8,
                border: `1px solid ${
                  healthy ? "color-mix(in srgb, var(--success) 30%, transparent)" : "color-mix(in srgb, var(--danger) 30%, transparent)"
                }`,
                background: healthy ? "var(--success-bg)" : "var(--danger-bg)",
                color: healthy ? "var(--success)" : "var(--danger)",
              }}
            >
              {healthy ? <Wifi size={15} style={{ flexShrink: 0, marginTop: 1 }} /> : <WifiOff size={15} style={{ flexShrink: 0, marginTop: 1 }} />}
              <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 600 }}>{healthy ? "Reachable" : status.reachable ? "Unhealthy" : "Unreachable"}</div>
                {status.health && (
                  <div style={{ opacity: 0.85, marginTop: 2 }}>
                    {status.health.activeSessions !== undefined && <span>{status.health.activeSessions} active session(s)</span>}
                    {formatUptime(status.health.uptime) && (
                      <span>
                        {status.health.activeSessions !== undefined ? " · " : ""}up {formatUptime(status.health.uptime)}
                      </span>
                    )}
                    {status.health.tunnelUrl && (
                      <div style={{ marginTop: 2 }}>
                        tunnel: <code style={{ fontFamily: "monospace", fontSize: 11 }}>{status.health.tunnelUrl}</code>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Enrolled aliases */}
            <div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  marginBottom: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <KeyRound size={13} /> Enrolled callers ({status.enrolledAliases.length})
              </div>
              {status.enrolledAliases.length > 0 ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {status.enrolledAliases.map((alias) => (
                    <span
                      key={alias}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 12,
                        fontFamily: "monospace",
                        padding: "4px 6px 4px 10px",
                        borderRadius: 6,
                        background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                        color: "var(--accent)",
                        border: "1px solid color-mix(in srgb, var(--accent) 20%, transparent)",
                      }}
                    >
                      {alias}
                      {/* Source badge: in local mode the daemon auto-shares callers
                          over the shared filesystem; in remote mode they arrive via
                          an imported caller bundle. */}
                      <span
                        style={{
                          fontFamily: "var(--font-sans, sans-serif)",
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          letterSpacing: "0.03em",
                          padding: "1px 6px",
                          borderRadius: 4,
                          background: "color-mix(in srgb, var(--accent) 18%, transparent)",
                        }}
                      >
                        {status.mode === "local" ? "local-auto" : "bundle-issued"}
                      </span>
                    </span>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {status.mode === "local" ? "No callers shared yet — the daemon auto-shares one at boot." : "No callers imported yet."}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Dashboard deep-link card */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <ExternalLink size={16} style={{ color: "var(--accent)" }} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>Manage connections in drawlatch</span>
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.6 }}>
          Connections, secrets, listeners, and the webhook tunnel are all managed in drawlatch&apos;s own password-gated dashboard. Open it to configure
          external services for your agents.
        </div>

        {status?.dashboardUrl ? (
          <a
            href={status.dashboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "var(--accent)",
              color: "var(--text-on-accent)",
              padding: "10px 20px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              textDecoration: "none",
              transition: "background 0.15s",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "var(--accent)")}
          >
            <ExternalLink size={14} />
            Open drawlatch dashboard
          </a>
        ) : (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            No dashboard URL available. Configure the drawlatch endpoint in the Proxy tab first.
          </div>
        )}

        {onSwitchTab && (
          <button
            type="button"
            onClick={() => onSwitchTab("proxy")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              marginTop: 14,
              padding: 0,
              background: "transparent",
              border: "none",
              color: "var(--accent)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            Change the drawlatch endpoint <ArrowRight size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
