import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowRight, ExternalLink, Loader2 } from "lucide-react";
import type { AdminHealth, AdminIngestor, IngestorState } from "drawlatch-admin-types";
import { useDaemon } from "../contexts/DaemonContext";
import { api, isDaemonDown } from "../api";
import { useNow, usePolling } from "../hooks/usePolling";
import DaemonOffline from "../components/DaemonOffline";
import { LoadingState } from "../components/EmptyState";
import { formatUptime, toEpochMs } from "../utils/format";
import { countRequiredSecrets } from "./SecretMatrix";
import "./Overview.css";

const POLL_INTERVAL_MS = 5_000;

type ListenerCounts = Record<IngestorState, number>;

/** Shown in this order; zero counts are dimmed, not hidden, so the row
 *  doesn't jump around. */
const LISTENER_STATES: { state: IngestorState; label: string; tone: string }[] = [
  { state: "connected", label: "connected", tone: "up" },
  { state: "reconnecting", label: "reconnecting", tone: "warn" },
  { state: "starting", label: "starting", tone: "warn" },
  { state: "error", label: "error", tone: "down" },
  { state: "stopped", label: "stopped", tone: "stopped" },
];

function countListeners(ingestors: readonly AdminIngestor[]): ListenerCounts {
  const counts: ListenerCounts = {
    connected: 0,
    starting: 0,
    reconnecting: 0,
    error: 0,
    stopped: 0,
  };
  for (const i of ingestors) counts[i.state] = (counts[i.state] ?? 0) + 1;
  return counts;
}

interface OverviewData {
  health: AdminHealth | null;
  /** From the listener list, which tells "reconnecting" apart from
   *  "starting" (health's counts merge the two). */
  listeners: ListenerCounts | null;
  secrets: { total: number; present: number } | null;
}

type Errors = Partial<Record<keyof OverviewData, string>>;

