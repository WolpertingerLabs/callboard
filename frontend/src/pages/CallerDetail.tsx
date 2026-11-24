import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { KeyRound, RotateCcw, Ban } from "lucide-react";
import type {
  AdminCaller,
  AdminCallerConnection,
  AdminSecretRef,
} from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import { KeysDirBadge, SourceBadge } from "./CallerList";
import IssueCredentialsModal from "../components/IssueCredentialsModal";
import ConfirmDialog from "../components/ConfirmDialog";
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

export default function CallerDetail() {
  const { alias } = useParams<{ alias: string }>();
  const { daemon } = useDaemon();
  const navigate = useNavigate();
  const [state, setState] = useState<FetchState>({ status: "loading" });

  // Credential-lifecycle UI state.
  const [templates, setTemplates] = useState<string[]>([]);
  const [defaultEndpoint, setDefaultEndpoint] = useState<string>(
    window.location.origin,
  );
  const [showIssue, setShowIssue] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [selfManageSaving, setSelfManageSaving] = useState(false);
  const [selfManageError, setSelfManageError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!alias) return;
    const callersRes = await api.callers();
    if (isDaemonDown(callersRes)) {
      setState({ status: "error", message: callersRes.error });
      return;
    }
    const caller = callersRes.find((c) => c.alias === alias);
    if (!caller) {
      setState({ status: "not-found" });
      return;
    }
    const connsRes = await api.callerConnections(alias);
    if (isDaemonDown(connsRes)) {
      setState({ status: "error", message: connsRes.error });
      return;
    }
    setState({ status: "ok", caller, connections: connsRes });
  }, [alias]);

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
      const [tplRes, metaRes] = await Promise.all([
        api.connections(),
        api.meta(),
      ]);
      if (cancelled) return;
      if (!isDaemonDown(tplRes)) setTemplates(tplRes.map((t) => t.alias));
      if (!isDaemonDown(metaRes) && metaRes.tunnelUrl) {
        setDefaultEndpoint(metaRes.tunnelUrl);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [daemon]);

  const handleSelfManage = async (enabled: boolean) => {
    if (!alias) return;
    setSelfManageSaving(true);
    setSelfManageError(null);
    const res = await api.setCallerSelfManage(alias, enabled);
    setSelfManageSaving(false);
    if (!res.ok) {
      setSelfManageError(res.error);
      return;
    }
    await load();
  };

  const handleRevoke = async () => {
    if (!alias) return;
    setRevoking(true);
    setRevokeError(null);
    const res = await api.deleteCaller(alias);
    setRevoking(false);
    if (!res.ok) {
      setRevokeError(res.error);
      return;
    }
    navigate("/callers");
  };

  if (daemon === "down") {
    return (
      <>
        <BackLink />
        <header className="page-header">
          <h1 className="page-title">{alias}</h1>
        </header>
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            Drawlatch daemon is not reachable. Start it with{" "}
            <code>drawlatch start</code>.
          </span>
        </div>
      </>
    );
  }

  if (state.status === "loading") {
    return (
      <>
        <BackLink />
        <div className="banner banner-loading">Loading…</div>
      </>
    );
  }

  if (state.status === "error") {
    return (
      <>
        <BackLink />
        <div className="banner banner-offline">
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
        <header className="page-header">
          <h1 className="page-title">Not found</h1>
        </header>
        <div className="placeholder">
          <span className="placeholder-title">
            No caller named &quot;{alias}&quot;
          </span>
          <span>
            Return to the <Link to="/callers">caller list</Link>.
          </span>
        </div>
      </>
    );
  }

  const { caller, connections } = state;

  return (
    <>
      <BackLink />
      <header className="page-header">
        <div>
          <div className="title-row">
            <h1 className="page-title">{caller.name ?? caller.alias}</h1>
            <KeysDirBadge exists={caller.keysDirExists} />
            <SourceBadge source={caller.source} />
          </div>
          <div className="subtitle-meta">
            <span className="mono">{caller.alias}</span>
            {caller.fingerprint && (
              <>
                <span className="dot-sep">·</span>
                <span className="mono" title="Ed25519 public key fingerprint">
                  {caller.fingerprint}
                </span>
              </>
            )}
          </div>
        </div>
      </header>

      {caller.configProblem && (
        // The caller can't be resolved at all (say, a connection that is
        // neither a template nor a connector): its handshakes fail.
        <div className="banner banner-offline" role="alert">
          <span className="status-dot down" aria-hidden="true" />
          <span>
            This caller&apos;s config can&apos;t be loaded, so its agent
            can&apos;t connect: {caller.configProblem}
          </span>
        </div>
      )}

      <section className="detail-section">
        <h2 className="section-title">Credentials</h2>
        <div className="dl-cred-lifecycle">
          <p className="detail-note">
            {caller.source === "local-auto" ? (
              <>
                Auto-shared to a co-located callboard over the filesystem
                (<code>local-auto</code>). Issuing here mints a fresh keypair and
                hands back a downloadable bundle instead.
              </>
            ) : caller.source === "bundle-issued" ? (
              <>
                Credentials were issued as a downloadable bundle. drawlatch holds
                only the public key — rotate to mint a fresh keypair, or revoke to
                end access.
              </>
            ) : (
              <>
                No credential bundle has been issued from drawlatch for this
                caller yet. Issue one to hand a callboard instance its identity.
              </>
            )}
          </p>
          <div className="dl-cred-actions">
            <button
              type="button"
              className="dl-cred-btn dl-cred-btn-primary"
              onClick={() => setShowIssue(true)}
            >
              {caller.source ? (
                <>
                  <RotateCcw size={14} />
                  Rotate credentials
                </>
              ) : (
                <>
                  <KeyRound size={14} />
                  Issue credentials
                </>
              )}
            </button>
            {caller.alias !== "default" && (
              <button
                type="button"
                className="dl-cred-btn dl-cred-btn-danger"
                onClick={() => {
                  setRevokeError(null);
                  setConfirmRevoke(true);
                }}
              >
                <Ban size={14} />
                Revoke
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="detail-section">
        <h2 className="section-title">Vault</h2>
        <p className="detail-note">
          <Link to={`/vault?caller=${encodeURIComponent(caller.alias)}`}>
            Vault:{" "}
            {caller.vaultItems === null
              ? "unavailable"
              : `${caller.vaultItems} item${caller.vaultItems === 1 ? "" : "s"}`}
          </Link>
        </p>
      </section>

      <section className="detail-section">
        <h2 className="section-title">Agent permissions</h2>
        <label className="secret-matrix-toggle">
          <input
            type="checkbox"
            checked={caller.selfManage}
            disabled={selfManageSaving}
            onChange={(e) => void handleSelfManage(e.target.checked)}
          />
          <span>
            Let this caller&apos;s agent enable connections and set its own
            secrets (<code>set_connection_enabled</code>,{" "}
            <code>set_secrets</code>)
          </span>
        </label>
        <p className="detail-note">
          When off, only this dashboard can change the caller&apos;s connections
          and secrets. An agent that can enable connections for itself can pick
          up any existing secret that a newly enabled connection shares by name.
        </p>
        {selfManageError && (
          <p className="detail-note" role="alert">
            {selfManageError}
          </p>
        )}
      </section>

      <section className="detail-section">
        <h2 className="section-title">
          Connections ({connections.length})
        </h2>
        {connections.length === 0 ? (
          <p className="detail-note">
            This caller has no connections enabled.
          </p>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Connection</th>
                  <th>Status</th>
                  <th>Auth</th>
                  <th>Required secrets</th>
                  <th>Optional secrets</th>
                  <th>Ingestor</th>
                  <th className="num">Instances</th>
                </tr>
              </thead>
              <tbody>
                {connections.map((c) => (
                  <tr key={c.connectionAlias}>
                    <td>
                      <div className="cell-primary mono">
                        {c.connectionAlias}
                      </div>
                    </td>
                    <td>
                      <div className="badge-row">
                        <EnabledBadge enabled={c.enabled} />
                        {c.isCustom && (
                          <span className="tag tag-custom">custom</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <AuthSummary
                        callerAuth={c.auth}
                        problem={c.problem}
                        compact
                      />
                    </td>
                    <td>
                      <SecretRefList
                        secrets={c.requiredSecrets}
                        emptyText="—"
                      />
                    </td>
                    <td>
                      <SecretRefList
                        secrets={c.optionalSecrets}
                        emptyText="—"
                      />
                    </td>
                    <td>
                      {c.hasIngestor ? (
                        <span className="tag">yes</span>
                      ) : (
                        <span className="cell-muted">—</span>
                      )}
                    </td>
                    <td className="num">{c.instances.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showIssue && (
        <IssueCredentialsModal
          alias={caller.alias}
          callerConnections={caller.connections}
          availableConnections={[
            ...new Set([...templates, ...caller.connections]),
          ]}
          defaultEndpoint={defaultEndpoint}
          isRotation={caller.source !== null}
          onClose={() => setShowIssue(false)}
          onIssued={() => void load()}
        />
      )}

      {confirmRevoke && (
        <ConfirmDialog
          title={`Revoke "${caller.alias}"?`}
          confirmLabel="Revoke"
          description={
            <>
              This deletes <code>{caller.alias}</code> and its public-key entry,
              so it can no longer authenticate. Any active sessions are dropped.
              This cannot be undone.
            </>
          }
          busy={revoking}
          error={revokeError}
          onConfirm={handleRevoke}
          onCancel={() => {
            if (revoking) return;
            setConfirmRevoke(false);
            setRevokeError(null);
          }}
        />
      )}
    </>
  );
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
    <span
      className={`enabled-badge enabled-${enabled ? "yes" : "no"}`}
    >
      {enabled ? "enabled" : "disabled"}
    </span>
  );
}

function SecretRefList({
  secrets,
  emptyText,
}: {
  secrets: AdminSecretRef[];
  emptyText: string;
}) {
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
        </li>
      ))}
    </ul>
  );
}
