import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, KeyRound } from "lucide-react";
import type { AdminSecret } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import { useNow, usePolling } from "../hooks/usePolling";
import DaemonOffline from "../components/DaemonOffline";
import EmptyState, { LoadingState } from "../components/EmptyState";
import { timeAgo } from "../utils/format";
import "./SecretMatrix.css";

const POLL_INTERVAL_MS = 10_000;

/**
 * Required secrets, counted per caller and connection: "present of total".
 * The one definition, shared by this page and the Overview card.
 */
export function countRequiredSecrets(secrets: readonly AdminSecret[]): {
  total: number;
  present: number;
} {
  let total = 0;
  let present = 0;
  for (const s of secrets) {
    if (!s.required) continue;
    total += 1;
    if (s.present) present += 1;
  }
  return { total, present };
}

export default function SecretMatrix() {
  const { daemon } = useDaemon();
  const now = useNow(5_000);
  // The last matrix that loaded stays on screen when a poll fails.
  const [secrets, setSecrets] = useState<AdminSecret[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [onlyMissing, setOnlyMissing] = useState(false);

  usePolling(
    async (ctx) => {
      const res = await api.secrets();
      if (!ctx.active()) return;
      if (isDaemonDown(res)) {
        setError(res.error);
        return;
      }
      setSecrets(res);
      setError(null);
      setLoadedAt(Date.now());
    },
    POLL_INTERVAL_MS,
    { enabled: daemon === "up" },
  );

  const matrix = useMemo(() => (secrets ? buildMatrix(secrets) : null), [secrets]);
  const summary = useMemo(() => (secrets ? countRequiredSecrets(secrets) : null), [secrets]);

  const header = (
    <header className="page-header">
      <div>
        <h1 className="page-title">Secrets</h1>
        <div className="subtitle-meta">
          <span>Which secrets each caller has set, by connection</span>
          <span className="dot-sep">·</span>
          <span>polling every 10s</span>
        </div>
      </div>
      {/* Hidden while offline: a stale count beside "not reachable". */}
      {summary && summary.total > 0 && daemon !== "down" && (
        <span className="page-subtitle">
          {summary.present} of {summary.total} required secrets configured
        </span>
      )}
    </header>
  );

  if (daemon === "down") {
    return (
      <>
        {header}
        <DaemonOffline action="load the secrets matrix" />
      </>
    );
  }

  return (
    <>
      {header}

      {!secrets && !error && <LoadingState label="Loading secrets…" />}

      {error && (
        <div className={`banner ${secrets ? "banner-warn" : "banner-offline"}`} role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>
            {secrets
              ? `Couldn't refresh: ${error}. Last updated ${timeAgo(loadedAt, now)}.`
              : `Couldn't load secrets: ${error}`}
          </span>
        </div>
      )}

      {matrix && matrix.groups.length === 0 && (
        <EmptyState
          icon={<KeyRound size={20} />}
          title="No secrets declared"
          body="None of your callers' connections declare required or optional secrets."
        />
      )}

      {matrix && matrix.groups.length > 0 && (
        <>
          <div className="dl-matrix-toolbar">
            <label className="dl-matrix-toggle">
              <input
                type="checkbox"
                checked={onlyMissing}
                onChange={(e) => setOnlyMissing(e.target.checked)}
              />
              <span>Only show missing required secrets</span>
            </label>
            <Legend />
          </div>
          <MatrixTable matrix={matrix} onlyMissing={onlyMissing} />
        </>
      )}
    </>
  );
}

// ── Model ────────────────────────────────────────────────────────────────

type Cell = { required: boolean; present: boolean } | undefined;

interface SecretRow {
  name: string;
  required: boolean;
  /** caller alias → cell; absent when that caller doesn't use the secret. */
  cells: Map<string, Cell>;
  missingRequired: boolean;
}

interface ConnectionGroup {
  connection: string;
  rows: SecretRow[];
  required: { total: number; present: number };
}

interface Matrix {
  callers: string[];
  groups: ConnectionGroup[];
}

/** One row per (connection, secret name), one column per caller. */
function buildMatrix(secrets: readonly AdminSecret[]): Matrix {
  const callers = new Set<string>();
  const byConnection = new Map<string, Map<string, SecretRow>>();
  const requiredByConnection = new Map<string, AdminSecret[]>();

  for (const s of secrets) {
    callers.add(s.callerAlias);
    let rows = byConnection.get(s.connection);
    if (!rows) byConnection.set(s.connection, (rows = new Map()));
    let row = rows.get(s.name);
    if (!row) {
      row = { name: s.name, required: false, cells: new Map(), missingRequired: false };
      rows.set(s.name, row);
    }
    // If a name is required for any caller, the row is a required one.
    row.required ||= s.required;
    row.cells.set(s.callerAlias, { required: s.required, present: s.present });
    if (s.required && !s.present) row.missingRequired = true;
    if (s.required) {
      const list = requiredByConnection.get(s.connection) ?? [];
      list.push(s);
      requiredByConnection.set(s.connection, list);
    }
  }

  const groups: ConnectionGroup[] = [...byConnection.entries()]
    .map(([connection, rows]) => ({
      connection,
      rows: [...rows.values()].sort((a, b) =>
        a.required !== b.required ? (a.required ? -1 : 1) : a.name.localeCompare(b.name),
      ),
      required: countRequiredSecrets(requiredByConnection.get(connection) ?? []),
    }))
    .sort((a, b) => a.connection.localeCompare(b.connection));

  return { callers: [...callers].sort((a, b) => a.localeCompare(b)), groups };
}

// ── View ─────────────────────────────────────────────────────────────────

function Legend() {
  return (
    <ul className="dl-matrix-legend" aria-label="Legend">
      <li>
        <Mark kind="set" /> Set
      </li>
      <li>
        <Mark kind="missing" /> Required, missing
      </li>
      <li>
        <Mark kind="unset" /> Optional, not set
      </li>
      <li>
        <Mark kind="unused" /> Caller doesn't use it
      </li>
    </ul>
  );
}

function MatrixTable({ matrix, onlyMissing }: { matrix: Matrix; onlyMissing: boolean }) {
  const groups = onlyMissing
    ? matrix.groups
        .map((g) => ({ ...g, rows: g.rows.filter((r) => r.missingRequired) }))
        .filter((g) => g.rows.length > 0)
    : matrix.groups;

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 size={20} />}
        title="All required secrets are set"
        body="Every caller has every required secret configured."
      />
    );
  }

  const span = matrix.callers.length + 1;
  return (
    <div className="data-table-wrap dl-matrix-wrap">
      <table className="data-table dl-matrix-table">
        <thead>
          <tr>
            <th scope="col" className="dl-matrix-name">
              Secret
            </th>
            {matrix.callers.map((alias) => (
              <CallerHeader key={alias} alias={alias} />
            ))}
          </tr>
        </thead>
        {groups.map((group) => (
          <tbody key={group.connection}>
            <tr className="dl-matrix-group">
              <th colSpan={span} scope="colgroup">
                <div className="dl-matrix-group-inner">
                  <span className="mono dl-matrix-group-name">{group.connection}</span>
                  <span className="dl-matrix-group-meta">
                    {group.required.total === 0
                      ? "optional only"
                      : `${group.required.present} of ${group.required.total} required set`}
                  </span>
                </div>
              </th>
            </tr>
            {group.rows.map((row) => (
              <tr key={row.name}>
                <th scope="row" className="dl-matrix-name">
                  <span className={`mono ${row.required ? "" : "dl-matrix-optional-name"}`}>
                    {breakAfterUnderscores(row.name)}
                  </span>
                  {!row.required && <span className="dl-matrix-optional-tag">optional</span>}
                </th>
                {matrix.callers.map((alias) => (
                  <td key={alias} className="dl-matrix-cell">
                    <CellMark cell={row.cells.get(alias)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** A caller column's header. The alias is clamped to a few lines so one long
 *  alias can't make the header band tall. A clamped one becomes a button that
 *  shows it in full: the title tooltip alone can't be reached on touch. */
function CallerHeader({ alias }: { alias: string }) {
  const thRef = useRef<HTMLTableCellElement>(null);
  const [clamped, setClamped] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const th = thRef.current;
    if (!th || open) return;
    // The name span is re-created when it moves into the button, so look it
    // up at each measure; the cell itself is stable.
    const measure = () => {
      const el = th.querySelector<HTMLElement>(".dl-matrix-caller-name");
      if (el) setClamped(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(th);
    return () => ro.disconnect();
  }, [alias, open]);

  const name = (
    <span className={`mono dl-matrix-caller-name${open ? " is-open" : ""}`}>{alias}</span>
  );
  return (
    <th ref={thRef} scope="col" className="dl-matrix-caller" title={alias}>
      {clamped || open ? (
        <button
          type="button"
          className="dl-matrix-caller-toggle"
          aria-expanded={open}
          onClick={() => setOpen((x) => !x)}
        >
          {name}
        </button>
      ) : (
        name
      )}
    </th>
  );
}

function CellMark({ cell }: { cell: Cell }) {
  if (!cell) return <Mark kind="unused" label="not used" />;
  if (cell.present) return <Mark kind="set" label="set" />;
  return cell.required ? (
    <Mark kind="missing" label="missing" />
  ) : (
    <Mark kind="unset" label="not set" />
  );
}

/** SLACK_BOT_TOKEN → SLACK_<wbr>BOT_<wbr>TOKEN: a narrow column wraps it
 *  between words instead of mid-word. */
function breakAfterUnderscores(name: string) {
  const parts = name.split("_");
  return parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 && (
        <>
          _<wbr />
        </>
      )}
    </Fragment>
  ));
}

const MARK_GLYPH = { set: "✓", missing: "✗", unset: "○", unused: "—" } as const;

/** The glyph is decorative; the label is screen-reader text (a span's
 *  aria-label is ignored). */
function Mark({ kind, label }: { kind: keyof typeof MARK_GLYPH; label?: string }) {
  return (
    <>
      <span className={`dl-matrix-mark is-${kind}`} aria-hidden="true">
        {MARK_GLYPH[kind]}
      </span>
      {label && <span className="sr-only">{label}</span>}
    </>
  );
}
