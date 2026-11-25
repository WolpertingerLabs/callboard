import { useEffect, useMemo, useState } from "react";
import type { AdminSecret } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";

type FetchState =
  | { status: "loading" }
  | { status: "ok"; secrets: AdminSecret[] }
  | { status: "error"; message: string };

const POLL_INTERVAL_MS = 10_000;

export default function SecretMatrix() {
  const { daemon } = useDaemon();
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [onlyMissing, setOnlyMissing] = useState(false);

  useEffect(() => {
    if (daemon !== "up") return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      const res = await api.secrets();
      if (cancelled) return;
      if (isDaemonDown(res)) {
        setState({ status: "error", message: res.error });
        return;
      }
      setState({ status: "ok", secrets: res });
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

  const pivot = useMemo(() => {
    if (state.status !== "ok") return null;
    return pivotByConnection(state.secrets);
  }, [state]);

  const summary = useMemo(() => {
    if (state.status !== "ok") return null;
    let total = 0;
    let present = 0;
    for (const s of state.secrets) {
      if (!s.required) continue;
      total += 1;
      if (s.present) present += 1;
    }
    return { total, present };
  }, [state]);

  if (daemon === "down") {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Secrets</h1>
        </header>
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            Drawlatch daemon is not reachable. Start it with{" "}
            <code>drawlatch start</code> to load the secrets matrix.
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
          <h1 className="page-title">Secrets</h1>
          <div className="subtitle-meta">
            <span>Presence of required and optional secrets per caller</span>
            <span className="dot-sep">·</span>
            <span>polling every 10s</span>
          </div>
        </div>
        {summary && (
          <span className="page-subtitle">
            {summary.present} of {summary.total} required secrets configured
          </span>
        )}
      </header>

      {state.status === "ok" && state.secrets.length > 0 && (
        <div className="secret-matrix-controls">
          <label className="secret-matrix-toggle">
            <input
              type="checkbox"
              checked={onlyMissing}
              onChange={(e) => setOnlyMissing(e.target.checked)}
            />
            <span>Only show callers with missing required secrets</span>
          </label>
        </div>
      )}

      {isLoading && (
        <div className="banner banner-loading">Loading secrets…</div>
      )}

      {isError && (
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load secrets: {state.message}</span>
        </div>
      )}

      {state.status === "ok" && state.secrets.length === 0 && (
        <div className="placeholder">
          <span className="placeholder-title">No secrets declared</span>
          <span>
            No callers have connections that declare required or optional
            secrets.
          </span>
        </div>
      )}

      {state.status === "ok" && pivot && pivot.length > 0 && (
        <SecretMatrixView pivot={pivot} onlyMissing={onlyMissing} />
      )}
    </>
  );
}

interface RowData {
  callerAlias: string;
  cells: Map<string, { required: boolean; present: boolean }>;
  hasMissingRequired: boolean;
}

interface ConnectionGroup {
  connection: string;
  columns: { name: string; required: boolean }[];
  rows: RowData[];
}

function pivotByConnection(secrets: AdminSecret[]): ConnectionGroup[] {
  // Group secrets by connection alias.
  const byConnection = new Map<string, AdminSecret[]>();
  for (const s of secrets) {
    const list = byConnection.get(s.connection);
    if (list) list.push(s);
    else byConnection.set(s.connection, [s]);
  }

  const groups: ConnectionGroup[] = [];
  for (const [connection, items] of byConnection) {
    // Build column set (unique secret names for this connection).
    const colMap = new Map<string, boolean>();
    for (const s of items) {
      const prev = colMap.get(s.name);
      // If a name appears as both required and optional across callers (it
      // shouldn't, but be defensive), treat it as required.
      colMap.set(s.name, (prev ?? false) || s.required);
    }
    const columns = [...colMap.entries()]
      .map(([name, required]) => ({ name, required }))
      .sort((a, b) => {
        if (a.required !== b.required) return a.required ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    // Build rows by caller alias.
    const byCaller = new Map<string, AdminSecret[]>();
    for (const s of items) {
      const list = byCaller.get(s.callerAlias);
      if (list) list.push(s);
      else byCaller.set(s.callerAlias, [s]);
    }

    const rows: RowData[] = [];
    for (const [callerAlias, callerSecrets] of byCaller) {
      const cells = new Map<
        string,
        { required: boolean; present: boolean }
      >();
      for (const s of callerSecrets) {
        cells.set(s.name, { required: s.required, present: s.present });
      }
      let hasMissingRequired = false;
      for (const col of columns) {
        const cell = cells.get(col.name);
        if (col.required && (!cell || !cell.present)) {
          hasMissingRequired = true;
          break;
        }
      }
      rows.push({ callerAlias, cells, hasMissingRequired });
    }
    rows.sort((a, b) => a.callerAlias.localeCompare(b.callerAlias));

    groups.push({ connection, columns, rows });
  }

  groups.sort((a, b) => a.connection.localeCompare(b.connection));
  return groups;
}

function SecretMatrixView({
  pivot,
  onlyMissing,
}: {
  pivot: ConnectionGroup[];
  onlyMissing: boolean;
}) {
  const filtered = onlyMissing
    ? pivot
        .map((g) => ({
          ...g,
          rows: g.rows.filter((r) => r.hasMissingRequired),
        }))
        .filter((g) => g.rows.length > 0)
    : pivot;

  if (filtered.length === 0) {
    return (
      <div className="placeholder">
        <span className="placeholder-title">All required secrets present</span>
        <span>Every caller has every required secret configured.</span>
      </div>
    );
  }

  return (
    <div className="secret-matrix">
      {filtered.map((group) => (
        <ConnectionMatrix key={group.connection} group={group} />
      ))}
    </div>
  );
}

function ConnectionMatrix({ group }: { group: ConnectionGroup }) {
  return (
    <section className="secret-matrix-section">
      <header className="secret-matrix-section-header">
        <span className="secret-matrix-section-label">connection</span>
        <span className="mono">{group.connection}</span>
        <span className="secret-matrix-section-meta">
          {group.rows.length} caller{group.rows.length === 1 ? "" : "s"}
          {" · "}
          {group.columns.length} secret
          {group.columns.length === 1 ? "" : "s"}
        </span>
      </header>
      <div className="secret-matrix-scroll">
        <div className="data-table-wrap secret-matrix-wrap">
          <table className="data-table secret-matrix-table">
            <thead>
              <tr>
                <th className="secret-matrix-caller-col">Caller</th>
                {group.columns.map((col) => (
                  <th
                    key={col.name}
                    className={`secret-matrix-col ${col.required ? "secret-matrix-col-required" : "secret-matrix-col-optional"}`}
                    title={
                      col.required ? "required secret" : "optional secret"
                    }
                  >
                    <span className="mono">{col.name}</span>
                    {col.required && (
                      <span
                        className="secret-matrix-required-mark"
                        aria-label="required"
                      >
                        *
                      </span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => (
                <tr key={row.callerAlias}>
                  <td className="secret-matrix-caller-col">
                    <span className="mono">{row.callerAlias}</span>
                  </td>
                  {group.columns.map((col) => {
                    const cell = row.cells.get(col.name);
                    return (
                      <td
                        key={col.name}
                        className="secret-matrix-cell"
                      >
                        <SecretCell required={col.required} cell={cell} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function SecretCell({
  required,
  cell,
}: {
  required: boolean;
  cell: { required: boolean; present: boolean } | undefined;
}) {
  // No declaration of this secret for this caller (e.g. only some callers
  // include this connection's optional secret in their environment).
  if (!cell) {
    return <span className="cell-muted" aria-label="not declared">—</span>;
  }
  if (cell.present) {
    return (
      <span
        className={`secret-matrix-mark ${required ? "secret-matrix-mark-required-present" : "secret-matrix-mark-optional-present"}`}
        aria-label="present"
      >
        ✓
      </span>
    );
  }
  return (
    <span
      className={`secret-matrix-mark ${required ? "secret-matrix-mark-required-missing" : "secret-matrix-mark-optional-missing"}`}
      aria-label="missing"
    >
      ✗
    </span>
  );
}
