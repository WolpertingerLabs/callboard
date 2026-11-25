import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import type { AdminConnectionTemplate } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import StabilityBadge from "../components/StabilityBadge";

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
          <span>Failed to load connection: {state.message}</span>
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
            No connection template named &quot;{alias}&quot;
          </span>
          <span>
            Return to the <Link to="/connections">connection list</Link>.
          </span>
        </div>
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
                  docs <ExternalLink size={12} aria-hidden="true" />
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
        <p className="detail-note">
          The daemon auto-injects the secrets below into request headers.
          Exact header strings (e.g.{" "}
          <code className="mono">Authorization: Bearer ${"{TOKEN}"}</code>) are
          defined in the connection template; the admin API exposes only the
          referenced secret names. Secret values are never exposed.
        </p>
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
        <h2 className="section-title">
          Allowed endpoints ({t.allowedEndpoints.length})
        </h2>
        {t.allowedEndpoints.length === 0 ? (
          <p className="detail-note">No allowlisted endpoints.</p>
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
          <h2 className="section-title">Ingestor</h2>
          <dl className="kv-grid">
            <dt>Type</dt>
            <dd className="mono">{t.ingestorType ?? "—"}</dd>
            <dt>Listener config</dt>
            <dd>{t.hasListenerConfig ? "yes" : "no"}</dd>
            <dt>Multi-instance</dt>
            <dd>{t.supportsMultiInstance ? "yes" : "no"}</dd>
            <dt>Test ingestor</dt>
            <dd>{t.hasTestIngestor ? "yes" : "no"}</dd>
          </dl>
        </section>
      )}

      <section className="detail-section">
        <h2 className="section-title">Capabilities</h2>
        <dl className="kv-grid">
          <dt>Test connection</dt>
          <dd>{t.hasTestConnection ? "yes" : "no"}</dd>
          <dt>Has ingestor</dt>
          <dd>{t.hasIngestor ? "yes" : "no"}</dd>
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
