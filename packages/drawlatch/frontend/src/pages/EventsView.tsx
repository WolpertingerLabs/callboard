import { useEffect, useState } from "react";
import {
  RefreshCw,
  ChevronRight,
  ChevronDown,
  Radio,
} from "lucide-react";
import type {
  AdminCaller,
  AdminEvent,
  AdminIngestor,
  IngestorState,
} from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import "./EventsView.css";

const POLL_INTERVAL_MS = 5_000;
const PREVIEW_LEN = 120;

/** State-dot color class suffix for an ingestor state. */
function stateClass(state: IngestorState): string {
  switch (state) {
    case "connected":
      return "connected";
    case "starting":
    case "reconnecting":
      return "warn";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
    default:
      return "stopped";
  }
}

/** Relative "time ago" from an ISO string or epoch-ms number. */
function timeAgo(iso: string | number): string {
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const deltaMs = Date.now() - t;
  if (deltaMs < 0) return "just now";
  const s = Math.floor(deltaMs / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Short, single-line preview of an event's unknown `data` payload. */
function dataPreview(data: unknown): string {
  let text: string;
  if (typeof data === "string") {
    text = data;
  } else if (data === null || data === undefined) {
    text = String(data);
  } else if (typeof data === "number" || typeof data === "boolean") {
    text = String(data);
  } else {
    try {
      text = JSON.stringify(data);
    } catch {
      text = String(data);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > PREVIEW_LEN ? `${text.slice(0, PREVIEW_LEN)}…` : text;
}

/** Pretty-printed JSON for the expanded detail. */
function prettyData(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function pickDefaultCaller(callers: AdminCaller[]): string | null {
  if (callers.length === 0) return null;
  const hasDefault = callers.some((c) => c.alias === "default");
  return hasDefault ? "default" : callers[0].alias;
}

export default function EventsView() {
  const { daemon } = useDaemon();

  const [callers, setCallers] = useState<AdminCaller[]>([]);
  const [selectedCaller, setSelectedCaller] = useState<string | null>(null);
  const [callersLoaded, setCallersLoaded] = useState(false);

  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [ingestors, setIngestors] = useState<AdminIngestor[]>([]);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Merge a server-returned event batch with the existing UI list, deduping by
  // id. The backend buffer is bounded (default 100 events per ingestor), but
  // the UI accumulates beyond that so users can scroll back through their
  // session. Returns a stable identity when nothing new arrived so React
  // doesn't trigger a needless render.
  const mergeEvents = (
    prev: AdminEvent[],
    incoming: readonly AdminEvent[],
  ): AdminEvent[] => {
    if (incoming.length === 0) return prev;
    const seen = new Set(prev.map((e) => e.id));
    const novel = incoming.filter((e) => !seen.has(e.id));
    if (novel.length === 0) return prev;
    return [...novel.sort((a, b) => b.id - a.id), ...prev];
  };

  // ── Load caller list once the daemon is up ──────────────────────────────
  useEffect(() => {
    if (daemon !== "up") return;
    let cancelled = false;
    (async () => {
      const res = await api.callers();
      if (cancelled) return;
      if (isDaemonDown(res)) {
        setCallersLoaded(true);
        return;
      }
      setCallers(res);
      setSelectedCaller((prev) =>
        prev && res.some((c) => c.alias === prev)
          ? prev
          : pickDefaultCaller(res),
      );
      setCallersLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [daemon]);

  // ── Reset feed state whenever the selected caller changes ───────────────
  useEffect(() => {
    setEvents([]);
    setIngestors([]);
    setActiveSource(null);
    setExpandedId(null);
    setLoading(true);
  }, [selectedCaller]);

  // ── Poll events + ingestors for the selected caller ─────────────────────
  //
  // We pass `after_id=-1` to the events endpoint and rely on `mergeEvents` to
  // dedupe by id, rather than maintaining a client-side cursor. The cursor
  // approach was prone to silent drift — if any earlier poll's `setEvents`
  // dropped a state update (visibility toggles, React 18 strict-mode mount
  // cycles, etc.), the cursor advanced past events the UI had never received,
  // and the table appeared stuck even though the per-ingestor event counters
  // (driven by `/ingestors`) kept ticking up. With the no-cursor approach the
  // backend always returns its full buffer (bounded, default 100), so any
  // missed updates self-heal on the next poll.
  useEffect(() => {
    if (daemon !== "up" || !selectedCaller) return;
    const caller = selectedCaller;
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const fetchEvents = async () => {
      const res = await api.callerEvents(caller, -1);
      if (cancelled) return;
      if (isDaemonDown(res)) {
        setLoading(false);
        return;
      }
      setEvents((prev) => mergeEvents(prev, res));
      setLoading(false);
    };

    const fetchIngestors = async () => {
      const res = await api.callerIngestors(caller);
      if (cancelled) return;
      if (isDaemonDown(res)) return;
      setIngestors(res);
    };

    const poll = () => {
      void fetchEvents();
      void fetchIngestors();
    };

    const start = () => {
      if (interval !== null) return;
      interval = setInterval(poll, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
    };

    poll();
    if (document.visibilityState === "visible") start();

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        poll();
        start();
      } else {
        stop();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [daemon, selectedCaller]);

  // ── Tick "now" each second so relative times re-render ──────────────────
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval !== null) return;
      interval = setInterval(() => setNow(Date.now()), 1_000);
    };
    const stop = () => {
      if (interval === null) return;
      clearInterval(interval);
      interval = null;
    };
    if (document.visibilityState === "visible") start();
    const onVisibility = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const handleRefresh = async () => {
    if (!selectedCaller || daemon !== "up") return;
    const caller = selectedCaller;
    setRefreshing(true);
    try {
      const [evRes, ingRes] = await Promise.all([
        api.callerEvents(caller, -1),
        api.callerIngestors(caller),
      ]);
      if (selectedCaller !== caller) return;
      if (!isDaemonDown(evRes)) setEvents((prev) => mergeEvents(prev, evRes));
      if (!isDaemonDown(ingRes)) setIngestors(ingRes);
      setLoading(false);
    } finally {
      setRefreshing(false);
    }
  };

  // ── Derived: source counts + filtered events ────────────────────────────
  const sourceCounts = new Map<string, number>();
  for (const ev of events) {
    sourceCounts.set(ev.source, (sourceCounts.get(ev.source) ?? 0) + 1);
  }
  const sources = [...sourceCounts.keys()].sort((a, b) => a.localeCompare(b));
  const filteredEvents = activeSource
    ? events.filter((e) => e.source === activeSource)
    : events;

  // ── Daemon down ─────────────────────────────────────────────────────────
  if (daemon === "down") {
    return (
      <>
        <header className="page-header">
          <div>
            <h1 className="page-title">Logs</h1>
            <div className="page-subtitle">Live event feed from caller ingestors</div>
          </div>
        </header>
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            Drawlatch daemon is not reachable. Start it with{" "}
            <code>drawlatch start</code> to load events.
          </span>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Logs</h1>
          <div className="page-subtitle">
            Live event feed from caller ingestors — polled every 5s
          </div>
        </div>
        <div className="dl-events-controls">
          <label className="dl-events-caller-select">
            <span className="dl-events-caller-label">Caller</span>
            <select
              value={selectedCaller ?? ""}
              disabled={callers.length === 0}
              onChange={(e) => setSelectedCaller(e.target.value || null)}
            >
              {callers.length === 0 && <option value="">No callers</option>}
              {callers.map((c) => (
                <option key={c.alias} value={c.alias}>
                  {c.name ? `${c.name} (${c.alias})` : c.alias}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="dl-events-refresh"
            onClick={handleRefresh}
            disabled={!selectedCaller || refreshing}
            title="Refresh now"
          >
            <RefreshCw
              size={14}
              className={refreshing ? "dl-events-spin" : undefined}
            />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      {callersLoaded && callers.length === 0 && (
        <div className="placeholder">
          <span className="placeholder-title">No callers configured</span>
          <span>Create a caller before events can be ingested.</span>
        </div>
      )}

      {selectedCaller && (
        <>
          {/* Ingestor status cards */}
          {ingestors.length > 0 && (
            <section className="dl-events-ingestors">
              {ingestors.map((ing) => (
                <article
                  key={`${ing.connection}::${ing.instanceId ?? ""}`}
                  className="dl-events-ingestor-card"
                >
                  <div className="dl-events-ingestor-head">
                    <span
                      className={`status-dot dl-events-dot dl-events-dot-${stateClass(ing.state)}`}
                      aria-hidden="true"
                    />
                    <span className="mono dl-events-ingestor-conn">
                      {ing.connection}
                    </span>
                    {ing.instanceId && (
                      <span className="mono dl-events-instance">
                        {ing.instanceId}
                      </span>
                    )}
                  </div>
                  <div className="dl-events-ingestor-meta">
                    <span
                      className={`dl-events-state dl-events-state-${stateClass(ing.state)}`}
                    >
                      {ing.state}
                    </span>
                    <span className="tag">{ing.type}</span>
                    <span className="dl-events-muted">
                      {ing.totalEventsReceived} event
                      {ing.totalEventsReceived === 1 ? "" : "s"}
                    </span>
                    {ing.lastEventAt && (
                      <span className="dl-events-muted">
                        last: {timeAgo(ing.lastEventAt)}
                      </span>
                    )}
                  </div>
                  {ing.error && (
                    <div className="dl-events-ingestor-error" title={ing.error}>
                      {ing.error}
                    </div>
                  )}
                </article>
              ))}
            </section>
          )}

          {/* Source filter pills */}
          {sources.length > 0 && (
            <div className="dl-events-pills">
              <button
                type="button"
                className={`dl-events-pill ${activeSource === null ? "dl-events-pill-active" : ""}`}
                onClick={() => setActiveSource(null)}
              >
                All ({events.length})
              </button>
              {sources.map((src) => (
                <button
                  key={src}
                  type="button"
                  className={`dl-events-pill mono ${activeSource === src ? "dl-events-pill-active" : ""}`}
                  onClick={() => setActiveSource(src)}
                >
                  {src} ({sourceCounts.get(src)})
                </button>
              ))}
            </div>
          )}

          {/* Event feed */}
          {loading ? (
            <div className="banner banner-loading">Loading events…</div>
          ) : filteredEvents.length === 0 ? (
            <div className="placeholder">
              <Radio size={22} className="dl-events-empty-icon" aria-hidden="true" />
              <span className="placeholder-title">No events yet</span>
              <span>
                Events from this caller's ingestors will appear here as they
                arrive.
              </span>
            </div>
          ) : (
            <div className="dl-events-feed">
              {filteredEvents.map((ev) => {
                const expanded = expandedId === ev.id;
                return (
                  <div
                    key={`${ev.source}::${ev.id}`}
                    className="dl-events-row-wrap"
                  >
                    <button
                      type="button"
                      className="dl-events-row"
                      aria-expanded={expanded}
                      onClick={() =>
                        setExpandedId(expanded ? null : ev.id)
                      }
                    >
                      {expanded ? (
                        <ChevronDown size={14} className="dl-events-chevron" />
                      ) : (
                        <ChevronRight size={14} className="dl-events-chevron" />
                      )}
                      <span className="dl-events-source mono">{ev.source}</span>
                      {ev.instanceId && (
                        <span className="dl-events-instance mono">
                          {ev.instanceId}
                        </span>
                      )}
                      <span className="dl-events-type mono">{ev.eventType}</span>
                      <span className="dl-events-preview">
                        {dataPreview(ev.data)}
                      </span>
                      <span className="dl-events-time">
                        {timeAgo(ev.receivedAtMs)}
                      </span>
                    </button>
                    {expanded && (
                      <div className="dl-events-detail">
                        <div className="dl-events-detail-meta">
                          {ev.instanceId && (
                            <span>
                              <span className="dl-events-muted">
                                instanceId:
                              </span>{" "}
                              <span className="mono">{ev.instanceId}</span>
                            </span>
                          )}
                          <span>
                            <span className="dl-events-muted">id:</span>{" "}
                            <span className="mono">{ev.id}</span>
                          </span>
                          <span>
                            <span className="dl-events-muted">
                              idempotencyKey:
                            </span>{" "}
                            <span className="mono">{ev.idempotencyKey}</span>
                          </span>
                          <span>
                            <span className="dl-events-muted">receivedAt:</span>{" "}
                            <span className="mono" title={ev.receivedAt}>
                              {new Date(ev.receivedAtMs).toLocaleString()}
                            </span>
                          </span>
                        </div>
                        <pre className="dl-events-json mono">
                          {prettyData(ev.data)}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Keep `now` referenced so the per-second tick re-renders relative times. */}
      <span hidden aria-hidden="true" data-now={now} />
    </>
  );
}
