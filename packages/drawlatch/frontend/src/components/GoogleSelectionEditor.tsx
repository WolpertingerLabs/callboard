/**
 * The Google services editor: a caller's `callers.<alias>.google` block
 * (auth mode, one level per service, the service-account subject).
 *
 * Everything is rendered from GET /api/admin/google/catalog: no service,
 * level or scope is hardcoded here. The daemon validates again on save
 * (validateGoogleSelection) and its message is shown as is; the checks below
 * only keep obviously incomplete drafts from being sent.
 *
 * Controlled: ConfigureConnectionModal owns the draft, the secrets section
 * (which follows `draft.auth`), the confirm-on-widen dialog and the save.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, ExternalLink } from "lucide-react";
import type {
  AdminGoogleAuthMode,
  AdminGoogleCatalog,
  AdminGoogleSelectionConfig,
} from "drawlatch-admin-types";
import { shortScope } from "./AuthSummary";
import {
  consentScopesOf,
  draftProblem,
  notesFor,
  pickedLevels,
  selectionFrom,
  type GoogleDraft,
} from "../utils/googleSelection";
import { copyText } from "../utils/clipboard";

const MODE_LABELS: Record<AdminGoogleAuthMode, string> = {
  user: "User OAuth",
  "service-account": "Service account",
};
/** For running text: "not available with a service account". */
const MODE_PHRASES: Record<AdminGoogleAuthMode, string> = {
  user: "user OAuth",
  "service-account": "a service account",
};

