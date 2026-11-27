import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowRight, KeyRound, PlugZap, RotateCcw, Trash2, UserX } from "lucide-react";
import type {
  AdminCaller,
  AdminCallerConnection,
  AdminSecretRef,
} from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import { Fingerprint, KeysDirBadge, SourceBadge } from "./CallerList";
import IssueCredentialsModal from "../components/IssueCredentialsModal";
import ConfirmDialog from "../components/ConfirmDialog";
import DaemonOffline from "../components/DaemonOffline";
import EmptyState, { LoadingState } from "../components/EmptyState";
import { useToast } from "../components/Toast";
import { AuthSummary } from "../components/AuthSummary";

type FetchState =
  | { status: "loading" }
  | { status: "not-found" }
  | {
      status: "ok";
      caller: AdminCaller;
      connections: AdminCallerConnection[];
    }
  | { status: "error"; message: string };

/**
 * Keyed by alias, so moving from one caller's page to another's (back/forward,
 * an edited URL) starts from scratch. Otherwise B's page would begin with A's
 * loaded state, and if loading B failed, the failed-refresh path would keep
 * showing A while every action (delete, agent permissions) went to B.
 */
export default function CallerDetail() {
  const { alias } = useParams<{ alias: string }>();
  return <CallerDetailPage key={alias} alias={alias} />;
}

