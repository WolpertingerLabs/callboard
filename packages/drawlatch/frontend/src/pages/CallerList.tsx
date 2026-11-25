import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import type { AdminCaller } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import ConfirmDialog from "../components/ConfirmDialog";
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
  const [state, setState] = useState<FetchState>({ status: "loading" });

  // Create-caller UI state.
  const [showNewCaller, setShowNewCaller] = useState(false);
  const [newAlias, setNewAlias] = useState("");
  const [newName, setNewName] = useState("");
  const [newCallerError, setNewCallerError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Delete-caller UI state.
  const [confirmDeleteAlias, setConfirmDeleteAlias] = useState<string | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
    setShowNewCaller(false);
    setNewAlias("");
    setNewName("");
    setNewCallerError(null);
  };

  const handleCreate = async () => {
    const alias = newAlias.trim();
    if (!alias) {
      setNewCallerError("Alias is required");
      return;
    }
    if (!CALLER_ALIAS_RE.test(alias)) {
      setNewCallerError(
        "Use letters, numbers, dashes or underscores (must start alphanumeric)",
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
    resetCreate();
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
    setConfirmDeleteAlias(null);
    await refetch();
  };

  if (daemon === "down") {
    return (
      <>
        <header className="page-header">
          <h1 className="page-title">Callers</h1>
        </header>
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            Drawlatch daemon is not reachable. Start it with{" "}
            <code>drawlatch start</code> to load callers.
          </span>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Callers</h1>
          <div className="page-subtitle">
            Registered callers from <code>remote.config.json</code>
          </div>
        </div>
        <div className="dl-callers-header-right">
          {state.status === "ok" && (
            <span className="page-subtitle">
              {state.callers.length} caller
              {state.callers.length === 1 ? "" : "s"}
            </span>
          )}
          {!showNewCaller && (
            <button
              type="button"
              className="dl-callers-new-btn"
              onClick={() => setShowNewCaller(true)}
            >
              <Plus size={14} />
              New caller
            </button>
          )}
        </div>
      </header>

      {showNewCaller && (
        <div className="dl-callers-newcaller">
          <input
            type="text"
            className="dl-callers-newcaller-input mono"
            placeholder="alias"
            value={newAlias}
            autoFocus
            onChange={(e) => {
              setNewAlias(e.target.value);
              setNewCallerError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
              if (e.key === "Escape") resetCreate();
            }}
          />
          <input
            type="text"
            className="dl-callers-newcaller-input"
            placeholder="name (optional)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
              if (e.key === "Escape") resetCreate();
            }}
          />
          <button
            type="button"
            className="dl-callers-newcaller-add"
            disabled={creating}
            onClick={() => void handleCreate()}
          >
            {creating ? "Creating…" : "Create caller"}
          </button>
          <button
            type="button"
            className="dl-callers-newcaller-cancel"
            disabled={creating}
            onClick={resetCreate}
          >
            Cancel
          </button>
          {newCallerError && (
            <div className="dl-callers-newcaller-error">{newCallerError}</div>
          )}
        </div>
      )}

      {state.status === "loading" && (
        <div className="banner banner-loading">Loading callers…</div>
      )}

      {state.status === "error" && (
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load callers: {state.message}</span>
        </div>
      )}

      {state.status === "ok" && state.callers.length === 0 && (
        <div className="placeholder">
          <span className="placeholder-title">No callers registered</span>
          <span>
            Use <strong>New caller</strong> above, then open it to{" "}
            <strong>Issue credentials</strong> for a callboard instance.
          </span>
        </div>
      )}

      {state.status === "ok" && state.callers.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Alias</th>
                <th>Name</th>
                <th className="num">Connections</th>
                <th>Source</th>
                <th>Fingerprint</th>
                <th>Keys dir</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {state.callers.map((c) => (
                <tr
                  key={c.alias}
                  className="data-table-row-clickable"
                  onClick={() => navigate(`/callers/${c.alias}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/callers/${c.alias}`);
                    }
                  }}
                  tabIndex={0}
                  role="link"
                >
                  <td>
                    <div className="cell-primary mono">{c.alias}</div>
                  </td>
                  <td>
                    {c.name ?? <span className="cell-muted">—</span>}
                  </td>
                  <td className="num">{c.connections.length}</td>
                  <td>
                    <SourceBadge source={c.source} />
                  </td>
                  <td>
                    {c.fingerprint ? (
                      <span className="mono" title={c.fingerprint}>
                        {c.fingerprint.slice(0, FINGERPRINT_PREVIEW_LEN)}
                        {c.fingerprint.length > FINGERPRINT_PREVIEW_LEN ? "…" : ""}
                      </span>
                    ) : (
                      <span className="cell-muted">—</span>
                    )}
                  </td>
                  <td>
                    <KeysDirBadge exists={c.keysDirExists} />
                  </td>
                  <td className="dl-callers-action-cell">
                    {c.alias !== "default" && (
                      <button
                        type="button"
                        className="dl-callers-del-btn"
                        title={`Delete "${c.alias}"`}
                        aria-label={`Delete caller ${c.alias}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteError(null);
                          setConfirmDeleteAlias(c.alias);
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {confirmDeleteAlias && (
        <ConfirmDialog
          title={`Delete caller "${confirmDeleteAlias}"?`}
          description={
            <>
              This removes <code>{confirmDeleteAlias}</code>, its enabled
              connections, and its public-key entry in{" "}
              <code>remote.config.json</code>. Any active sessions for this
              caller will be dropped. This cannot be undone.
            </>
          }
          busy={deleting}
          error={deleteError}
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

export function KeysDirBadge({ exists }: { exists: boolean }) {
  return (
    <span
      className={`keys-dir-badge keys-dir-${exists ? "ok" : "missing"}`}
    >
      {exists ? "ok" : "missing"}
    </span>
  );
}

export function SourceBadge({
  source,
}: {
  source: AdminCaller["source"];
}) {
  if (!source) {
    return <span className="cell-muted">—</span>;
  }
  return (
    <span className={`dl-source-badge dl-source-${source}`}>{source}</span>
  );
}
