import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Check, Copy, Plus, Trash2, Users } from "lucide-react";
import type { AdminCaller } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import ConfirmDialog from "../components/ConfirmDialog";
import DaemonOffline from "../components/DaemonOffline";
import EmptyState, { LoadingState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { useIsMobile } from "../hooks/useIsMobile";
import { copyText } from "../utils/clipboard";
import "./CallerList.css";

type FetchState =
  | { status: "loading" }
  | { status: "ok"; callers: AdminCaller[] }
  | { status: "error"; message: string };

const FINGERPRINT_PREVIEW_LEN = 12;
const CALLER_ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export default function CallerList() {
  const { daemon } = useDaemon();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const toast = useToast();
  const [state, setState] = useState<FetchState>({ status: "loading" });

  // Create-caller UI state.
  const [showNewCaller, setShowNewCaller] = useState(false);
  const [newAlias, setNewAlias] = useState("");
  const [newName, setNewName] = useState("");
  const [newCallerError, setNewCallerError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Delete-caller UI state.
  const [confirmDeleteAlias, setConfirmDeleteAlias] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Focus after the delete dialog: back to the trash button on Cancel; to
  // "New caller" once the row (and its button) is gone.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const newCallerRef = useRef<HTMLButtonElement>(null);

  const refetch = useCallback(async () => {
    const res = await api.callers();
    if (isDaemonDown(res)) {
      setState({ status: "error", message: res.error });
      return;
    }
    setState({ status: "ok", callers: res });
  }, []);

  useEffect(() => {
    if (daemon !== "up") return;
    let cancelled = false;
    (async () => {
      const res = await api.callers();
      if (cancelled) return;
      if (isDaemonDown(res)) {
        setState({ status: "error", message: res.error });
        return;
      }
      setState({ status: "ok", callers: res });
    })();
    return () => {
      cancelled = true;
    };
  }, [daemon]);

  const resetCreate = () => {
    if (creating) return;
    setShowNewCaller(false);
    setNewAlias("");
    setNewName("");
    setNewCallerError(null);
  };

  const handleCreate = async () => {
    if (creating || daemon === "down") return;
    const alias = newAlias.trim();
    if (!alias) {
      setNewCallerError("Alias is required.");
      return;
    }
    if (!CALLER_ALIAS_RE.test(alias)) {
      setNewCallerError(
        "Use letters, numbers, dashes or underscores, starting with a letter or number.",
      );
      return;
    }
    setNewCallerError(null);
    setCreating(true);
    const name = newName.trim();
    const res = await api.createCaller(alias, name || undefined);
    setCreating(false);
    if (!res.ok) {
      setNewCallerError(res.error);
      return;
    }
    setShowNewCaller(false);
    setNewAlias("");
    setNewName("");
    toast.show(
      <>
        Created caller <Link to={`/callers/${encodeURIComponent(alias)}`}>{alias}</Link>
      </>,
    );
    await refetch();
  };

  const handleConfirmDelete = async () => {
    if (!confirmDeleteAlias) return;
    setDeleting(true);
    setDeleteError(null);
    const res = await api.deleteCaller(confirmDeleteAlias);
    setDeleting(false);
    if (!res.ok) {
      setDeleteError(res.error);
      return;
    }
    toast.show(`Deleted caller ${confirmDeleteAlias}`);
    if (newCallerRef.current) returnFocusRef.current = newCallerRef.current;
    setConfirmDeleteAlias(null);
    await refetch();
  };

  const askDelete = (alias: string, trigger: HTMLElement) => {
    returnFocusRef.current = trigger;
    setDeleteError(null);
    setConfirmDeleteAlias(alias);
  };

  // Offline before anything loaded: just the banner. Once loaded, the list
  // (and a half-typed new caller) stays under the banner.
  if (daemon === "down" && state.status !== "ok") {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Callers</h1>
        </header>
        <DaemonOffline action="load callers" />
      </>
    );
  }

  const callers = state.status === "ok" ? state.callers : [];
  // The Source column only earns its space when some caller has one.
  const showSource = callers.some((c) => c.source !== null);
  const openNew = () => setShowNewCaller(true);

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Callers</h1>
          <div className="page-subtitle">
            Registered callers from <code>remote.config.json</code>
            {state.status === "ok" && callers.length > 0 && (
              <>
                {" "}
                · {callers.length} caller{callers.length === 1 ? "" : "s"}
              </>
            )}
          </div>
        </div>
        {!showNewCaller && callers.length > 0 && (
          <button ref={newCallerRef} type="button" className="btn btn-primary" onClick={openNew}>
            <Plus size={14} aria-hidden="true" />
            New caller
          </button>
        )}
      </header>

      {daemon === "down" && <DaemonOffline action="manage callers" />}

      {showNewCaller && (
        <form
          className="dl-callers-newcaller"
          aria-label="New caller"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void handleCreate();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              resetCreate();
            }
          }}
        >
          <div className="dl-callers-newcaller-field">
            <label className="field-label" htmlFor="dl-new-caller-alias">
              Alias
            </label>
            <input
              id="dl-new-caller-alias"
              type="text"
              className="input mono"
              placeholder="alias"
              value={newAlias}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              aria-invalid={newCallerError !== null}
              aria-describedby="dl-new-caller-msg"
              onChange={(e) => {
                setNewAlias(e.target.value);
                setNewCallerError(null);
              }}
            />
          </div>
          <div className="dl-callers-newcaller-field">
            <label className="field-label" htmlFor="dl-new-caller-name">
              Name <span className="dl-callers-optional">(optional)</span>
            </label>
            <input
              id="dl-new-caller-name"
              type="text"
              className="input"
              placeholder="name (optional)"
              value={newName}
              autoComplete="off"
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="dl-callers-newcaller-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={creating || daemon === "down"}
            >
              {creating && <span className="spinner" aria-hidden="true" />}
              {creating ? "Creating…" : "Create caller"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={creating}
              onClick={resetCreate}
            >
              Cancel
            </button>
          </div>
          <div id="dl-new-caller-msg" className="dl-callers-newcaller-msg">
            {newCallerError ? (
              <span className="dl-callers-newcaller-error" role="alert">
                {newCallerError}
              </span>
            ) : (
              <span className="cell-muted">
                Letters, numbers, dashes or underscores. The agent uses it as{" "}
                <code>MCP_KEY_ALIAS</code>.
              </span>
            )}
          </div>
        </form>
      )}

      {state.status === "loading" && <LoadingState label="Loading callers…" />}

      {state.status === "error" && (
        <div className="banner banner-offline" role="alert">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load callers: {state.message}</span>
        </div>
      )}

      {state.status === "ok" && callers.length === 0 && !showNewCaller && (
        <EmptyState
          icon={<Users size={20} />}
          title="No callers yet"
          body={
            <>
              A caller is one agent&apos;s identity. Create one, then open it to{" "}
              <strong>Issue credentials</strong> for a callboard instance.
            </>
          }
          action={
            <button type="button" className="btn btn-primary" onClick={openNew}>
              <Plus size={14} aria-hidden="true" />
              New caller
            </button>
          }
        />
      )}

      {callers.length > 0 && !isMobile && (
        <div className="data-table-wrap">
          <table className="data-table dl-callers-table">
            <thead>
              <tr>
                <th>Alias</th>
                <th>Name</th>
                <th className="num">Connections</th>
                {showSource && <th>Source</th>}
                <th>Fingerprint</th>
                <th>Keys</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {callers.map((c) => (
                <tr
                  key={c.alias}
                  className="data-table-row-clickable"
                  onClick={(e) => {
                    // The alias link handles its own click (and middle-click).
                    if ((e.target as HTMLElement).closest("a, button")) return;
                    // Selecting text in the row (to copy a name) isn't a click.
                    if (window.getSelection()?.toString()) return;
                    navigate(`/callers/${encodeURIComponent(c.alias)}`);
                  }}
                >
                  <td className="dl-callers-alias-cell">
                    <Link
                      to={`/callers/${encodeURIComponent(c.alias)}`}
                      className="cell-primary mono dl-callers-alias"
                    >
                      {c.alias}
                    </Link>
                  </td>
                  <td>{c.name ?? <span className="cell-muted">—</span>}</td>
                  <td className="num">{c.connections.length}</td>
                  {showSource && (
                    <td>
                      {c.source ? (
                        <SourceBadge source={c.source} />
                      ) : (
                        <span className="cell-muted">—</span>
                      )}
                    </td>
                  )}
                  <td>
                    <Fingerprint value={c.fingerprint} short />
                  </td>
                  <td>
                    <KeysDirBadge exists={c.keysDirExists} />
                  </td>
                  <td className="dl-callers-action-cell">
                    {c.alias !== "default" && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm dl-callers-del-btn"
                        title={`Delete caller ${c.alias}`}
                        aria-label={`Delete caller ${c.alias}`}
                        onClick={(e) => askDelete(c.alias, e.currentTarget)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {callers.length > 0 && isMobile && (
        <ul className="mobile-card-list dl-callers-cards" aria-label="Callers">
          {callers.map((c) => (
            <li key={c.alias} className="mobile-card">
              <div className="mobile-card-header">
                <Link
                  to={`/callers/${encodeURIComponent(c.alias)}`}
                  className="mobile-card-title dl-callers-card-link"
                >
                  <span className="dl-callers-card-name">{c.name ?? c.alias}</span>
                  {c.name && <span className="cell-secondary mono">{c.alias}</span>}
                </Link>
                {c.alias !== "default" && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon dl-callers-del-btn"
                    aria-label={`Delete caller ${c.alias}`}
                    onClick={(e) => askDelete(c.alias, e.currentTarget)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div className="mobile-card-meta">
                <KeysDirBadge exists={c.keysDirExists} long />
                {c.source && <SourceBadge source={c.source} />}
                <span className="cell-muted">
                  {c.connections.length} connection{c.connections.length === 1 ? "" : "s"}
                </span>
              </div>
              {c.fingerprint && (
                <div className="dl-callers-card-fp">
                  <Fingerprint value={c.fingerprint} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {confirmDeleteAlias && (
        <ConfirmDialog
          title={`Delete caller "${confirmDeleteAlias}"?`}
          confirmLabel="Delete caller"
          description={
            <>
              This removes <code>{confirmDeleteAlias}</code>, its enabled connections, its vault
              items, and its public-key entry in <code>remote.config.json</code>. Any active
              sessions for this caller will be dropped. This cannot be undone.
            </>
          }
          busy={deleting}
          error={deleteError}
          returnFocusRef={returnFocusRef}
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            if (deleting) return;
            setConfirmDeleteAlias(null);
            setDeleteError(null);
          }}
        />
      )}
    </>
  );
}

/** Whether the caller's key directory exists. `long` reads "Keys OK". */
export function KeysDirBadge({ exists, long = false }: { exists: boolean; long?: boolean }) {
  const text = exists ? "OK" : "Missing";
  return (
    <span
      className={`badge ${exists ? "badge-success" : "badge-danger"}`}
      title={exists ? "The caller's key directory exists" : "The caller's key directory is missing"}
    >
      {long ? `Keys ${text.toLowerCase()}` : text}
    </span>
  );
}

/** How the caller's keys were provisioned. Renders nothing when unknown. */
export function SourceBadge({ source }: { source: AdminCaller["source"] }) {
  if (!source) return null;
  return (
    <span
      className={`badge ${source === "local-auto" ? "badge-success" : "badge-info"}`}
      title={
        source === "local-auto"
          ? "Shared with a co-located callboard over the filesystem"
          : "Issued as a downloadable credential bundle"
      }
    >
      {source}
    </span>
  );
}

/** A caller fingerprint, optionally shortened, with a copy button. */
export function Fingerprint({ value, short = false }: { value: string | null; short?: boolean }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);
  if (!value) return <span className="cell-muted">—</span>;
  const shown =
    short && value.length > FINGERPRINT_PREVIEW_LEN
      ? `${value.slice(0, FINGERPRINT_PREVIEW_LEN)}…`
      : value;
  const copy = async () => {
    if (await copyText(value)) setCopied(true);
    // The table shows a shortened fingerprint, so the toast carries the
    // whole one, selectable, for copying by hand.
    else
      toast.show(
        <>
          Couldn&apos;t copy. Select it here instead:{" "}
          <span className="mono dl-callers-fp-full">{value}</span>
        </>,
        { kind: "error" },
      );
  };
  return (
    <span className="dl-callers-fp">
      <span className={`mono dl-callers-fp-text${short ? "" : " is-full"}`} title={value}>
        {shown}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm dl-callers-fp-copy"
        aria-label={copied ? "Fingerprint copied" : "Copy fingerprint"}
        title={copied ? "Copied" : "Copy fingerprint"}
        onClick={() => void copy()}
      >
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </button>
    </span>
  );
}