export default function Overview() {
  const { daemon, meta } = useDaemon();
  const now = useNow();
  // Each part keeps its last good value when a later poll of it fails.
  const [data, setData] = useState<OverviewData>({
    health: null,
    listeners: null,
    secrets: null,
  });
  const [errors, setErrors] = useState<Errors>({});

  // Tunnel toggle state. `tunnelOptimistic` lets the toggle reflect the new
  // value immediately after a successful PUT instead of waiting for the next
  // daemon poll. Cleared whenever fresh meta changes the value.
  const [tunnelSaving, setTunnelSaving] = useState(false);
  const [tunnelError, setTunnelError] = useState<string | null>(null);
  const [tunnelOptimistic, setTunnelOptimistic] = useState<boolean | null>(null);
  useEffect(() => {
    setTunnelOptimistic(null);
  }, [meta?.tunnelEnabled]);

  usePolling(
    async (ctx) => {
      const [healthRes, ingestorsRes, secretsRes] = await Promise.all([
        api.health(),
        api.ingestors(),
        api.secrets(),
      ]);
      if (!ctx.active()) return;
      const next: Errors = {};
      const patch: Partial<OverviewData> = {};
      if (isDaemonDown(healthRes)) next.health = healthRes.error;
      else patch.health = healthRes;
      if (isDaemonDown(ingestorsRes)) next.listeners = ingestorsRes.error;
      else patch.listeners = countListeners(ingestorsRes);
      if (isDaemonDown(secretsRes)) next.secrets = secretsRes.error;
      else patch.secrets = countRequiredSecrets(secretsRes);
      setData((prev) => ({ ...prev, ...patch }));
      setErrors(next);
    },
    POLL_INTERVAL_MS,
    { enabled: daemon === "up" },
  );

  const header = (
    <header className="page-header">
      <div>
        <h1 className="page-title">Overview</h1>
        {meta?.configPath && <div className="page-subtitle mono">{meta.configPath}</div>}
      </div>
    </header>
  );

  if (daemon === "unknown") {
    return (
      <>
        {header}
        <LoadingState label="Connecting to the daemon…" />
      </>
    );
  }

  if (daemon === "down") {
    return (
      <>
        {header}
        <DaemonOffline action="see its status" />
      </>
    );
  }

  const { health, listeners, secrets } = data;

  // Uptime ticks from the start time rather than jumping every poll.
  const startedMs = toEpochMs(meta?.startedAt);
  const uptimeSec = Number.isFinite(startedMs)
    ? (now - startedMs) / 1000
    : (health?.uptimeSec ?? NaN);

  // Fallback when the listener list failed but health loaded: its counts
  // merge reconnecting into starting, so say so.
  const healthCounts = health?.ingestorCounts;
  const listenerTotal = listeners
    ? Object.values(listeners).reduce((a, b) => a + b, 0)
    : healthCounts
      ? healthCounts.connected + healthCounts.error + healthCounts.starting + healthCounts.stopped
      : null;

  const tunnelEnabled = tunnelOptimistic ?? meta?.tunnelEnabled ?? false;
  const tunnelUrl = meta?.tunnelUrl ?? null;
  // Intent and runtime disagree until the daemon restarts.
  const tunnelNeedsRestart = !!meta && tunnelEnabled !== (tunnelUrl !== null);

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
    // Trust what the daemon says it saved, not what was asked for.
    if (res.data?.tunnel !== next) {
      setTunnelError("The daemon didn't save the tunnel setting. Try again.");
      return;
    }
    setTunnelOptimistic(next);
  };

  const missingSecrets = secrets ? secrets.total - secrets.present : 0;

  return (
    <>
      {header}

      <section className="dl-ov-grid">
        <div className="card">
          <span className="card-label">Status</span>
          <span className="card-value dl-ov-running">
            <span className="status-dot up" aria-hidden="true" />
            Running
          </span>
          <span className="card-sub">pid {meta?.pid ?? "—"}</span>
        </div>

        <div className="card">
          <span className="card-label">Port</span>
          <span className="card-value card-value-mono">{meta?.port ?? "—"}</span>
          <span className="card-sub">Loopback only</span>
        </div>

        <div className="card">
          <span className="card-label">Uptime</span>
          <span className="card-value">{formatUptime(uptimeSec)}</span>
          {meta?.startedAt && (
            <span className="card-sub">since {new Date(meta.startedAt).toLocaleString()}</span>
          )}
          <CardError message={!meta ? errors.health : undefined} />
        </div>

        <div className="card">
          <span className="card-label">Version</span>
          <span className="card-value card-value-mono">{meta?.version ?? "—"}</span>
        </div>

        <div className="card dl-ov-span-2 dl-tunnel-card">
          <div className="dl-tunnel-head">
            <span className="card-label" id="dl-tunnel-label">
              Tunnel
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={tunnelEnabled}
              aria-labelledby="dl-tunnel-label"
              className={`dl-tunnel-switch dl-tap-compact ${tunnelEnabled ? "is-on" : ""}`}
              disabled={tunnelSaving || !meta}
              onClick={() => void handleToggleTunnel()}
            >
              <span className="dl-tunnel-switch-knob" />
              {tunnelSaving && <Loader2 size={12} className="spinner dl-tunnel-switch-spin" />}
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
            <div className="modal-error dl-tunnel-error" role="alert">
              <AlertTriangle size={12} aria-hidden="true" /> {tunnelError}
            </div>
          )}
        </div>

        <Link to="/sessions" className="card dl-ov-link-card">
          <span className="card-label">Active sessions</span>
          <span className="card-value">{health?.activeSessions ?? "—"}</span>
          <span className="card-sub dl-ov-more">
            View sessions <ArrowRight size={12} aria-hidden="true" />
          </span>
          <CardError message={errors.health} />
        </Link>

        <Link to="/secrets" className="card dl-ov-link-card">
          <span className="card-label">Secrets</span>
          <span className="card-value">
            {!secrets ? "—" : secrets.total === 0 ? "None" : `${secrets.present} of ${secrets.total}`}
          </span>
          <span className="card-sub">
            {secrets && secrets.total === 0
              ? "No required secrets declared"
              : "Required secrets configured"}
          </span>
          {missingSecrets > 0 && (
            <span className="card-sub dl-ov-warn">{missingSecrets} missing</span>
          )}
          <CardError message={errors.secrets} />
        </Link>

        {tunnelNeedsRestart && (
          <div className="banner banner-warn dl-ov-span-all dl-tunnel-restart-banner" role="status">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>
              Restart Drawlatch to apply tunnel changes: run{" "}
              <code className="mono">drawlatch restart</code>, or restart callboard if it manages
              the daemon.
            </span>
          </div>
        )}

        {/* One link for the whole card, like Sessions and Secrets: the counts
            inside are text, not seven links to the same page. */}
        <Link to="/ingestors" className="card dl-ov-span-all dl-ov-link-card">
          <div className="dl-ov-card-head">
            <span className="card-label">
              Listeners{listenerTotal !== null ? ` (${listenerTotal})` : ""}
            </span>
            <span className="card-sub dl-ov-more">
              View listeners <ArrowRight size={12} aria-hidden="true" />
            </span>
          </div>
          <div className="dl-ov-stats">
            {listeners
              ? LISTENER_STATES.map(({ state, label, tone }) => (
                  <ListenerStat key={state} count={listeners[state]} label={label} tone={tone} />
                ))
              : healthCounts && (
                  <>
                    <ListenerStat count={healthCounts.connected} label="connected" tone="up" />
                    <ListenerStat
                      count={healthCounts.starting}
                      label="starting or reconnecting"
                      tone="warn"
                    />
                    <ListenerStat count={healthCounts.error} label="error" tone="down" />
                    <ListenerStat count={healthCounts.stopped} label="stopped" tone="stopped" />
                  </>
                )}
            {!listeners && !healthCounts && <span className="card-value">—</span>}
          </div>
          <CardError message={listeners ? undefined : errors.listeners} />
        </Link>
      </section>
    </>
  );
}

function ListenerStat({ count, label, tone }: { count: number; label: string; tone: string }) {
  return (
    <span className={`dl-ov-stat ${count === 0 ? "is-zero" : ""}`}>
      <span className={`status-dot ${tone}`} aria-hidden="true" />
      <span className="dl-ov-stat-count">{count}</span>
      <span>{label}</span>
    </span>
  );
}

/** "Couldn't load …" under a card's value, instead of a silent "—". */
function CardError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <span className="card-sub dl-ov-error" role="status">
      <AlertTriangle size={12} aria-hidden="true" /> Couldn't load: {message}
    </span>
  );
}