function CallerDetailPage({ alias }: { alias: string | undefined }) {
  const { daemon } = useDaemon();
  const navigate = useNavigate();
  const toast = useToast();
  const [state, setState] = useState<FetchState>({ status: "loading" });

  // Credential-lifecycle UI state.
  const [templates, setTemplates] = useState<string[]>([]);
  const [templatesError, setTemplatesError] = useState(false);
  const [defaultEndpoint, setDefaultEndpoint] = useState<string>(window.location.origin);
  // The caller the issue dialog was opened for. A snapshot, so the dialog
  // (and a one-time bundle it may be showing) survives anything that
  // changes what the page itself renders: a failed refresh, the daemon
  // going offline, the caller disappearing.
  const [issueFor, setIssueFor] = useState<AdminCaller | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [selfManageSaving, setSelfManageSaving] = useState(false);
  const [selfManageError, setSelfManageError] = useState<string | null>(null);

  const loadedRef = useRef(false);
  loadedRef.current = state.status === "ok";

  /** A refresh that fails after the page has loaded keeps what's on screen
   *  and says so, rather than replacing the page with an error. */
  const fail = useCallback(
    (message: string) => {
      if (loadedRef.current) toast.show(`Couldn't refresh this caller: ${message}`, { kind: "error" });
      else setState({ status: "error", message });
    },
    [toast],
  );

  const load = useCallback(async () => {
    if (!alias) return;
    const callersRes = await api.callers();
    if (isDaemonDown(callersRes)) {
      fail(callersRes.error);
      return;
    }
    const caller = callersRes.find((c) => c.alias === alias);
    if (!caller) {
      setState({ status: "not-found" });
      return;
    }
    const connsRes = await api.callerConnections(alias);
    if (isDaemonDown(connsRes)) {
      fail(connsRes.error);
      return;
    }
    setState({ status: "ok", caller, connections: connsRes });
  }, [alias, fail]);

  useEffect(() => {
    if (!alias) return;
    if (daemon !== "up") return;
    void load();
  }, [alias, daemon, load]);

  // Load connection templates (for the issue modal) and the default endpoint.
  useEffect(() => {
    if (daemon !== "up") return;
    let cancelled = false;
    (async () => {
      const [tplRes, metaRes] = await Promise.all([api.connections(), api.meta()]);
      if (cancelled) return;
      if (isDaemonDown(tplRes)) {
        setTemplatesError(true);
      } else {
        setTemplatesError(false);
        setTemplates(tplRes.map((t) => t.alias));
      }
      if (!isDaemonDown(metaRes) && metaRes.tunnelUrl) {
        setDefaultEndpoint(metaRes.tunnelUrl);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [daemon]);

  const handleSelfManage = async (enabled: boolean) => {
    if (!alias || selfManageSaving) return;
    setSelfManageSaving(true);
    setSelfManageError(null);
    const res = await api.setCallerSelfManage(alias, enabled);
    setSelfManageSaving(false);
    if (!res.ok) {
      setSelfManageError(res.error);
      return;
    }
    toast.show(
      enabled
        ? "The agent can now manage its own connections and secrets"
        : "Only this dashboard can change this caller's connections and secrets now",
    );
    await load();
  };

  const handleDelete = async () => {
    if (!alias) return;
    setDeleting(true);
    setDeleteError(null);
    const res = await api.deleteCaller(alias);
    setDeleting(false);
    if (!res.ok) {
      setDeleteError(res.error);
      return;
    }
    toast.show(`Deleted caller ${alias}`);
    navigate("/callers");
  };

  const issueModal = issueFor && (
    <IssueCredentialsModal
      alias={issueFor.alias}
      callerConnections={issueFor.connections}
      availableConnections={[...new Set([...templates, ...issueFor.connections])]}
      connectionsIncomplete={templatesError}
      defaultEndpoint={defaultEndpoint}
      isRotation={issueFor.source !== null}
      onClose={() => setIssueFor(null)}
      onIssued={() => void load()}
    />
  );

  // Every branch renders the issue dialog: see `issueFor`.
  return (
    <>
      {renderPage()}
      {issueModal}
    </>
  );

  function renderPage() {
    // Offline before the first load: nothing to show yet. Once loaded, the page
    // stays (stale) under the banner, so nothing open on it is thrown away.
    if (daemon === "down" && state.status !== "ok") {
      return (
        <>
          <BackLink />
          <header className="page-header">
            <h1 className="page-title">{alias}</h1>
          </header>
          <DaemonOffline action="load this caller" />
        </>
      );
    }

    if (state.status === "loading") {
      return (
        <>
          <BackLink />
          <LoadingState label="Loading caller…" />
        </>
      );
    }

    if (state.status === "error") {
      return (
        <>
          <BackLink />
          <div className="banner banner-offline" role="alert">
            <span className="status-dot down" aria-hidden="true" />
            <span>Failed to load caller: {state.message}</span>
          </div>
        </>
      );
    }

    if (state.status === "not-found") {
      return (
        <>
          <BackLink />
          <EmptyState
            icon={<UserX size={20} />}
            title={`No caller named "${alias}"`}
            body="It may have been deleted, or the link has a typo."
            action={
              <Link to="/callers" className="btn btn-secondary">
                Back to callers
              </Link>
            }
          />
        </>
      );
    }

    const { caller, connections } = state;

    return (
      <>
        <BackLink />
        <header className="page-header">
          <div style={{ minWidth: 0 }}>
            <div className="title-row">
              <h1 className="page-title">{caller.name ?? caller.alias}</h1>
              <KeysDirBadge exists={caller.keysDirExists} long />
              <SourceBadge source={caller.source} />
            </div>
            <div className="subtitle-meta">
              {caller.name && <span className="mono">{caller.alias}</span>}
              {caller.fingerprint && (
                <>
                  {caller.name && (
                    <span className="dot-sep" aria-hidden="true">
                      ·
                    </span>
                  )}
                  <span className="dl-caller-fp-row">
                    <span className="sr-only">Ed25519 public key fingerprint: </span>
                    <Fingerprint value={caller.fingerprint} />
                  </span>
                </>
              )}
            </div>
          </div>
        </header>

        {daemon === "down" && <DaemonOffline action="refresh this caller" />}

        {caller.configProblem && (
          // The caller can't be resolved at all (say, a connection that is
          // neither a template nor a connector): its handshakes fail.
          <div className="banner banner-offline" role="alert">
            <span className="status-dot down" aria-hidden="true" />
            <span>
              This caller&apos;s config can&apos;t be loaded, so its agent can&apos;t connect:{" "}
              {caller.configProblem}
            </span>
          </div>
        )}

        <section className="detail-section">
          <h2 className="section-title">Credentials</h2>
          <div className="dl-cred-lifecycle">
            <p className="detail-note">
              {caller.source === "local-auto" ? (
                <>
                  Auto-shared to a co-located callboard over the filesystem (
                  <code>local-auto</code>). Issuing here mints a fresh keypair and hands back a
                  downloadable bundle instead.
                </>
              ) : caller.source === "bundle-issued" ? (
                <>
                  Credentials were issued as a downloadable bundle. Drawlatch holds only the public
                  key. Rotate to mint a fresh keypair, or delete the caller to end its access.
                </>
              ) : (
                <>
                  No credential bundle has been issued from Drawlatch for this caller yet. Issue one
                  to hand a callboard instance its identity.
                </>
              )}
            </p>
            <div className="dl-cred-actions">
              <button type="button" className="btn btn-primary" onClick={() => setIssueFor(caller)}>
                {caller.source ? (
                  <>
                    <RotateCcw size={14} aria-hidden="true" />
                    Rotate credentials
                  </>
                ) : (
                  <>
                    <KeyRound size={14} aria-hidden="true" />
                    Issue credentials
                  </>
                )}
              </button>
              {caller.alias !== "default" && (
                <button
                  type="button"
                  className="btn btn-danger-outline"
                  onClick={() => {
                    setDeleteError(null);
                    setConfirmDelete(true);
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                  Delete caller
                </button>
              )}
            </div>
          </div>
        </section>

        <section className="detail-section">
          <h2 className="section-title">Vault</h2>
          {caller.vaultItems === null ? (
            <p className="detail-note">
              The vault can&apos;t be read right now.{" "}
              <Link to={`/vault?caller=${encodeURIComponent(caller.alias)}`}>Open the vault</Link>{" "}
              for details.
            </p>
          ) : (
            <Link
              to={`/vault?caller=${encodeURIComponent(caller.alias)}`}
              className="dl-caller-vault-link"
            >
              {caller.vaultItems} item{caller.vaultItems === 1 ? "" : "s"} · Open vault
              <ArrowRight size={14} aria-hidden="true" />
            </Link>
          )}
        </section>

        <section className="detail-section">
          <h2 className="section-title">Agent permissions</h2>
          <label className={`dl-caller-self-manage${selfManageSaving ? " is-saving" : ""}`}>
            <input
              type="checkbox"
              checked={caller.selfManage}
              disabled={selfManageSaving}
              onChange={(e) => void handleSelfManage(e.target.checked)}
            />
            <span>
              Let this caller&apos;s agent enable connections and set its own secrets (
              <code>set_connection_enabled</code>, <code>set_secrets</code>)
            </span>
          </label>
          <p className="detail-note" style={{ marginTop: 8, marginBottom: 0 }}>
            When off, only this dashboard can change the caller&apos;s connections and secrets. An
            agent that can enable connections for itself can pick up any existing secret that a
            newly enabled connection shares by name.
          </p>
          {selfManageError && (
            <div className="modal-error dl-caller-error" role="alert">
              Couldn&apos;t save: {selfManageError}
            </div>
          )}
        </section>

        <section className="detail-section">
          <h2 className="section-title">Connections ({connections.length})</h2>
          {connections.length === 0 ? (
            <EmptyState
              compact
              icon={<PlugZap size={20} />}
              title="No connections enabled"
              body="This caller's agent can't reach any API yet."
              action={
                <Link to="/connections" className="btn btn-secondary">
                  Go to Connections
                </Link>
              }
            />
          ) : (
            // Cards below 1024px, the table above (CSS picks one): the table
            // needs ~1000px, more than a tablet has next to the sidebar.
            <>
              <ul className="mobile-card-list dl-caller-conn-cards" aria-label="Connections">
                {connections.map((c) => (
                  <li key={c.connectionAlias} className="mobile-card dl-caller-conn-card">
                    <div className="mobile-card-header">
                      <div className="mobile-card-title mono">{c.connectionAlias}</div>
                      <div className="badge-row">
                        <EnabledBadge enabled={c.enabled} />
                        {c.isCustom && <span className="badge badge-info">Custom</span>}
                      </div>
                    </div>
                    {(c.auth || c.problem) && (
                      <AuthSummary callerAuth={c.auth} problem={c.problem} compact />
                    )}
                    <dl className="mobile-card-kv">
                      <div className="mobile-card-kv-row">
                        <dt>Required</dt>
                        <dd>
                          <SecretRefList secrets={c.requiredSecrets} emptyText="—" />
                        </dd>
                      </div>
                      <div className="mobile-card-kv-row">
                        <dt>Optional</dt>
                        <dd>
                          <SecretRefList secrets={c.optionalSecrets} emptyText="—" />
                        </dd>
                      </div>
                      <div className="mobile-card-kv-row">
                        <dt>Listener</dt>
                        <dd>
                          {!c.hasIngestor
                            ? "—"
                            : c.instances.length === 0
                              ? "Yes"
                              : `Yes · ${c.instances.length} instance${c.instances.length === 1 ? "" : "s"}`}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
              <div className="data-table-wrap dl-caller-conn-table">
                <table className="data-table dl-caller-conns">
                  <thead>
                    <tr>
                      <th>Connection</th>
                      <th>Status</th>
                      <th>Auth</th>
                      <th>Required secrets</th>
                      <th>Optional secrets</th>
                      <th>Listener</th>
                    </tr>
                  </thead>
                  <tbody>
                    {connections.map((c) => (
                      <tr key={c.connectionAlias}>
                        <td>
                          <div className="cell-primary mono">{c.connectionAlias}</div>
                        </td>
                        <td>
                          <div className="badge-row">
                            <EnabledBadge enabled={c.enabled} />
                            {c.isCustom && <span className="badge badge-info">Custom</span>}
                          </div>
                        </td>
                        <td className={c.auth || c.problem ? "dl-caller-auth" : undefined}>
                          <AuthSummary callerAuth={c.auth} problem={c.problem} compact />
                        </td>
                        <td>
                          <SecretRefList secrets={c.requiredSecrets} emptyText="—" />
                        </td>
                        <td>
                          <SecretRefList secrets={c.optionalSecrets} emptyText="—" />
                        </td>
                        <td className="dl-caller-listener">
                          {c.hasIngestor ? (
                            <>
                              <span className="tag">Yes</span>
                              {c.instances.length > 0 && (
                                <div className="cell-secondary">
                                  {c.instances.length} instance{c.instances.length === 1 ? "" : "s"}
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="cell-muted">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        {confirmDelete && (
          <ConfirmDialog
            title={`Delete caller "${caller.alias}"?`}
            confirmLabel="Delete caller"
            description={
              <>
                This deletes <code>{caller.alias}</code>, its vault items, and its public-key entry,
                so it can no longer authenticate. Any active sessions are dropped. This cannot be
                undone.
              </>
            }
            busy={deleting}
            error={deleteError}
            onConfirm={handleDelete}
            onCancel={() => {
              if (deleting) return;
              setConfirmDelete(false);
              setDeleteError(null);
            }}
          />
        )}
      </>
    );
  }
}

function BackLink() {
  return (
    <Link to="/callers" className="back-link">
      ← Back to callers
    </Link>
  );
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <span className={`badge ${enabled ? "badge-success" : "badge-muted"}`}>
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}

function SecretRefList({ secrets, emptyText }: { secrets: AdminSecretRef[]; emptyText: string }) {
  if (secrets.length === 0) {
    return <span className="cell-muted">{emptyText}</span>;
  }
  return (
    <ul className="secret-ref-list">
      {secrets.map((s) => (
        <li
          key={s.name}
          className={`secret-ref-pill mono secret-ref-${s.present ? "present" : "missing"}`}
        >
          <span className="secret-ref-mark" aria-hidden="true">
            {s.present ? "✓" : "✗"}
          </span>
          <span>{s.name}</span>
          <span className="sr-only">{s.present ? " (set)" : " (missing)"}</span>
        </li>
      ))}
    </ul>
  );
}
