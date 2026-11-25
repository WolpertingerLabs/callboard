import { useEffect, useState } from "react";
import type {
  AdminIngestor,
  IngestorState,
} from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import { useIsMobile } from "../hooks/useIsMobile";

type FetchState =
  | { status: "loading" }
  | { status: "ok"; ingestors: AdminIngestor[] }
  | { status: "error"; message: string };

const POLL_INTERVAL_MS = 2_000;
const ERROR_PREVIEW_LEN = 80;

export default function IngestorTable() {
  const { daemon } = useDaemon();
  const isMobile = useIsMobile();
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (daemon !== "up") return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      const res = await api.ingestors();
      if (cancelled) return;
      if (isDaemonDown(res)) {
        // Surface the offline state immediately rather than waiting for the
        // shared DaemonContext heartbeat (5s) to catch up.
        setState({ status: "error", message: res.error });
        return;
      }
      setState({ status: "ok", ingestors: res });
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
  }, [daemon]);

  // Tick "now" each second so relative timestamps re-render. Pause when hidden.
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

  if (daemon === "down") {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Ingestors</h1>
        </header>
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            Drawlatch daemon is not reachable. Start it with{" "}
            <code>drawlatch start</code> to load ingestor status.
          </span>
        </div>
      </>
    );
  }

  const isLoading = state.status === "loading";
  const isError = state.status === "error";
  const ingestors = state.status === "ok" ? state.ingestors : [];
  const groups = groupByCaller(ingestors);

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Ingestors</h1>
          <div className="subtitle-meta">
            <span>Live status of websocket / webhook / poll listeners</span>
            <span className="dot-sep">·</span>
            <span>polling every 2s</span>
          </div>
        </div>
        {state.status === "ok" && (
          <span className="page-subtitle">
            {ingestors.length} ingestor
            {ingestors.length === 1 ? "" : "s"}
          </span>
        )}
      </header>

      {isLoading && (
        <div className="banner banner-loading">Loading ingestors…</div>
      )}

      {isError && (
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load ingestors: {state.message}</span>
        </div>
      )}

      {state.status === "ok" && ingestors.length === 0 && (
        <div className="placeholder">
          <span className="placeholder-title">No active ingestors</span>
          <span>
            Ingestors start when a caller opens an MCP session for a
            connection that has a listener.
          </span>
        </div>
      )}

      {state.status === "ok" && ingestors.length > 0 && !isMobile && (
        <div className="data-table-wrap">
          <table className="data-table ingestor-table">
            <thead>
              <tr>
                <th>Caller</th>
                <th>Connection</th>
                <th>Instance</th>
                <th>State</th>
                <th className="num">Buffer</th>
                <th>Last event</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <CallerGroup key={group.caller} group={group} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {state.status === "ok" && ingestors.length > 0 && isMobile && (
        <div className="mobile-card-groups">
          {groups.map((group) => (
            <section key={group.caller} className="mobile-card-group">
              <header className="mobile-card-group-header">
                <span className="mobile-card-group-label">caller</span>
                <span className="mono">{group.caller}</span>
                <span className="mobile-card-group-count">
                  {group.rows.length} ingestor
                  {group.rows.length === 1 ? "" : "s"}
                </span>
              </header>
              <div className="mobile-card-list">
                {group.rows.map((ing) => (
                  <IngestorCard key={rowKey(ing)} ing={ing} now={now} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function IngestorCard({ ing, now }: { ing: AdminIngestor; now: number }) {
  return (
    <article className="mobile-card">
      <div className="mobile-card-header">
        <div className="mobile-card-title mono">{ing.connection}</div>
        <StateBadge state={ing.state} />
      </div>
      <div className="mobile-card-meta">
        <span className="tag">{ing.type}</span>
        {ing.instanceId && (
          <span className="mono cell-muted">{ing.instanceId}</span>
        )}
      </div>
      <dl className="mobile-card-kv">
        <div className="mobile-card-kv-row">
          <dt>Buffer</dt>
          <dd className="mono">
            {ing.bufferedEvents}
            <span className="cell-muted">
              {" "}
              · {ing.totalEventsReceived} total
            </span>
          </dd>
        </div>
        <div className="mobile-card-kv-row">
          <dt>Last event</dt>
          <dd>
            <RelativeTime iso={ing.lastEventAt} now={now} />
          </dd>
        </div>
      </dl>
      {ing.error && (
        <div className="mobile-card-error">
          <ErrorCell error={ing.error} />
        </div>
      )}
    </article>
  );
}

interface CallerGroupRows {
  caller: string;
  rows: AdminIngestor[];
}

function groupByCaller(ingestors: AdminIngestor[]): CallerGroupRows[] {
  const map = new Map<string, AdminIngestor[]>();
  for (const ing of ingestors) {
    const list = map.get(ing.callerAlias);
    if (list) list.push(ing);
    else map.set(ing.callerAlias, [ing]);
  }
  // Sort callers alphabetically for stable rendering across polls.
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([caller, rows]) => ({
      caller,
      rows: [...rows].sort((a, b) => {
        const c = a.connection.localeCompare(b.connection);
        if (c !== 0) return c;
        return (a.instanceId ?? "").localeCompare(b.instanceId ?? "");
      }),
    }));
}

function CallerGroup({
  group,
  now,
}: {
  group: CallerGroupRows;
  now: number;
}) {
  return (
    <>
      <tr className="ingestor-group-header">
        <th colSpan={7} scope="colgroup">
          <span className="ingestor-group-label">caller</span>
          <span className="mono">{group.caller}</span>
          <span className="ingestor-group-count">
            {group.rows.length} ingestor
            {group.rows.length === 1 ? "" : "s"}
          </span>
        </th>
      </tr>
      {group.rows.map((ing) => (
        <IngestorRow key={rowKey(ing)} ing={ing} now={now} />
      ))}
    </>
  );
}

function rowKey(ing: AdminIngestor): string {
  return `${ing.callerAlias}::${ing.connection}::${ing.instanceId ?? ""}`;
}

function IngestorRow({ ing, now }: { ing: AdminIngestor; now: number }) {
  return (
    <tr>
      <td>
        <span className="cell-muted mono">{ing.callerAlias}</span>
      </td>
      <td>
        <div className="cell-primary mono">{ing.connection}</div>
        <div className="cell-secondary">
          <span className="tag">{ing.type}</span>
        </div>
      </td>
      <td>
        {ing.instanceId ? (
          <span className="mono">{ing.instanceId}</span>
        ) : (
          <span className="cell-muted">—</span>
        )}
      </td>
      <td>
        <StateBadge state={ing.state} />
      </td>
      <td className="num">
        <BufferCell
          buffered={ing.bufferedEvents}
          total={ing.totalEventsReceived}
        />
      </td>
      <td>
        <RelativeTime iso={ing.lastEventAt} now={now} />
      </td>
      <td>
        <ErrorCell error={ing.error} />
      </td>
    </tr>
  );
}

function StateBadge({ state }: { state: IngestorState }) {
  return (
    <span className={`ingestor-state ingestor-state-${state}`}>{state}</span>
  );
}

function BufferCell({
  buffered,
  total,
}: {
  buffered: number;
  total: number;
}) {
  return (
    <span
      className="mono"
      title={`${total} total event${total === 1 ? "" : "s"} received`}
    >
      {buffered}
    </span>
  );
}

function RelativeTime({ iso, now }: { iso: string | null; now: number }) {
  if (!iso) return <span className="cell-muted">never</span>;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return <span className="cell-muted">—</span>;
  return (
    <span className="cell-muted" title={iso}>
      {formatRelative(now - t)}
    </span>
  );
}

function formatRelative(deltaMs: number): string {
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

function ErrorCell({ error }: { error: string | undefined }) {
  if (!error) return <span className="cell-muted">—</span>;
  const truncated =
    error.length > ERROR_PREVIEW_LEN
      ? `${error.slice(0, ERROR_PREVIEW_LEN)}…`
      : error;
  return (
    <span className="ingestor-error" title={error}>
      {truncated}
    </span>
  );
}
