import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ExternalLink, Globe, SearchX } from "lucide-react";
import type { AdminConnectionTemplate } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import StabilityBadge from "../components/StabilityBadge";
import { shortScope } from "../components/AuthSummary";
import DaemonOffline from "../components/DaemonOffline";
import EmptyState, { LoadingState } from "../components/EmptyState";

const GRANT_TEXT: Record<NonNullable<AdminConnectionTemplate["auth"]>["grant"], string> = {
  refresh_token: "user OAuth, refresh token",
  client_credentials: "client credentials",
  jwt_bearer: "service account, JWT",
};

type FetchState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "ok"; template: AdminConnectionTemplate }
  | { status: "error"; message: string };

export default function ConnectionDetail() {
  const { alias } = useParams<{ alias: string }>();
  const { daemon } = useDaemon();
  const [state, setState] = useState<FetchState>({ status: "loading" });

  useEffect(() => {
    if (!alias) return;
    if (daemon !== "up") return;

    let cancelled = false;
    (async () => {
      const res = await api.connections();
      if (cancelled) return;
      if (isDaemonDown(res)) {
        setState({ status: "error", message: res.error });
        return;
      }
      const found = res.find((t) => t.alias === alias);
      setState(found ? { status: "ok", template: found } : { status: "not-found" });
    })();
    return () => {
      cancelled = true;
    };
  }, [alias, daemon]);

  if (daemon === "down") {
    return (
      <>
        <BackLink />
        <header className="page-header">
          <h1 className="page-title">{alias}</h1>
        </header>
        <DaemonOffline action="load this connection" />
      </>
    );
  }

  if (state.status === "loading") {
    return (
      <>
        <BackLink />
        <LoadingState label="Loading connection…" />
      </>
    );
  }

  if (state.status === "error") {
    return (
      <>
        <BackLink />
        <div className="modal-error" role="alert">
          Couldn&apos;t load the connection: {state.message}
        </div>
      </>
    );
  }

  if (state.status === "not-found") {
    return (
      <>
        <BackLink />
        <EmptyState
          icon={<SearchX size={20} />}
          title={`No connection template named "${alias}"`}
          action={
            <Link to="/connections" className="btn btn-secondary btn-sm">
              Go to Connections
            </Link>
          }
        />
      </>
    );
  }

  const t = state.template;

  return (
    <>
      <BackLink />
      <header className="page-header">
        <div>
          <div className="title-row">
            <h1 className="page-title">{t.name}</h1>
            <StabilityBadge stability={t.stability} />
          </div>
          <div className="subtitle-meta">
            <span className="mono">{t.alias}</span>
            <span className="dot-sep">·</span>
            <span className="tag">{t.category}</span>
            {t.docsUrl && (
              <>
                <span className="dot-sep">·</span>
                <a href={t.docsUrl} target="_blank" rel="noreferrer noopener">
                  Docs <ExternalLink size={12} aria-hidden="true" />
                </a>
              </>
            )}
            {t.openApiUrl && (
              <>
                <span className="dot-sep">·</span>
                <a href={t.openApiUrl} target="_blank" rel="noreferrer noopener">
                  OpenAPI <ExternalLink size={12} aria-hidden="true" />
                </a>
              </>
            )}
          </div>
        </div>
      </header>

      {t.description && (
        <section className="detail-section">
          <p className="detail-description">{t.description}</p>
        </section>
      )}

      <section className="detail-section">
        <h2 className="section-title">Auth</h2>
        {t.composed === "google" ? (
          <p className="detail-note">
            Drawlatch mints short-lived OAuth2 access tokens from the secrets below and adds them to
            each request. Which secrets apply, and the scopes, depend on each caller&apos;s Google
            selection (auth mode and services), set in Connections → Google → Configure. Secret
            values and tokens are never exposed.
          </p>
        ) : t.auth ? (
          <p className="detail-note">
            Drawlatch mints short-lived OAuth2 access tokens ({GRANT_TEXT[t.auth.grant]}) from the
            secrets below and adds them to each request. Secret values and tokens are never exposed.
            {t.auth.scopes.length > 0 && (
              <>
                {" "}
                Scopes: <code className="mono">{t.auth.scopes.map(shortScope).join(", ")}</code>.
              </>
            )}
          </p>
        ) : (
          <p className="detail-note">
            The daemon auto-injects the secrets below into request headers. Exact header strings
            (e.g. <code className="mono">Authorization: Bearer ${"{TOKEN}"}</code>) are defined in
            the connection template; the admin API exposes only the referenced secret names. Secret
            values are never exposed.
          </p>
        )}
        <SecretList
          label="Required secrets"
          secrets={t.requiredSecrets}
          emptyText="No required secrets"
        />
        <SecretList
          label="Optional secrets"
          secrets={t.optionalSecrets}
          emptyText="No optional secrets"
        />
      </section>

      <section className="detail-section">
        <h2 className="section-title">Allowed endpoints ({t.allowedEndpoints.length})</h2>
        {t.allowedEndpoints.length === 0 ? (
          <EmptyState
            compact
            icon={<Globe size={20} />}
            title="No allowlisted endpoints"
            body={
              t.composed === "google"
                ? "Each caller's Google selection decides which endpoints it may call."
                : undefined
            }
          />
        ) : (
          <ul className="endpoint-list">
            {t.allowedEndpoints.map((endpoint) => (
              <li key={endpoint} className="endpoint-item mono">
                {endpoint}
              </li>
            ))}
          </ul>
        )}
      </section>

      {t.hasIngestor && (
        <section className="detail-section">
          <h2 className="section-title">Listener</h2>
          <dl className="kv-grid">
            <dt>Type</dt>
            <dd className="mono">{t.ingestorType ?? "—"}</dd>
            <dt>Configurable</dt>
            <dd>{t.hasListenerConfig ? "Yes" : "No"}</dd>
            <dt>Multi-instance</dt>
            <dd>{t.supportsMultiInstance ? "Yes" : "No"}</dd>
            <dt>Listener test</dt>
            <dd>{t.hasTestIngestor ? "Yes" : "No"}</dd>
          </dl>
        </section>
      )}

      <section className="detail-section">
        <h2 className="section-title">Capabilities</h2>
        <dl className="kv-grid">
          <dt>Test connection</dt>
          <dd>{t.hasTestConnection ? "Yes" : "No"}</dd>
          <dt>Has listener</dt>
          <dd>{t.hasIngestor ? "Yes" : "No"}</dd>
        </dl>
      </section>
    </>
  );
}

function BackLink() {
  return (
    <Link to="/connections" className="back-link">
      ← Back to connections
    </Link>
  );
}

function SecretList({
  label,
  secrets,
  emptyText,
}: {
  label: string;
  secrets: string[];
  emptyText: string;
}) {
  return (
    <div className="secret-list-block">
      <div className="card-label">{label}</div>
      {secrets.length === 0 ? (
        <div className="cell-muted">{emptyText}</div>
      ) : (
        <ul className="secret-list">
          {secrets.map((name) => (
            <li key={name} className="secret-pill mono">
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
