import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Loader2 } from "lucide-react";
import { useDaemon } from "../contexts/DaemonContext";
import { api, isDaemonDown } from "../api";
import { formatUptime } from "../utils/format";
import type { AdminHealth } from "drawlatch-admin-types";
import "./Overview.css";

interface SecretStats {
  total: number;
  configured: number;
}

export default function Overview() {
  const { daemon, meta, tick } = useDaemon();
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [secrets, setSecrets] = useState<SecretStats | null>(null);
  // Tunnel toggle state. `tunnelOptimistic` lets the toggle reflect the new
  // value immediately after a successful PUT instead of waiting for the next
  // 5s daemon poll. Cleared on every fresh meta arrival.
  const [tunnelSaving, setTunnelSaving] = useState(false);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const [tunnelOptimistic, setTunnelOptimistic] = useState<boolean | null>(null);
  useEffect(() => {
    setTunnelOptimistic(null);
  }, [meta?.tunnelEnabled]);

  useEffect(() => {
    if (daemon !== "up") return;
    let cancelled = false;
    (async () => {
      const [healthRes, secretsRes] = await Promise.all([
        api.health(),
        api.secrets(),
      ]);
      if (cancelled) return;
      if (!isDaemonDown(healthRes)) setHealth(healthRes);
      if (!isDaemonDown(secretsRes)) {
        const total = secretsRes.length;
        const configured = secretsRes.filter((s) => s.present).length;
        setSecrets({ total, configured });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [daemon, tick]);

  if (daemon === "unknown") {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Overview</h1>
        </header>
        <div className="banner banner-loading">Connecting to daemon…</div>
      </>
    );
  }

  if (daemon === "down") {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Overview</h1>
        </header>
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            Drawlatch daemon is not reachable on its loopback admin port.
            Start it with <code>drawlatch start</code> and this view will
            recover automatically.
          </span>
        </div>
      </>
    );
  }

  const counts = health?.ingestorCounts;
  const ingestorTotal = counts
    ? counts.connected + counts.error + counts.starting + counts.stopped
    : 0;

  const tunnelEnabled = tunnelOptimistic ?? meta?.tunnelEnabled ?? false;
  const tunnelUrl = meta?.tunnelUrl ?? null;
  // Intent and runtime disagree until the daemon restarts.
  const tunnelNeedsRestart =
    !!meta && tunnelEnabled !== (tunnelUrl !== null);

  const handleToggleTunnel = async () => {
    if (tunnelSaving || !meta) return;
    const next = !tunnelEnabled;
    setTunnelSaving(true);
    setTunnelError(null);
    const res = await api.setTunnel(next);
    setTunnelSaving(false);
    if (!res.ok) {
      setTunnelError(res.error);
      return;
    }
    setTunnelOptimistic(next);
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Overview</h1>
          <div className="page-subtitle">
            {meta?.configPath ?? ""}
          </div>
        </div>
      </header>

      <section className="card-grid">
        <div className="card">
          <span className="card-label">Status</span>
          <span className="card-value" style={{ color: "var(--success)" }}>
            running
          </span>
          <span className="card-sub">pid {meta?.pid ?? "—"}</span>
        </div>

        <div className="card">
          <span className="card-label">Port</span>
          <span className="card-value card-value-mono">{meta?.port ?? "—"}</span>
          <span className="card-sub">loopback only</span>
        </div>

        <div className="card">
          <span className="card-label">Uptime</span>
          <span className="card-value">
            {health ? formatUptime(health.uptimeSec) : "—"}
          </span>
          {meta?.startedAt && (
            <span className="card-sub">
              since {new Date(meta.startedAt).toLocaleString()}
            </span>
          )}
        </div>

        <div className="card">
          <span className="card-label">Version</span>
          <span className="card-value card-value-mono">
            {meta?.version ?? "—"}
          </span>
        </div>

        <div className="card">
          <span className="card-label">Active Sessions</span>
          <span className="card-value">{health?.activeSessions ?? "—"}</span>
        </div>

        <div className="card span-2 dl-tunnel-card">
          <div className="dl-tunnel-head">
            <span className="card-label">Tunnel</span>
            <button
              type="button"
              role="switch"
              aria-checked={tunnelEnabled}
              aria-label="Toggle cloudflared tunnel"
              className={`dl-tunnel-switch dl-tap-compact ${tunnelEnabled ? "is-on" : ""}`}
              disabled={tunnelSaving || !meta}
              onClick={() => void handleToggleTunnel()}
            >
              <span className="dl-tunnel-switch-knob" />
              {tunnelSaving && (
                <Loader2 size={12} className="dl-tunnel-switch-spin" />
              )}
            </button>
          </div>

          <div className="dl-tunnel-status">
            {tunnelEnabled && tunnelUrl ? (
              <>
                <span className="status-dot up" aria-hidden="true" />
                <a
                  href={tunnelUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="dl-tunnel-url mono"
                >
                  {tunnelUrl}
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              </>
            ) : tunnelEnabled && !tunnelUrl ? (
              <>
                <span className="status-dot warn" aria-hidden="true" />
                <span className="card-sub">Enabled — restart to activate</span>
              </>
            ) : !tunnelEnabled && tunnelUrl ? (
              <>
                <span className="status-dot warn" aria-hidden="true" />
                <span className="card-sub">Disabled — restart to take effect</span>
              </>
            ) : (
              <>
                <span className="status-dot stopped" aria-hidden="true" />
                <span className="card-sub">Disabled</span>
              </>
            )}
          </div>

          <span className="card-sub dl-tunnel-hint">
            Public cloudflared URL for webhook callbacks. Persists to{" "}
            <code className="mono">remote.config.json</code>.
          </span>

          {tunnelError && (
            <div className="dl-tunnel-error">
              <AlertTriangle size={12} /> {tunnelError}
            </div>
          )}
        </div>

        {tunnelNeedsRestart && (
          <div className="banner banner-warn dl-tunnel-restart-banner">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>
              Restart drawlatch to apply tunnel changes — run{" "}
              <code className="mono">drawlatch restart</code>, or restart
              callboard if it manages the daemon.
            </span>
          </div>
        )}

        <div className="card span-2">
          <span className="card-label">Ingestors ({ingestorTotal})</span>
          <div className="ingestor-breakdown">
            <span className="ingestor-stat ingestor-stat-connected">
              <span className="status-dot" aria-hidden="true" />
              {counts?.connected ?? 0} connected
            </span>
            <span className="ingestor-stat ingestor-stat-starting">
              <span className="status-dot" aria-hidden="true" />
              {counts?.starting ?? 0} starting
            </span>
            <span className="ingestor-stat ingestor-stat-error">
              <span className="status-dot" aria-hidden="true" />
              {counts?.error ?? 0} error
            </span>
            <span className="ingestor-stat ingestor-stat-stopped">
              <span className="status-dot" aria-hidden="true" />
              {counts?.stopped ?? 0} stopped
            </span>
          </div>
        </div>

        <div className="card">
          <span className="card-label">Secrets</span>
          <span className="card-value">
            {secrets
              ? `${secrets.configured} of ${secrets.total}`
              : "—"}
          </span>
          <span className="card-sub">configured</span>
        </div>
      </section>
    </>
  );
}
