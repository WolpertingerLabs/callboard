import type {
  AdminConnectionAuth,
  AdminConnectionTemplate,
} from "drawlatch-admin-types";

/**
 * Read-only view of how drawlatch mints a connection's token: the grant and
 * the scopes this caller gets. Overrides (narrower scopes, a service-account
 * subject) and the google connection's selection (callers.<alias>.google:
 * services, auth mode, subject) are edited in remote.config.json, not here.
 */

type TemplateAuth = NonNullable<AdminConnectionTemplate["auth"]>;

const GRANT_LABELS: Record<TemplateAuth["grant"], string> = {
  refresh_token: "user OAuth (refresh token)",
  client_credentials: "client credentials",
  jwt_bearer: "service account (JWT)",
};

const GOOGLE_SCOPE_PREFIX = "https://www.googleapis.com/auth/";

/** `https://www.googleapis.com/auth/gmail.readonly` → `gmail.readonly`. */
export function shortScope(scope: string): string {
  return scope.startsWith(GOOGLE_SCOPE_PREFIX)
    ? scope.slice(GOOGLE_SCOPE_PREFIX.length)
    : scope;
}

export function AuthSummary({
  auth,
  callerAuth,
  problem,
  compact = false,
}: {
  /** The template's declaration. */
  auth?: TemplateAuth;
  /** What this caller gets, after its oauth2Overrides. */
  callerAuth?: AdminConnectionAuth;
  /** Why the daemon drops the connection for this caller. */
  problem?: string;
  compact?: boolean;
}) {
  const grant = callerAuth?.grant ?? auth?.grant;
  if (!grant && !problem) {
    // Not minted by drawlatch: headers, a signature (aws), or nothing at all.
    return compact ? <span className="cell-muted">—</span> : null;
  }
  const scopes = callerAuth?.scopes ?? auth?.scopes ?? [];
  const subjectRequired =
    callerAuth?.subjectRequired ?? auth?.subjectRequired ?? false;

  return (
    <div className={compact ? "auth-summary is-compact" : "auth-summary"}>
      {grant && (
        <div className="auth-summary-line">
          <span
            className="tag"
            title="drawlatch mints this connection's token"
          >
            oauth2
          </span>{" "}
          <span className="auth-summary-grant">{GRANT_LABELS[grant]}</span>
        </div>
      )}
      {scopes.length > 0 && (
        <ul className="auth-summary-scopes" aria-label="Scopes">
          {scopes.map((s) => (
            <li key={s} className="mono" title={s}>
              {shortScope(s)}
            </li>
          ))}
        </ul>
      )}
      {callerAuth?.narrowed && (
        <div className="auth-summary-note">
          narrowed by this caller&apos;s oauth2Overrides
        </div>
      )}
      {callerAuth?.subject !== undefined && (
        <div className="auth-summary-note">
          acts as <span className="mono">{callerAuth.subject}</span>
        </div>
      )}
      {subjectRequired &&
        callerAuth?.subject === undefined &&
        !problem &&
        !compact && (
        <div className="auth-summary-note">
          needs a subject: set <span className="mono">oauth2Overrides</span>
          {" → "}
          <span className="mono">subject</span> for the caller in
          remote.config.json (for <span className="mono">google</span>:{" "}
          <span className="mono">google.subject</span>)
        </div>
      )}
      {problem && (
        <div className="auth-summary-problem" role="status">
          not loaded: {problem}
        </div>
      )}
    </div>
  );
}

/** Help shown under a secret's input, for secrets with a non-obvious format. */
export const SECRET_HELP: Record<string, string> = {
  GOOGLE_SERVICE_ACCOUNT_KEY:
    "Paste base64 of the service-account JSON key file (base64 -w0 key.json). " +
    "Pasting the JSON itself also works. Only drawlatch's signer reads it.",
  GOOGLE_OAUTH_REFRESH_TOKEN:
    "A refresh token consented for exactly the scopes of this caller's " +
    "google selection (see CONNECTIONS.md › Google). drawlatch requests " +
    "those scopes and refuses a broader token.",
  GOOGLE_OAUTH_CLIENT_ID: "The OAuth client ID of a Desktop app client.",
  GOOGLE_OAUTH_CLIENT_SECRET: "The OAuth client secret of the same client.",
};
