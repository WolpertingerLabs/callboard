import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ExternalLink,
  Globe,
  Loader2,
  Play,
  Radio,
  RotateCw,
  Search,
  Square,
  Users,
  Wifi,
} from "lucide-react";
import type {
  AdminCaller,
  AdminConnectionStatus,
  AdminIngestor,
  IngestorState,
} from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import StabilityBadge from "../components/StabilityBadge";
import ConfigureConnectionModal from "../components/ConfigureConnectionModal";
import ListenerConfigPanel from "../components/ListenerConfigPanel";
import {
  TestResultView,
  toOutcome,
  type TestOutcome,
} from "../components/TestResult";
import { GoogleBadges } from "../components/AuthSummary";
import "./ConnectionsPage.css";

const INGESTOR_POLL_MS = 5_000;

const CATEGORY_LABELS: Record<string, string> = {
  ai: "AI",
  "developer-tools": "Developer Tools",
  gaming: "Gaming",
  messaging: "Messaging",
  productivity: "Productivity",
  "social-media": "Social Media",
  "web-search": "Web Search & Fetch",
};
const CATEGORY_ORDER = [
  "ai",
  "developer-tools",
  "gaming",
  "messaging",
  "productivity",
  "social-media",
  "web-search",
  "other",
];

type StabilityFilter = "stable" | "beta" | "dev";

/** State-dot color class suffix for an ingestor state. */
function stateClass(state: IngestorState): string {
  switch (state) {
    case "connected":
      return "connected";
    case "starting":
    case "reconnecting":
      return "warn";
    case "error":
      return "error";
    case "stopped":
    default:
      return "stopped";
  }
}

/** Cumulative set of stabilities visible at a given filter level. */
function stabilitiesFor(filter: StabilityFilter): Set<string> {
  if (filter === "stable") return new Set(["stable"]);
  if (filter === "beta") return new Set(["stable", "beta"]);
  return new Set(["stable", "beta", "dev"]);
}

/** Group ingestors by connection alias (collecting multi-instance entries). */
function groupIngestors(
  ingestors: AdminIngestor[],
): Map<string, AdminIngestor[]> {
  const map = new Map<string, AdminIngestor[]>();
  for (const ing of ingestors) {
    const list = map.get(ing.connection);
    if (list) list.push(ing);
    else map.set(ing.connection, [ing]);
  }
  return map;
}

