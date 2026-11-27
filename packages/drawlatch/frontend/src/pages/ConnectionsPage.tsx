import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  Play,
  Radio,
  RotateCw,
  Search,
  SlidersHorizontal,
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
import { api, isDaemonDown, isUnreachable } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import StabilityBadge from "../components/StabilityBadge";
import ConfigureConnectionModal from "../components/ConfigureConnectionModal";
import ListenerConfigPanel from "../components/ListenerConfigPanel";
import DaemonOffline from "../components/DaemonOffline";
import EmptyState, { LoadingState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { TestResultView, toOutcome, type TestOutcome } from "../components/TestResult";
import { GoogleBadges } from "../components/AuthSummary";
import { toolResult } from "../utils/toolResult";
import "./ConnectionsPage.css";

const INGESTOR_POLL_MS = 5_000;

const CATEGORY_LABELS: Record<string, string> = {
  ai: "AI",
  "developer-tools": "Developer tools",
  gaming: "Gaming",
  messaging: "Messaging",
  productivity: "Productivity",
  "social-media": "Social media",
  "web-search": "Web search and fetch",
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

const STABILITY_OPTIONS: { key: StabilityFilter; label: string }[] = [
  { key: "stable", label: "Stable" },
  { key: "beta", label: "+ Beta" },
  { key: "dev", label: "All (dev)" },
];

const STATE_LABELS: Record<IngestorState, string> = {
  connected: "Connected",
  starting: "Starting",
  reconnecting: "Reconnecting",
  stopped: "Stopped",
  error: "Error",
};

/** State-dot colour for an ingestor state (index.css `.status-dot.*`). */
function dotClass(state: IngestorState): string {
  switch (state) {
    case "connected":
      return "up";
    case "starting":
    case "reconnecting":
      return "warn";
    case "error":
      return "down";
    case "stopped":
    default:
      return "stopped";
  }
}

/** Is the listener running, or trying to? Then the card offers Stop;
 *  otherwise (stopped, error) it offers Start. */
function isListenerActive(state: IngestorState | undefined): boolean {
  return state === "connected" || state === "starting" || state === "reconnecting";
}

/** Cumulative set of stabilities visible at a given filter level. */
function stabilitiesFor(filter: StabilityFilter): Set<string> {
  if (filter === "stable") return new Set(["stable"]);
  if (filter === "beta") return new Set(["stable", "beta"]);
  return new Set(["stable", "beta", "dev"]);
}

function requiredCounts(c: AdminConnectionStatus): { set: number; total: number } {
  return {
    set: c.requiredSecrets.filter((s) => c.requiredSecretsSet[s]).length,
    total: c.requiredSecrets.length,
  };
}

/** Enabled, but a required secret is missing: it can't work yet. */
function needsSecrets(c: AdminConnectionStatus): boolean {
  const { set, total } = requiredCounts(c);
  return c.enabled && set < total;
}

/** Group ingestors by connection alias (collecting multi-instance entries). */
function groupIngestors(ingestors: AdminIngestor[]): Map<string, AdminIngestor[]> {
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
  const toast = useToast();

  const [callers, setCallers] = useState<AdminCaller[]>([]);
  const [selectedCaller, setSelectedCaller] = useState("default");
  const [connections, setConnections] = useState<AdminConnectionStatus[]>([]);
  const [ingestors, setIngestors] = useState<AdminIngestor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [stabilityFilter, setStabilityFilter] = useState<StabilityFilter>("stable");
  const [onlyNeedsSecrets, setOnlyNeedsSecrets] = useState(false);

  const [togglingAlias, setTogglingAlias] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<AdminConnectionStatus | null>(null);
  const [listenerFor, setListenerFor] = useState<AdminConnectionStatus | null>(null);

  const selectedCallerRef = useRef(selectedCaller);
  selectedCallerRef.current = selectedCaller;

  // ── Fetch primary data (callers + connection-status) ────────────────────
  const refetch = useCallback(async (caller: string) => {
    const [callersRes, statusRes] = await Promise.all([
      api.callers(),
      api.connectionStatus(caller),
    ]);
    if (selectedCallerRef.current !== caller) return;
    if (!isDaemonDown(callersRes)) setCallers(callersRes);
    if (isDaemonDown(statusRes)) {
      // Unreachable: the page switches to the offline banner by itself.
      // Anything else (a 404 for a caller deleted meanwhile, a 500) is shown,
      // never passed off as "no connections".
      if (!isUnreachable(statusRes)) setLoadError(statusRes.error);
    } else {
      setConnections(statusRes);
      setLoadError(null);
    }
    setLoading(false);
  }, []);

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
    setLoadError(null);
    setConnections([]);
    setIngestors([]);
    // A toggle still in flight belongs to the previous caller's list.
    setTogglingAlias(null);
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

  // If the selected caller is deleted on the /callers page, fall back to default.
  useEffect(() => {
    if (callers.length === 0) return;
    if (!callers.some((c) => c.alias === selectedCaller)) {
      setSelectedCaller("default");
    }
  }, [callers, selectedCaller]);

  // ── Toggle (optimistic) ─────────────────────────────────────────────────
  const handleToggle = async (c: AdminConnectionStatus, enabled: boolean) => {
    const alias = c.alias;
    // The request is for this caller; the user may pick another before it
    // settles, and then this caller's revert must not touch that list.
    const caller = selectedCallerRef.current;
    setTogglingAlias(alias);
    setConnections((prev) => prev.map((x) => (x.alias === alias ? { ...x, enabled } : x)));
    const res = toolResult(await api.setConnectionEnabled(caller, alias, enabled));
    const stillHere = selectedCallerRef.current === caller;
    if (stillHere) setTogglingAlias(null);
    if (!res.ok) {
      if (stillHere) {
        setConnections((prev) =>
          prev.map((x) => (x.alias === alias ? { ...x, enabled: !enabled } : x)),
        );
      }
      toast.show(
        `Couldn't ${enabled ? "enable" : "disable"} ${c.name} for ${caller}: ${res.error}`,
        { kind: "error" },
      );
      return;
    }
    toast.show(`${c.name} ${enabled ? "enabled" : "disabled"} for ${caller}`);
    if (stillHere) void refetch(caller);
  };

  const triggerRefetch = useCallback(() => {
    void refetch(selectedCallerRef.current);
    void fetchIngestors(selectedCallerRef.current);
  }, [refetch, fetchIngestors]);

  // ── Derived: filter, sort, group ────────────────────────────────────────
  const ingestorsByConn = useMemo(() => groupIngestors(ingestors), [ingestors]);

  const needsSecretsCount = useMemo(() => connections.filter(needsSecrets).length, [connections]);

  // Turn the filter off by itself once nothing needs secrets any more.
  useEffect(() => {
    if (onlyNeedsSecrets && needsSecretsCount === 0 && !loading) setOnlyNeedsSecrets(false);
  }, [onlyNeedsSecrets, needsSecretsCount, loading]);

  const { grouped, keptByEnabled } = useMemo(() => {
    const allow = stabilitiesFor(stabilityFilter);
    const q = searchQuery.trim().toLowerCase();
    let kept = 0;

    const filtered = connections.filter((c) => {
      if (onlyNeedsSecrets && !needsSecrets(c)) return false;
      // An enabled connection always shows, whatever the filter: hiding one
      // that is live for this caller would be misleading.
      if (!allow.has(c.stability)) {
        if (!c.enabled) return false;
      }
      const matches =
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.alias.toLowerCase().includes(q) ||
        (c.description?.toLowerCase().includes(q) ?? false);
      if (matches && !allow.has(c.stability)) kept++;
      return matches;
    });

    const byCategory = new Map<string, AdminConnectionStatus[]>();
    for (const c of filtered) {
      const key = c.category && c.category in CATEGORY_LABELS ? c.category : "other";
      const list = byCategory.get(key);
      if (list) list.push(c);
      else byCategory.set(key, [c]);
    }

    const result: { key: string; label: string; connections: AdminConnectionStatus[] }[] = [];
    for (const key of CATEGORY_ORDER) {
      const list = byCategory.get(key);
      if (!list?.length) continue;
      list.sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      result.push({ key, label: CATEGORY_LABELS[key] ?? "Other", connections: list });
    }
    return { grouped: result, keptByEnabled: kept };
  }, [connections, searchQuery, stabilityFilter, onlyNeedsSecrets]);

  const totalShown = grouped.reduce((n, g) => n + g.connections.length, 0);

  const header = (
    <header className="page-header">
      <div>
        <h1 className="page-title">Connections</h1>
        <div className="page-subtitle">Manage per-caller connections, secrets and listeners</div>
      </div>
    </header>
  );

  // ── Daemon down ─────────────────────────────────────────────────────────
  if (daemon === "down") {
    return (
      <>
        {header}
        <DaemonOffline action="manage connections" />
      </>
    );
  }

  const clearFilters = () => {
    setSearchQuery("");
    setOnlyNeedsSecrets(false);
  };

  return (
    <>
      {header}

      {/* Controls: caller selector + search + filters */}
      <div className="dl-conn-controls">
        <CallerPicker
          callers={callers}
          selected={selectedCaller}
          onSelect={(alias) => {
            if (alias !== selectedCaller) setSelectedCaller(alias);
          }}
        />

        <div className="dl-conn-search">
          <Search size={16} className="dl-conn-search-icon" aria-hidden="true" />
          <input
            type="search"
            className="input dl-conn-search-input"
            aria-label="Search connections"
            placeholder="Search connections…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <div className="dl-conn-filters">
          {needsSecretsCount > 0 && (
            <button
              type="button"
              className={`dl-conn-needs-btn${onlyNeedsSecrets ? " is-on" : ""}`}
              aria-pressed={onlyNeedsSecrets}
              onClick={() => setOnlyNeedsSecrets((v) => !v)}
              title="Show only enabled connections that are missing a required secret"
            >
              <KeyRound size={13} aria-hidden="true" />
              Needs secrets
              <span className="dl-conn-needs-count">{needsSecretsCount}</span>
            </button>
          )}
          <div className="dl-conn-stability" role="group" aria-label="Stability">
            {STABILITY_OPTIONS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                className={`dl-conn-stability-btn${stabilityFilter === key ? " is-active" : ""}`}
                aria-pressed={stabilityFilter === key}
                onClick={() => setStabilityFilter(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {keptByEnabled > 0 && !loading && (
        <p className="dl-conn-filter-note">
          {keptByEnabled === 1
            ? "Also showing 1 enabled connection outside this filter: enabled connections always show."
            : `Also showing ${keptByEnabled} enabled connections outside this filter: enabled connections always show.`}
        </p>
      )}

      {/* Body */}
      {loading ? (
        <LoadingState label="Loading connections…" />
      ) : loadError ? (
        <div className="modal-error dl-conn-load-error" role="alert">
          <span>
            Couldn&apos;t load connections for <strong>{selectedCaller}</strong>: {loadError}
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setLoading(true);
              void refetch(selectedCaller);
            }}
          >
            <RotateCw size={13} aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : totalShown === 0 ? (
        <EmptyState
          icon={<Search size={20} />}
          title={
            searchQuery
              ? `No connections match "${searchQuery}"`
              : onlyNeedsSecrets
                ? "Nothing needs secrets"
                : "No connections to show"
          }
          body={
            stabilityFilter !== "dev"
              ? "Some connections are hidden by the stability filter."
              : undefined
          }
          action={
            <>
              {(searchQuery || onlyNeedsSecrets) && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={clearFilters}>
                  Clear search
                </button>
              )}
              {stabilityFilter !== "dev" && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setStabilityFilter("dev")}
                >
                  Show all (dev)
                </button>
              )}
            </>
          }
        />
      ) : (
        grouped.map((group) => (
          <section
            key={group.key}
            className="dl-conn-group"
            aria-labelledby={`dl-conn-g-${group.key}`}
          >
            <h2 className="dl-conn-group-title" id={`dl-conn-g-${group.key}`}>
              {group.label}
            </h2>
            <div className="dl-conn-grid">
              {group.connections.map((c) => (
                <ConnectionCard
                  key={c.alias}
                  caller={selectedCaller}
                  connection={c}
                  toggling={togglingAlias === c.alias}
                  ingestors={ingestorsByConn.get(c.alias) ?? []}
                  onToggle={(enabled) => void handleToggle(c, enabled)}
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

// ── Caller picker ────────────────────────────────────────────────────────

/**
 * A button that opens a listbox of callers. Keyboard: Enter/Space/↓ open it
 * with focus on the current caller, ↑/↓/Home/End move, Enter picks, Escape
 * or Tab closes. Focus goes back to the button on close.
 */
function CallerPicker({
  callers,
  selected,
  onSelect,
}: {
  callers: AdminCaller[];
  selected: string;
  onSelect: (alias: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const items = (): HTMLElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[data-picker-item]") ?? []);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Focus the current caller when the menu opens.
  useEffect(() => {
    if (!open) return;
    const list = items();
    const current = list.find((el) => el.getAttribute("aria-selected") === "true") ?? list[0];
    current?.focus();
  }, [open]);

  // Click outside or Escape anywhere closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      close(true);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = i < 0 ? 0 : Math.min(i + 1, list.length - 1);
    else if (e.key === "ArrowUp") next = i <= 0 ? 0 : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Tab") close(false);
    if (next !== null) {
      e.preventDefault();
      list[next]?.focus();
    }
  };

  const current = callers.find((c) => c.alias === selected);

  return (
    <div className="dl-conn-caller" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="dl-conn-caller-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Caller: ${selected}`}
        title={current?.name && current.name !== selected ? current.name : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Users size={14} className="dl-conn-muted-icon" aria-hidden="true" />
        <span className="dl-conn-caller-name">{selected}</span>
        <ChevronDown
          size={14}
          className="dl-conn-muted-icon dl-conn-caller-chevron"
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="dl-conn-caller-menu" ref={menuRef} onKeyDown={onMenuKey}>
          <div role="listbox" id={listId} aria-label="Callers">
            {callers.map((caller) => {
              const isCurrent = caller.alias === selected;
              const n = caller.connections.length;
              return (
                <button
                  key={caller.alias}
                  type="button"
                  role="option"
                  aria-selected={isCurrent}
                  data-picker-item
                  tabIndex={-1}
                  className={`dl-conn-caller-item${isCurrent ? " is-active" : ""}`}
                  title={caller.alias}
                  onClick={() => {
                    onSelect(caller.alias);
                    close(true);
                  }}
                >
                  <span className="dl-conn-check" aria-hidden="true">
                    {isCurrent && <Check size={13} />}
                  </span>
                  <span className="dl-conn-caller-item-text">
                    <span className="dl-conn-caller-item-alias">{caller.alias}</span>
                    <span className="dl-conn-caller-item-count">
                      {n} connection{n === 1 ? "" : "s"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="dl-conn-caller-divider" role="separator" />
          <Link
            to="/callers"
            className="dl-conn-caller-manage"
            data-picker-item
            tabIndex={-1}
            onClick={() => setOpen(false)}
          >
            <span>Manage callers</span>
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
        </div>
      )}
    </div>
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
  const toast = useToast();
  const [testing, setTesting] = useState<"connection" | "ingestor" | null>(null);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);
  const [controlAction, setControlAction] = useState<"start" | "stop" | "restart" | null>(null);
  const nameId = useId();

  // ── Secret status ──
  const { set: requiredSet, total: requiredTotal } = requiredCounts(c);
  let secretText: string;
  let secretTone: "muted" | "success" | "warning";
  if (requiredTotal === 0) {
    secretText = "No secrets needed";
    secretTone = "muted";
  } else if (requiredSet === requiredTotal) {
    secretText = "Ready";
    secretTone = "success";
  } else {
    secretText =
      requiredSet > 0
        ? `${requiredSet}/${requiredTotal} secrets`
        : `${requiredTotal} secret${requiredTotal === 1 ? "" : "s"} needed`;
    // Only urgent when the connection is on: a disabled one needs nothing yet.
    secretTone = c.enabled ? "warning" : "muted";
  }

  // ── Listener live state ──
  const primary = ingestors[0];
  const total = ingestors.length;
  const connectedCount = ingestors.filter((i) => i.state === "connected").length;
  const state: IngestorState = primary?.state ?? "stopped";
  const active =
    total > 1 ? ingestors.some((i) => isListenerActive(i.state)) : isListenerActive(state);

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
    setTestResult(toOutcome("Listener test", await api.testIngestor(caller, c.alias)));
    setTesting(null);
  };

  const handleControl = async (action: "start" | "stop" | "restart") => {
    setControlAction(action);
    // Tool failures come back as HTTP 200 with success: false.
    const res = toolResult(await api.controlListener(caller, c.alias, action));
    setControlAction(null);
    if (res.ok) {
      const done = action === "start" ? "started" : action === "stop" ? "stopped" : "restarted";
      toast.show(`${c.name} listener ${done}`);
    } else {
      toast.show(`Couldn't ${action} the ${c.name} listener: ${res.error}`, { kind: "error" });
    }
    onChanged();
  };

  const stateText = total > 1 ? `${connectedCount}/${total} connected` : STATE_LABELS[state];
  const stateDot = total > 1 && connectedCount === total ? "up" : dotClass(state);

  return (
    <article className={`dl-conn-card${c.enabled ? "" : " is-off"}`} aria-labelledby={nameId}>
      {/* Header: icon + name + docs + toggle */}
      <div className="dl-conn-card-head">
        <span className={`dl-conn-icon${c.enabled ? " is-on" : ""}`} aria-hidden="true">
          <Wifi size={18} />
        </span>
        <div className="dl-conn-card-text">
          <h3 className="dl-conn-card-name" id={nameId} title={c.name}>
            {c.name}
          </h3>
          {c.description && (
            <p className="dl-conn-card-desc" title={c.description}>
              {c.description}
            </p>
          )}
        </div>
        <div className="dl-conn-card-tools">
          {c.docsUrl && (
            <a
              className="btn btn-ghost btn-icon btn-sm dl-conn-docs"
              href={c.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${c.name} docs (opens in a new tab)`}
              title="API docs"
            >
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={c.enabled}
            aria-label={`Enable ${c.name}`}
            className={`dl-conn-toggle dl-tap-compact${c.enabled ? " is-on" : ""}`}
            disabled={toggling}
            aria-busy={toggling || undefined}
            onClick={() => onToggle(!c.enabled)}
            title={c.enabled ? "Disable connection" : "Enable connection"}
          >
            <span className="dl-conn-toggle-knob" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Badges */}
      <div className="dl-conn-badges">
        <StabilityBadge stability={c.stability} />

        {c.composed === "google" ? (
          // The composed connection has no fixed allowlist: it is the
          // caller's selection. Show that instead.
          c.enabled && <GoogleBadges callerAuth={c.callerAuth} />
        ) : (
          <span className="dl-conn-chip mono">
            <Globe size={11} aria-hidden="true" />
            {c.allowedEndpoints.length} endpoint{c.allowedEndpoints.length === 1 ? "" : "s"}
          </span>
        )}

        {c.hasIngestor && c.ingestorType && (
          <span className="dl-conn-chip is-info" title={primary?.error}>
            <Radio size={11} aria-hidden="true" />
            {c.ingestorType}
            <span className="dl-conn-chip-sep" aria-hidden="true">
              ·
            </span>
            <span className="sr-only">listener </span>
            <span className={`status-dot dl-conn-dot ${stateDot}`} aria-hidden="true" />
            <span className="dl-conn-chip-state">{stateText}</span>
          </span>
        )}

        <span className={`dl-conn-chip is-${secretTone}`}>
          {requiredTotal > 0 &&
            (requiredSet === requiredTotal ? (
              <Check size={11} aria-hidden="true" />
            ) : (
              <AlertTriangle size={11} aria-hidden="true" />
            ))}
          {secretText}
        </span>
      </div>

      {c.enabled && c.problem && (
        <div className="dl-conn-problem" role="status">
          <AlertTriangle size={12} aria-hidden="true" />
          <span>Not loaded: {c.problem}</span>
        </div>
      )}

      <div className="dl-conn-card-foot">
        {/* Primary actions */}
        <div className="dl-conn-actions">
          <button
            type="button"
            className="btn btn-secondary dl-conn-configure"
            onClick={onConfigure}
          >
            Configure
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={testing !== null}
            onClick={() => void handleTestConnection()}
            title="Test API credentials"
          >
            {testing === "connection" ? (
              <Loader2 size={13} className="spinner" aria-hidden="true" />
            ) : (
              <Wifi size={13} aria-hidden="true" />
            )}
            Test
          </button>
          {c.hasIngestor && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={testing !== null}
              onClick={() => void handleTestIngestor()}
              title="Test the event listener"
            >
              {testing === "ingestor" ? (
                <Loader2 size={13} className="spinner" aria-hidden="true" />
              ) : (
                <Radio size={13} aria-hidden="true" />
              )}
              Test listener
            </button>
          )}
        </div>

        {/* Listener controls */}
        {c.hasIngestor && (
          <div className="dl-conn-listener-row" role="group" aria-label={`${c.name} listener`}>
            <div className="dl-conn-listener-btns">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={controlAction !== null}
                onClick={() => void handleControl(active ? "stop" : "start")}
                aria-label={`${active ? "Stop" : "Start"} the ${c.name} listener`}
              >
                {controlAction === "start" || controlAction === "stop" ? (
                  <Loader2 size={12} className="spinner" aria-hidden="true" />
                ) : active ? (
                  <Square size={12} aria-hidden="true" />
                ) : (
                  <Play size={12} aria-hidden="true" />
                )}
                {active ? "Stop" : "Start"}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={controlAction !== null}
                onClick={() => void handleControl("restart")}
                aria-label={`Restart the ${c.name} listener`}
              >
                {controlAction === "restart" ? (
                  <Loader2 size={12} className="spinner" aria-hidden="true" />
                ) : (
                  <RotateCw size={12} aria-hidden="true" />
                )}
                Restart
              </button>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm dl-conn-listener-open"
              onClick={onOpenListener}
              aria-label={`Listener settings for ${c.name}`}
            >
              <SlidersHorizontal size={12} aria-hidden="true" />
              Listener
            </button>
          </div>
        )}
      </div>

      {/* Transient test result */}
      {testResult && <TestResultView result={testResult} onDismiss={() => setTestResult(null)} />}
    </article>
  );
}
