import { useMemo, useState } from "react";
import { Activity, AlertTriangle } from "lucide-react";
import type { AdminSession } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import { useIsMobile } from "../hooks/useIsMobile";
import { useNow, usePolling } from "../hooks/usePolling";
import DaemonOffline from "../components/DaemonOffline";
import EmptyState, { LoadingState } from "../components/EmptyState";
import { plural, timeAgo } from "../utils/format";

const POLL_INTERVAL_MS = 5_000;

export default function SessionTable() {
  const { daemon } = useDaemon();
  const isMobile = useIsMobile();
  const now = useNow();
  // The last list that loaded stays on screen when a poll fails.
  const [sessions, setSessions] = useState<AdminSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  usePolling(
    async (ctx) => {
      const res = await api.sessions();
      if (!ctx.active()) return;
      if (isDaemonDown(res)) {
        setError(res.error);
        return;
      }
      setSessions(res);
      setError(null);
      setLoadedAt(Date.now());
    },
    POLL_INTERVAL_MS,
    { enabled: daemon === "up" },
  );

  const sorted = useMemo(
    () => (sessions ? [...sessions].sort((a, b) => b.lastActivity - a.lastActivity) : null),
    [sessions],
  );

  const header = (
    <header className="page-header">
      <div>
        <h1 className="page-title">Sessions</h1>
        <div className="subtitle-meta">
          <span>Active MCP sessions and rate-limit windows</span>
          <span className="dot-sep">·</span>
          <span>polling every 5s</span>
        </div>
      </div>
      {/* Hidden while offline: a stale count beside "not reachable". */}
      {sorted && daemon !== "down" && (
        <span className="page-subtitle">{plural(sorted.length, "session")}</span>
      )}
    </header>
  );

  if (daemon === "down") {
    return (
      <>
        {header}
        <DaemonOffline action="load active sessions" />
      </>
    );
  }

  return (
    <>
      {header}

      {!sorted && !error && <LoadingState label="Loading sessions…" />}

      {error && (
        <div className={`banner ${sorted ? "banner-warn" : "banner-offline"}`} role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            {sorted
              ? `Couldn't refresh: ${error}. Last updated ${timeAgo(loadedAt, now)}.`
              : `Couldn't load sessions: ${error}`}
          </span>
        </div>
      )}

      {sorted && sorted.length === 0 && (
        <EmptyState
          icon={<Activity size={20} />}
          title="No active sessions"
          body="A session starts when a caller opens an MCP connection to Drawlatch."
        />
      )}

      {sorted && sorted.length > 0 && !isMobile && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Caller</th>
                <th>Created</th>
                <th>Last activity</th>
                <th className="num">Requests</th>
                <th>Rate-limit window</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <SessionRow key={s.sessionIdShort} session={s} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sorted && sorted.length > 0 && isMobile && (
        <div className="mobile-card-list">
          {sorted.map((s) => (
            <SessionCard key={s.sessionIdShort} session={s} now={now} />
          ))}
        </div>
      )}
    </>
  );
}

function SessionCard({ session, now }: { session: AdminSession; now: number }) {
  return (
    <article className="mobile-card">
      <div className="mobile-card-header">
        {/* The daemon already shortens the id to 12 characters; show all of
            it rather than an ellipsis nobody can expand on a phone. */}
        <div className="mobile-card-title mono">{session.sessionIdShort}</div>
        <span className="mono cell-muted">{session.callerAlias}</span>
      </div>
      <dl className="mobile-card-kv">
        <div className="mobile-card-kv-row">
          <dt>Created</dt>
          <dd>
            <RelativeTime epochMs={session.createdAt} now={now} />
          </dd>
        </div>
        <div className="mobile-card-kv-row">
          <dt>Last activity</dt>
          <dd>
            <RelativeTime epochMs={session.lastActivity} now={now} />
          </dd>
        </div>
        <div className="mobile-card-kv-row">
          <dt>Requests</dt>
          <dd className="mono">
            {session.requestCount}
            <span className="cell-muted"> · {session.windowRequests} in window</span>
          </dd>
        </div>
        <div className="mobile-card-kv-row">
          <dt>Window started</dt>
          <dd>
            <RelativeTime epochMs={session.windowStart} now={now} />
          </dd>
        </div>
      </dl>
    </article>
  );
}

function SessionRow({ session, now }: { session: AdminSession; now: number }) {
  return (
    <tr>
      <td>
        <span className="mono">{session.sessionIdShort}</span>
      </td>
      <td>
        <span className="cell-muted mono">{session.callerAlias}</span>
      </td>
      <td>
        <RelativeTime epochMs={session.createdAt} now={now} />
      </td>
      <td>
        <RelativeTime epochMs={session.lastActivity} now={now} />
      </td>
      <td className="num">
        <span className="mono">{session.requestCount}</span>
      </td>
      <td>
        <div className="cell-primary mono">{plural(session.windowRequests, "request")}</div>
        <div className="cell-secondary">
          window started <RelativeTime epochMs={session.windowStart} now={now} />
        </div>
      </td>
    </tr>
  );
}

function RelativeTime({ epochMs, now }: { epochMs: number; now: number }) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return <span className="cell-muted">—</span>;
  }
  return (
    <span className="cell-muted" title={new Date(epochMs).toISOString()}>
      {timeAgo(epochMs, now)}
    </span>
  );
}