export default function GoogleSelectionEditor({
  catalog,
  draft,
  saved,
  onChange,
}: {
  catalog: AdminGoogleCatalog;
  draft: GoogleDraft;
  /** The stored selection, to say what a change removes. */
  saved: AdminGoogleSelectionConfig | null;
  onChange: (next: GoogleDraft) => void;
}) {
  // Levels a mode switch turned off, so the operator sees why.
  const [dropped, setDropped] = useState<string[]>([]);

  const sel = selectionFrom(catalog, draft);
  const scopes = consentScopesOf(catalog, sel);
  const savedScopes = saved ? consentScopesOf(catalog, saved) : [];
  const removed = savedScopes.filter((s) => !scopes.includes(s));
  const notes = notesFor(catalog, sel);
  const sa = draft.auth === "service-account";
  const subjectNeeded = sa && pickedLevels(catalog, sel).some((p) => p.level.subjectRequired);
  const problem = draftProblem(catalog, draft);
  const subjectMessage = sa && problem && /subject/i.test(problem) ? problem : null;

  const setMode = (auth: AdminGoogleAuthMode) => {
    if (auth === draft.auth) return;
    const services: Record<string, string> = {};
    const lost: string[] = [];
    for (const [svc, levelId] of Object.entries(draft.services)) {
      const level = catalog.services
        .find((s) => s.id === svc)
        ?.levels.find((l) => l.id === levelId);
      if (level?.auth.includes(auth)) services[svc] = levelId;
      else lost.push(`${svc} · ${levelId}`);
    }
    setDropped(lost);
    onChange({ ...draft, auth, services });
  };

  const setLevel = (svc: string, levelId: string | null) => {
    const services = { ...draft.services };
    if (levelId === null) delete services[svc];
    else services[svc] = levelId;
    setDropped([]);
    onChange({ ...draft, services });
  };

  const consentText = sa ? scopes.join(",") : `SCOPES="${scopes.join(" ")}"`;

  return (
    <div className="dl-gsel">
      {/* ── Auth mode ── */}
      <fieldset className="dl-gsel-mode">
        <legend className="dl-secrets-section-title">Auth mode</legend>
        {catalog.authModes.map((m) => (
          <label key={m.id} className="dl-gsel-mode-opt">
            <input
              type="radio"
              name="dl-gsel-auth"
              value={m.id}
              checked={draft.auth === m.id}
              onChange={() => setMode(m.id)}
            />
            <span>{MODE_LABELS[m.id]}</span>
            <span className="dl-gsel-mode-secrets mono">{m.secrets.join(", ")}</span>
          </label>
        ))}
      </fieldset>
      {dropped.length > 0 && (
        <div className="dl-gsel-warn" role="status">
          <AlertTriangle size={12} aria-hidden="true" />
          <span>
            Turned off (not available with {MODE_PHRASES[draft.auth]}
            ): <span className="mono">{dropped.join(", ")}</span>
          </span>
        </div>
      )}

      {/* ── Services × levels ── */}
      <div className="dl-secrets-section">
        <h3 className="dl-secrets-section-title">Services</h3>
        <div className="dl-gsel-matrix" role="group" aria-label="Services and levels">
          {catalog.services.map((svc) => {
            const current = Object.hasOwn(draft.services, svc.id) ? draft.services[svc.id] : null;
            const group = `dl-gsel-${svc.id}`;
            const nameId = `${group}-name`;
            return (
              <div key={svc.id} className="dl-gsel-row">
                <div className="dl-gsel-svc">
                  <span id={nameId} className="sr-only">
                    {svc.name}
                  </span>
                  <a
                    href={svc.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Enable "${svc.enableApi}" in the Cloud console`}
                  >
                    {svc.name} <ExternalLink size={10} aria-hidden="true" />
                    <span className="sr-only"> (docs, opens in a new tab)</span>
                  </a>
                  <span className="mono dl-gsel-svc-id">{svc.id}</span>
                </div>
                <div className="dl-gsel-levels" role="radiogroup" aria-labelledby={nameId}>
                  <label className={`dl-gsel-opt is-off${current === null ? " is-on" : ""}`}>
                    <input
                      type="radio"
                      name={group}
                      checked={current === null}
                      onChange={() => setLevel(svc.id, null)}
                    />
                    <span className="dl-gsel-opt-id">Off</span>
                  </label>
                  {svc.levels.map((l) => {
                    const available = l.auth.includes(draft.auth);
                    return (
                      <label
                        key={l.id}
                        className={
                          "dl-gsel-opt" +
                          (current === l.id ? " is-on" : "") +
                          (available ? "" : " is-disabled")
                        }
                        title={
                          available
                            ? l.scopes.map(shortScope).join(", ")
                            : // From the level's own auth list, not a fixed mode.
                              `not available with ${MODE_PHRASES[draft.auth]} (only with ${l.auth
                                .map((a) => MODE_PHRASES[a])
                                .join(" or ")})`
                        }
                      >
                        <input
                          type="radio"
                          name={group}
                          checked={current === l.id}
                          disabled={!available}
                          onChange={() => setLevel(svc.id, l.id)}
                        />
                        <span className="dl-gsel-opt-id mono">{l.id}</span>
                        <span className="dl-gsel-opt-summary">{l.summary}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Subject (service account) ── */}
      {sa && (
        <div className="dl-secrets-section">
          <label className="dl-secrets-section-title" htmlFor="dl-gsel-subject">
            Subject {subjectNeeded ? "(required)" : "(optional)"}
          </label>
          <input
            id="dl-gsel-subject"
            className={"dl-secrets-input" + (subjectMessage ? " is-invalid" : "")}
            type="email"
            autoComplete="off"
            spellCheck={false}
            placeholder="user@your-workspace-domain.com"
            value={draft.subject}
            onChange={(e) => onChange({ ...draft, subject: e.target.value })}
          />
          <p className="dl-secrets-help">
            The Workspace user the service account acts as (domain-wide delegation). Without one it
            reaches only what is shared with its <span className="mono">client_email</span>. Agents
            never see it.
          </p>
          {subjectMessage && (
            <p className="dl-gsel-error" role="alert">
              {subjectMessage}
            </p>
          )}
        </div>
      )}

      {/* ── Consent scopes ── */}
      <div className="dl-secrets-section">
        <h3 className="dl-secrets-section-title">
          {sa ? "Domain-wide delegation scopes" : "Consent scopes"}
        </h3>
        {scopes.length === 0 ? (
          <p className="dl-secrets-help">Choose a service to see its scopes.</p>
        ) : (
          <>
            <div className="dl-gsel-consent">
              <code className="mono">{consentText}</code>
              <CopyButton text={consentText} />
            </div>
            <p className="dl-secrets-help">
              {sa ? (
                <>
                  With a subject, paste this comma-separated list into the Admin console (Security →
                  Access and data control → API controls → Manage Domain Wide Delegation) for the
                  service account&apos;s client ID; the entry must cover every scope here. Without a
                  subject, no consent step is needed: share the files with the account&apos;s{" "}
                  <span className="mono">client_email</span>.
                </>
              ) : (
                <>
                  The SCOPES line for the refresh-token recipe in CONNECTIONS.md → Google. Consent
                  the refresh token for exactly these scopes. Adding or removing a service usually
                  needs a new refresh token (CONNECTIONS.md → Google › Changing the selection).
                </>
              )}
            </p>
          </>
        )}
        {removed.length > 0 && !sa && (
          <div className="dl-gsel-warn" role="status">
            <AlertTriangle size={12} aria-hidden="true" />
            <span>
              Removes <span className="mono">{removed.map(shortScope).join(", ")}</span>: a token
              still granted those is refused as broader than the selection. Re-consent with the
              scopes above.
            </span>
          </div>
        )}
      </div>

      {notes.map((text) => (
        <div key={text} className="dl-gsel-warn" role="note">
          <AlertTriangle size={12} aria-hidden="true" />
          <span>{text}</span>
        </div>
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={`dl-gsel-copy dl-tap-compact${state === "failed" ? " is-failed" : ""}`}
      title="Copy to the clipboard"
      onClick={() => {
        void copyText(text).then((ok) => {
          setState(ok ? "copied" : "failed");
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setState("idle"), ok ? 1500 : 3000);
        });
      }}
    >
      {state === "copied" ? (
        <Check size={12} aria-hidden="true" />
      ) : (
        <Copy size={12} aria-hidden="true" />
      )}
      <span aria-live="polite">
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </span>
    </button>
  );
}
