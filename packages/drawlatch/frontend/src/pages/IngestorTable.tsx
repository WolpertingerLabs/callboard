import { useState } from "react";
import { AlertTriangle, Radio } from "lucide-react";
import type { AdminIngestor, IngestorState } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { useNow, usePolling } from "../hooks/usePolling";
import DaemonOffline from "../components/DaemonOffline";
import EmptyState, { LoadingState } from "../components/EmptyState";
import { plural, timeAgo } from "../utils/format";

const POLL_INTERVAL_MS = 2_000;
const ERROR_PREVIEW_LEN = 80;

const STATE_BADGE: Record<IngestorState, string> = {
  connected: "badge-success",
  starting: "badge-warning",
  reconnecting: "badge-warning",
  error: "badge-danger",
  stopped: "badge-muted",
};

export default function IngestorTable() {
  const { daemon } = useDaemon();
  const isMobile = useIsMobile();
  const now = useNow();
  // The last list that loaded stays on screen when a poll fails, with a note
  // above it, so one blip doesn't blank the page.
  const [ingestors, setIngestors] = useState<AdminIngestor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  usePolling(
    async (ctx) => {
      const res = await api.ingestors();
      if (!ctx.active()) return;
      if (isDaemonDown(res)) {
        setError(res.error);
        return;
      }
      setIngestors(res);
      setError(null);
      setLoadedAt(Date.now());
    },
    POLL_INTERVAL_MS,
    { enabled: daemon === "up" },
  );

  const header = (
    <header className="page-header">
      <div>
        <h1 className="page-title">Listeners</h1>
        <div className="subtitle-meta">
          <span>Live status of websocket, webhook and poll listeners</span>
          <span className="dot-sep">·</span>
          <span>polling every 2s</span>
        </div>
      </div>
      {/* Hidden while offline: a stale count beside "not reachable". */}
      {ingestors && daemon !== "down" && (
        <span className="page-subtitle">{plural(ingestors.length, "listener")}</span>
      )}
    </header>
  );

  if (daemon === "down") {
    return (
      <>
        {header}
        <DaemonOffline action="load listener status" />
      </>
    );
  }

  const groups = ingestors ? groupByCaller(ingestors) : [];

  return (
    <>
      {header}

      {!ingestors && !error && <LoadingState label="Loading listeners…" />}

      {error && (
        <div
          className={`banner ${ingestors ? "banner-warn" : "banner-offline"}`}
          role="status"
        >
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            {ingestors
              ? `Couldn't refresh: ${error}. Last updated ${timeAgo(loadedAt, now)}.`
              : `Couldn't load listeners: ${error}`}
          </span>
        </div>
      )}

      {ingestors && ingestors.length === 0 && (
        <EmptyState
          icon={<Radio size={20} />}
          title="No listeners running"
          body="Listeners start when a caller opens an MCP session for a connection that has one."
        />
      )}

      {ingestors && ingestors.length > 0 && !isMobile && (
        <div className="data-table-wrap">
          <table className="data-table ingestor-table">
            <thead>
              <tr>
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

      {ingestors && ingestors.length > 0 && isMobile && (
        <div className="mobile-card-groups">
          {groups.map((group) => (
            <section key={group.caller} className="mobile-card-group">
              <header className="mobile-card-group-header">
                <span className="mobile-card-group-label">Caller</span>
                <span className="mono">{group.caller}</span>
                <span className="mobile-card-group-count">
                  {plural(group.rows.length, "listener")}
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
        <span className="badge badge-info">{ing.type}</span>
        {ing.instanceId && <span className="mono cell-muted">{ing.instanceId}</span>}
      </div>
      <dl className="mobile-card-kv">
        <div className="mobile-card-kv-row">
          <dt>Buffer</dt>
          <dd className="mono">
            {ing.bufferedEvents}
            <span className="cell-muted"> · {ing.totalEventsReceived} total</span>
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
        // The whole message, wrapped: a phone has no hover for a tooltip.
        <div className="mobile-card-error ingestor-error">{ing.error}</div>
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

function CallerGroup({ group, now }: { group: CallerGroupRows; now: number }) {
  return (
    <>
      <tr className="ingestor-group-header">
        <th colSpan={6} scope="colgroup">
          <div className="ingestor-group-header-inner">
            <span className="ingestor-group-label">Caller</span>
            <span className="mono">{group.caller}</span>
            <span className="ingestor-group-count">
              {plural(group.rows.length, "listener")}
            </span>
          </div>
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
        <div className="cell-primary mono">{ing.connection}</div>
        <div className="cell-secondary">
          <span className="badge badge-info">{ing.type}</span>
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
        <span
          className="mono"
          title={`${plural(ing.totalEventsReceived, "event")} received in total`}
        >
          {ing.bufferedEvents}
        </span>
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
  return <span className={`badge ${STATE_BADGE[state] ?? "badge-muted"}`}>{state}</span>;
}

function RelativeTime({ iso, now }: { iso: string | null; now: number }) {
  if (!iso) return <span className="cell-muted">never</span>;
  return (
    <span className="cell-muted" title={iso}>
      {timeAgo(iso, now)}
    </span>
  );
}

/** A long error shows its first line and a "Show all" toggle, so the whole
 *  message is reachable by tap or keyboard, not only by hovering. */
function ErrorCell({ error }: { error: string | undefined }) {
  const [expanded, setExpanded] = useState(false);
  if (!error) return <span className="cell-muted">—</span>;
  const long = error.length > ERROR_PREVIEW_LEN;
  return (
    <div>
      <span className="ingestor-error">
        {long && !expanded ? `${error.slice(0, ERROR_PREVIEW_LEN)}…` : error}
      </span>
      {long && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}