export default function ConnectionsPage() {
  const { daemon } = useDaemon();

  const [callers, setCallers] = useState<AdminCaller[]>([]);
  const [selectedCaller, setSelectedCaller] = useState("default");
  const [connections, setConnections] = useState<AdminConnectionStatus[]>([]);
  const [ingestors, setIngestors] = useState<AdminIngestor[]>([]);
  const [loading, setLoading] = useState(true);

  const [searchQuery, setSearchQuery] = useState("");
  const [stabilityFilter, setStabilityFilter] =
    useState<StabilityFilter>("stable");

  const [togglingAlias, setTogglingAlias] = useState<string | null>(null);
  const [configuring, setConfiguring] =
    useState<AdminConnectionStatus | null>(null);
  const [listenerFor, setListenerFor] =
    useState<AdminConnectionStatus | null>(null);

  // Caller dropdown UI. Mutation (create/delete) lives on /callers.
  const [showCallerMenu, setShowCallerMenu] = useState(false);

  const selectedCallerRef = useRef(selectedCaller);
  selectedCallerRef.current = selectedCaller;

  // ── Fetch primary data (callers + connection-status) ────────────────────
  const refetch = useCallback(
    async (caller: string) => {
      const [callersRes, statusRes] = await Promise.all([
        api.callers(),
        api.connectionStatus(caller),
      ]);
      if (selectedCallerRef.current !== caller) return;
      if (!isDaemonDown(callersRes)) setCallers(callersRes);
      if (!isDaemonDown(statusRes)) setConnections(statusRes);
      setLoading(false);
    },
    [],
  );

  const fetchIngestors = useCallback(async (caller: string) => {
    const res = await api.callerIngestors(caller);
    if (selectedCallerRef.current !== caller) return;
    if (!isDaemonDown(res)) setIngestors(res);
  }, []);

  // ── Load on mount + whenever caller changes ─────────────────────────────
  useEffect(() => {
    if (daemon !== "up") return;
    const caller = selectedCaller;
    setLoading(true);
    setConnections([]);
    setIngestors([]);
    void refetch(caller);
    void fetchIngestors(caller);
  }, [daemon, selectedCaller, refetch, fetchIngestors]);

  // ── Poll ingestor statuses every ~5s ────────────────────────────────────
  useEffect(() => {
    if (daemon !== "up") return;
    const caller = selectedCaller;
    let interval: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (interval !== null) return;
      interval = setInterval(() => void fetchIngestors(caller), INGESTOR_POLL_MS);
    };
    const stop = () => {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
    };

    if (document.visibilityState === "visible") start();
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void fetchIngestors(caller);
        start();
      } else {
        stop();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [daemon, selectedCaller, fetchIngestors]);

  // ── Caller actions ──────────────────────────────────────────────────────
  const handleSelectCaller = (alias: string) => {
    setShowCallerMenu(false);
    if (alias !== selectedCaller) setSelectedCaller(alias);
  };

  // If the selected caller is deleted on the /callers page, fall back to default.
  useEffect(() => {
    if (callers.length === 0) return;
    if (!callers.some((c) => c.alias === selectedCaller)) {
      setSelectedCaller("default");
    }
  }, [callers, selectedCaller]);

  // ── Toggle (optimistic) ─────────────────────────────────────────────────
  const handleToggle = async (alias: string, enabled: boolean) => {
    setTogglingAlias(alias);
    setConnections((prev) =>
      prev.map((c) => (c.alias === alias ? { ...c, enabled } : c)),
    );
    const res = await api.setConnectionEnabled(
      selectedCallerRef.current,
      alias,
      enabled,
    );
    if (!res.ok) {
      // Revert on failure.
      setConnections((prev) =>
        prev.map((c) => (c.alias === alias ? { ...c, enabled: !enabled } : c)),
      );
      setTogglingAlias(null);
      return;
    }
    setTogglingAlias(null);
    void refetch(selectedCallerRef.current);
  };

  const triggerRefetch = useCallback(() => {
    void refetch(selectedCallerRef.current);
    void fetchIngestors(selectedCallerRef.current);
  }, [refetch, fetchIngestors]);

  // ── Derived: filter, sort, group ────────────────────────────────────────
  const ingestorsByConn = useMemo(
    () => groupIngestors(ingestors),
    [ingestors],
  );

  const grouped = useMemo(() => {
    const allow = stabilitiesFor(stabilityFilter);
    const q = searchQuery.trim().toLowerCase();

    const filtered = connections.filter((c) => {
      const stabilityOk = c.enabled || allow.has(c.stability);
      if (!stabilityOk) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.alias.toLowerCase().includes(q) ||
        (c.description?.toLowerCase().includes(q) ?? false)
      );
    });

    const byCategory = new Map<string, AdminConnectionStatus[]>();
    for (const c of filtered) {
      const key =
        c.category && c.category in CATEGORY_LABELS ? c.category : "other";
      const list = byCategory.get(key);
      if (list) list.push(c);
      else byCategory.set(key, [c]);
    }

    const result: {
      key: string;
      label: string;
      connections: AdminConnectionStatus[];
    }[] = [];
    for (const key of CATEGORY_ORDER) {
      const list = byCategory.get(key);
      if (!list?.length) continue;
      list.sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      result.push({
        key,
        label: CATEGORY_LABELS[key] ?? "Other",
        connections: list,
      });
    }
    return result;
  }, [connections, searchQuery, stabilityFilter]);

  const totalShown = grouped.reduce((n, g) => n + g.connections.length, 0);

  // ── Daemon down ─────────────────────────────────────────────────────────
  if (daemon === "down") {
    return (
      <>
        <header className="page-header">
          <div>
            <h1 className="page-title">Connections</h1>
            <div className="page-subtitle">
              Manage per-caller connections, secrets and listeners
            </div>
          </div>
        </header>
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            Drawlatch daemon is not reachable. Start it with{" "}
            <code>drawlatch start</code> to manage connections.
          </span>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Connections</h1>
          <div className="page-subtitle">
            Manage per-caller connections, secrets and listeners
          </div>
        </div>
      </header>

      {/* Controls: caller selector + search + stability filter */}
      <div className="dl-conn-controls">
        {/* Caller selector */}
        <div className="dl-conn-caller">
          <button
            type="button"
            className="dl-conn-caller-btn"
            onClick={() => setShowCallerMenu((v) => !v)}
          >
            <Users size={14} className="dl-conn-muted-icon" />
            <span className="dl-conn-caller-name">{selectedCaller}</span>
            <ChevronDown size={14} className="dl-conn-muted-icon" />
          </button>

          {showCallerMenu && (
            <>
              <div
                className="dl-conn-overlay"
                onClick={() => setShowCallerMenu(false)}
              />
              <div className="dl-conn-caller-menu">
                {callers.map((caller) => (
                  <div
                    key={caller.alias}
                    className={`dl-conn-caller-item ${
                      caller.alias === selectedCaller
                        ? "dl-conn-caller-item-active"
                        : ""
                    }`}
                    onClick={() => handleSelectCaller(caller.alias)}
                  >
                    <div className="dl-conn-caller-item-main">
                      {caller.alias === selectedCaller && (
                        <Check size={12} className="dl-conn-check" />
                      )}
                      <div className="dl-conn-caller-item-text">
                        <div className="dl-conn-caller-item-alias">
                          {caller.alias}
                        </div>
                        <div className="dl-conn-caller-item-count">
                          {caller.connections.length} connection
                          {caller.connections.length === 1 ? "" : "s"}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                <div className="dl-conn-caller-divider" />

                <Link
                  to="/callers"
                  className="dl-conn-caller-manage"
                  onClick={() => setShowCallerMenu(false)}
                >
                  <span>Manage callers</span>
                  <ArrowRight size={12} />
                </Link>
              </div>
            </>
          )}
        </div>

        {/* Search */}
        <div className="dl-conn-search">
          <Search size={16} className="dl-conn-search-icon" />
          <input
            type="text"
            placeholder="Search connections…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Stability filter */}
        <div className="dl-conn-stability">
          {(
            [
              { key: "stable", label: "Stable" },
              { key: "beta", label: "+ Beta" },
              { key: "dev", label: "All (dev)" },
            ] as const
          ).map(({ key, label }) => (
            <button
              key={key}
              type="button"
              className={`dl-conn-stability-btn ${
                stabilityFilter === key ? "dl-conn-stability-active" : ""
              }`}
              onClick={() => setStabilityFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Body */}
      {loading ? (
        <div className="banner banner-loading">Loading connections…</div>
      ) : totalShown === 0 ? (
        <div className="placeholder">
          <span className="placeholder-title">
            {searchQuery
              ? `No connections match "${searchQuery}"`
              : "No connections to show"}
          </span>
          {stabilityFilter !== "dev" && (
            <span>
              Try{" "}
              <button
                type="button"
                className="dl-conn-link-btn dl-tap-compact"
                onClick={() => setStabilityFilter("dev")}
              >
                All (dev)
              </button>{" "}
              to see more connections.
            </span>
          )}
        </div>
      ) : (
        grouped.map((group) => (
          <section key={group.key} className="dl-conn-group">
            <h2 className="dl-conn-group-title">{group.label}</h2>
            <div className="dl-conn-grid">
              {group.connections.map((c) => (
                <ConnectionCard
                  key={c.alias}
                  caller={selectedCaller}
                  connection={c}
                  toggling={togglingAlias === c.alias}
                  ingestors={ingestorsByConn.get(c.alias) ?? []}
                  onToggle={(enabled) => void handleToggle(c.alias, enabled)}
                  onConfigure={() => setConfiguring(c)}
                  onOpenListener={() => setListenerFor(c)}
                  onChanged={triggerRefetch}
                />
              ))}
            </div>
          </section>
        ))
      )}

      {configuring && (
        <ConfigureConnectionModal
          caller={selectedCaller}
          connection={configuring}
          onClose={() => setConfiguring(null)}
          // The modal closes itself (google stays open to offer a test).
          onSaved={triggerRefetch}
        />
      )}

      {listenerFor && (
        <ListenerConfigPanel
          caller={selectedCaller}
          connection={listenerFor.alias}
          connectionName={listenerFor.name}
          supportsMultiInstance={listenerFor.supportsMultiInstance}
          onClose={() => setListenerFor(null)}
          onChanged={triggerRefetch}
        />
      )}
    </>
  );
}

// ── Connection card ─────────────────────────────────────────────────────

function ConnectionCard({
  caller,
  connection,
  toggling,
  ingestors,
  onToggle,
  onConfigure,
  onOpenListener,
  onChanged,
}: {
  caller: string;
  connection: AdminConnectionStatus;
  toggling: boolean;
  ingestors: AdminIngestor[];
  onToggle: (enabled: boolean) => void;
  onConfigure: () => void;
  onOpenListener: () => void;
  onChanged: () => void;
}) {
  const c = connection;
  const [testing, setTesting] = useState<"connection" | "ingestor" | null>(
    null,
  );
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);
  const [controlAction, setControlAction] = useState<
    "start" | "stop" | "restart" | null
  >(null);

  // ── Secret status ──
  const requiredTotal = c.requiredSecrets.length;
  const requiredSet = c.requiredSecrets.filter(
    (s) => c.requiredSecretsSet[s],
  ).length;
  let secretText: string;
  let secretClass: string;
  if (requiredTotal === 0) {
    secretText = "No secrets needed";
    secretClass = "dl-conn-secret-none";
  } else if (requiredSet === requiredTotal) {
    secretText = "Ready";
    secretClass = "dl-conn-secret-ready";
  } else if (requiredSet > 0) {
    secretText = `${requiredSet}/${requiredTotal} secrets`;
    secretClass = "dl-conn-secret-partial";
  } else {
    secretText = `${requiredTotal} secret${requiredTotal === 1 ? "" : "s"} needed`;
    secretClass = "dl-conn-secret-missing";
  }

  // ── Ingestor live state ──
  const primary = ingestors[0];
  const total = ingestors.length;
  const connectedCount = ingestors.filter(
    (i) => i.state === "connected",
  ).length;

  const handleTestConnection = async () => {
    setTesting("connection");
    setTestResult(null);
    // The verdict is the result's own `success`, not the HTTP status.
    setTestResult(toOutcome("Test", await api.testConnection(caller, c.alias)));
    setTesting(null);
  };

  const handleTestIngestor = async () => {
    setTesting("ingestor");
    setTestResult(null);
    setTestResult(
      toOutcome("Listener test", await api.testIngestor(caller, c.alias)),
    );
    setTesting(null);
  };

  const handleControl = async (action: "start" | "stop" | "restart") => {
    setControlAction(action);
    await api.controlListener(caller, c.alias, action);
    setControlAction(null);
    onChanged();
  };

  const running = primary?.state === "connected";

  return (
    <article className={`dl-conn-card ${c.enabled ? "" : "dl-conn-card-off"}`}>
      {/* Header: icon + name + toggle */}
      <div className="dl-conn-card-head">
        <div className="dl-conn-card-id">
          <span
            className={`dl-conn-icon ${c.enabled ? "dl-conn-icon-on" : ""}`}
          >
            <Wifi size={18} />
          </span>
          <div className="dl-conn-card-text">
            <h3 className="dl-conn-card-name">{c.name}</h3>
            {c.description && (
              <p className="dl-conn-card-desc">{c.description}</p>
            )}
          </div>
        </div>
        <button
          type="button"
          className={`dl-conn-toggle dl-tap-compact ${c.enabled ? "dl-conn-toggle-on" : ""}`}
          disabled={toggling}
          onClick={() => onToggle(!c.enabled)}
          title={c.enabled ? "Disable connection" : "Enable connection"}
          aria-pressed={c.enabled}
        >
          <span className="dl-conn-toggle-knob" />
        </button>
      </div>

      {/* Badges */}
      <div className="dl-conn-badges">
        <StabilityBadge stability={c.stability} />

        {c.composed === "google" ? (
          // The composed connection has no fixed allowlist: it is the
          // caller's selection. Show that instead.
          c.enabled && <GoogleBadges callerAuth={c.callerAuth} />
        ) : (
          <span className="dl-conn-badge mono">
            <Globe size={10} />
            {c.allowedEndpoints.length} endpoint
            {c.allowedEndpoints.length === 1 ? "" : "s"}
          </span>
        )}

        {c.hasIngestor && c.ingestorType && (
          <span className="dl-conn-badge dl-conn-badge-ingestor">
            <Radio size={10} />
            {c.ingestorType}
            {primary && (
              <span
                className={`status-dot dl-conn-dot dl-conn-dot-${stateClass(primary.state)}`}
                title={`Listener: ${primary.state}`}
                aria-hidden="true"
              />
            )}
            {total > 1 && (
              <span className="dl-conn-dot-count">
                {connectedCount}/{total}
              </span>
            )}
          </span>
        )}

        <span className={`dl-conn-badge dl-conn-secret ${secretClass}`}>
          {requiredTotal > 0 && requiredSet === requiredTotal ? (
            <Check size={10} />
          ) : requiredTotal > 0 ? (
            <AlertTriangle size={10} />
          ) : null}
          {secretText}
        </span>

        {c.docsUrl && (
          <a
            className="dl-conn-docs"
            href={c.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={10} />
            Docs
          </a>
        )}
      </div>

      {c.enabled && c.problem && (
        <div className="dl-conn-problem" role="status">
          <AlertTriangle size={12} />
          <span>not loaded: {c.problem}</span>
        </div>
      )}

      {/* Primary actions */}
      <div className="dl-conn-actions">
        <button
          type="button"
          className="dl-conn-btn dl-conn-btn-primary"
          onClick={onConfigure}
        >
          Configure
        </button>
        <button
          type="button"
          className="dl-conn-btn"
          disabled={testing !== null}
          onClick={() => void handleTestConnection()}
          title="Test API credentials"
        >
          {testing === "connection" ? (
            <Loader2 size={12} className="dl-conn-spin" />
          ) : (
            <Wifi size={12} />
          )}
          Test
        </button>
        {c.hasIngestor && (
          <button
            type="button"
            className="dl-conn-btn"
            disabled={testing !== null}
            onClick={() => void handleTestIngestor()}
            title="Test event listener"
          >
            {testing === "ingestor" ? (
              <Loader2 size={12} className="dl-conn-spin" />
            ) : (
              <Radio size={12} />
            )}
            Test Listener
          </button>
        )}
      </div>

      {/* Listener controls */}
      {c.hasIngestor && (
        <div className="dl-conn-listener-row">
          <button
            type="button"
            className={`dl-conn-mini ${running ? "dl-conn-mini-stop" : "dl-conn-mini-start"}`}
            disabled={controlAction !== null}
            onClick={() => void handleControl(running ? "stop" : "start")}
            title={running ? "Stop listener" : "Start listener"}
          >
            {controlAction === "start" || controlAction === "stop" ? (
              <Loader2 size={10} className="dl-conn-spin" />
            ) : running ? (
              <Square size={10} />
            ) : (
              <Play size={10} />
            )}
            {running ? "Stop" : "Start"}
          </button>
          <button
            type="button"
            className="dl-conn-mini"
            disabled={controlAction !== null}
            onClick={() => void handleControl("restart")}
            title="Restart listener"
          >
            {controlAction === "restart" ? (
              <Loader2 size={10} className="dl-conn-spin" />
            ) : (
              <RotateCw size={10} />
            )}
            Restart
          </button>
          <div className="dl-conn-spacer" />
          <button
            type="button"
            className="dl-conn-mini dl-conn-mini-accent"
            onClick={onOpenListener}
            title="Configure listener"
          >
            <Radio size={10} />
            Listener
          </button>
        </div>
      )}

      {/* Transient test result */}
      {testResult && (
        <TestResultView result={testResult} onDismiss={() => setTestResult(null)} />
      )}
    </article>
  );
}
