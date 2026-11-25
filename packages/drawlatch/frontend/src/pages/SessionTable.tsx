import { useEffect, useMemo, useState } from "react";
import type { AdminSession } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import { useIsMobile } from "../hooks/useIsMobile";

type FetchState =
  | { status: "loading" }
  | { status: "ok"; sessions: AdminSession[] }
  | { status: "error"; message: string };

const POLL_INTERVAL_MS = 5_000;

export default function SessionTable() {
  const { daemon } = useDaemon();
  const isMobile = useIsMobile();
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (daemon !== "up") return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      const res = await api.sessions();
      if (cancelled) return;
      if (isDaemonDown(res)) {
        // Surface the offline state immediately rather than waiting for the
        // shared DaemonContext heartbeat (5s) to catch up.
        setState({ status: "error", message: res.error });
        return;
      }
      setState({ status: "ok", sessions: res });
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

  const sortedSessions = useMemo(() => {
    if (state.status !== "ok") return [];
    return [...state.sessions].sort((a, b) => b.lastActivity - a.lastActivity);
  }, [state]);

  if (daemon === "down") {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Sessions</h1>
        </header>
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            Drawlatch daemon is not reachable. Start it with{" "}
            <code>drawlatch start</code> to load active sessions.
          </span>
        </div>
      </>
    );
  }

  const isLoading = state.status === "loading";
  const isError = state.status === "error";

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Sessions</h1>
          <div className="subtitle-meta">
            <span>Active MCP sessions and rate-limit windows</span>
            <span className="dot-sep">·</span>
            <span>polling every 5s</span>
          </div>
        </div>
        {state.status === "ok" && (
          <span className="page-subtitle">
            {sortedSessions.length} session
            {sortedSessions.length === 1 ? "" : "s"}
          </span>
        )}
      </header>

      {isLoading && (
        <div className="banner banner-loading">Loading sessions…</div>
      )}

      {isError && (
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load sessions: {state.message}</span>
        </div>
      )}

      {state.status === "ok" && sortedSessions.length === 0 && (
        <div className="placeholder">
          <span className="placeholder-title">No active sessions</span>
          <span>
            Sessions are created when a caller opens an MCP connection
            against drawlatch.
          </span>
        </div>
      )}

      {state.status === "ok" && sortedSessions.length > 0 && !isMobile && (
        <div className="data-table-wrap">
          <table className="data-table session-table">
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
              {sortedSessions.map((s) => (
                <SessionRow key={s.sessionIdShort} session={s} now={now} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {state.status === "ok" && sortedSessions.length > 0 && isMobile && (
        <div className="mobile-card-list">
          {sortedSessions.map((s) => (
            <SessionCard key={s.sessionIdShort} session={s} now={now} />
          ))}
        </div>
      )}
    </>
  );
}

function middleEllipsis(value: string, max = 14): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function SessionCard({
  session,
  now,
}: {
  session: AdminSession;
  now: number;
}) {
  return (
    <article className="mobile-card">
      <div className="mobile-card-header">
        <div className="mobile-card-title mono" title={session.sessionIdShort}>
          {middleEllipsis(session.sessionIdShort)}
        </div>
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
            <span className="cell-muted">
              {" "}
              · {session.windowRequests} in window
            </span>
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

function SessionRow({
  session,
  now,
}: {
  session: AdminSession;
  now: number;
}) {
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
        <RateLimitWindow
          requests={session.windowRequests}
          windowStart={session.windowStart}
          now={now}
        />
      </td>
    </tr>
  );
}

function RateLimitWindow({
  requests,
  windowStart,
  now,
}: {
  requests: number;
  windowStart: number;
  now: number;
}) {
  return (
    <div>
      <div className="cell-primary mono">
        {requests} request{requests === 1 ? "" : "s"}
      </div>
      <div className="cell-secondary">
        window started <RelativeTime epochMs={windowStart} now={now} />
      </div>
    </div>
  );
}

function RelativeTime({
  epochMs,
  now,
}: {
  epochMs: number;
  now: number;
}) {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return <span className="cell-muted">—</span>;
  }
  const iso = new Date(epochMs).toISOString();
  return (
    <span className="cell-muted" title={iso}>
      {formatRelative(now - epochMs)}
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
