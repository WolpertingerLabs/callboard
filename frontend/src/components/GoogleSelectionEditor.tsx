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
import { useState } from "react";
import { AlertTriangle, Check, Copy, ExternalLink } from "lucide-react";
import type {
  AdminGoogleAuthMode,
  AdminGoogleCatalog,
  AdminGoogleSelectionConfig,
} from "drawlatch-admin-types";
import { shortScope } from "./AuthSummary";

export interface GoogleDraft {
  auth: AdminGoogleAuthMode;
  /** service id → level id; a missing service is Off. */
  services: Record<string, string>;
  /** Kept while switching modes; only sent in service-account mode. */
  subject: string;
}

type Level = AdminGoogleCatalog["services"][number]["levels"][number];

const MODE_LABELS: Record<AdminGoogleAuthMode, string> = {
  user: "User OAuth",
  "service-account": "Service account",
};

export function draftFrom(sel: AdminGoogleSelectionConfig | null): GoogleDraft {
  return {
    auth: sel?.auth ?? "user",
    services: { ...(sel?.services ?? {}) },
    subject: sel?.subject ?? "",
  };
}

/** The PUT body: services in catalog order, subject only in SA mode. */
export function selectionFrom(
  catalog: AdminGoogleCatalog,
  d: GoogleDraft,
): AdminGoogleSelectionConfig {
  const services: Record<string, string> = {};
  for (const svc of catalog.services) {
    if (Object.hasOwn(d.services, svc.id)) services[svc.id] = d.services[svc.id];
  }
  const subject = d.subject.trim();
  return {
    auth: d.auth,
    services,
    ...(d.auth === "service-account" && subject !== "" && { subject }),
  };
}

export function sameSelection(
  a: AdminGoogleSelectionConfig | null,
  b: AdminGoogleSelectionConfig | null,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Each selected level, in catalog order. */
export function pickedLevels(
  catalog: AdminGoogleCatalog,
  sel: AdminGoogleSelectionConfig,
): { service: string; name: string; level: Level }[] {
  const out: { service: string; name: string; level: Level }[] = [];
  for (const svc of catalog.services) {
    const levelId = Object.hasOwn(sel.services, svc.id) ? sel.services[svc.id] : undefined;
    const level = svc.levels.find((l) => l.id === levelId);
    if (level) out.push({ service: svc.id, name: svc.name, level });
  }
  return out;
}

/** The sorted union of the selected levels' scopes (googleConsentScopes). */
export function consentScopesOf(
  catalog: AdminGoogleCatalog,
  sel: AdminGoogleSelectionConfig,
): string[] {
  return [
    ...new Set(pickedLevels(catalog, sel).flatMap((p) => p.level.scopes)),
  ].sort();
}

/** What would stop the daemon accepting the draft, or null. */
export function draftProblem(
  catalog: AdminGoogleCatalog,
  d: GoogleDraft,
): string | null {
  const sel = selectionFrom(catalog, d);
  if (Object.keys(sel.services).length === 0) {
    return "Choose a level for at least one service.";
  }
  if (d.auth === "service-account") {
    const subject = d.subject.trim();
    if (subject !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject)) {
      return "The subject must be an email address.";
    }
    const needs = pickedLevels(catalog, sel).filter((p) => p.level.subjectRequired);
    if (subject === "" && needs.length > 0) {
      return `${needs.map((p) => p.name).join(", ")} needs a subject with a service account: it has no mailbox, so it must act as a Workspace user.`;
    }
  }
  return null;
}

/** The catalog notes whose `when` the selection contains. */
export function notesFor(
  catalog: AdminGoogleCatalog,
  sel: AdminGoogleSelectionConfig,
): string[] {
  return catalog.crossScopeNotes
    .filter((n) =>
      Object.entries(n.when).every(
        ([svc, level]) => Object.hasOwn(sel.services, svc) && sel.services[svc] === level,
      ),
    )
    .map((n) => n.text);
}

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
  const subjectNeeded =
    sa && pickedLevels(catalog, sel).some((p) => p.level.subjectRequired);
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
            <span className="dl-gsel-mode-secrets mono">
              {m.secrets.join(", ")}
            </span>
          </label>
        ))}
      </fieldset>
      {dropped.length > 0 && (
        <div className="dl-gsel-warn" role="status">
          <AlertTriangle size={12} />
          <span>
            Turned off (not available with {MODE_LABELS[draft.auth].toLowerCase()}
            ): <span className="mono">{dropped.join(", ")}</span>
          </span>
        </div>
      )}

      {/* ── Services × levels ── */}
      <div className="dl-secrets-section">
        <h3 className="dl-secrets-section-title">Services</h3>
        <div className="dl-gsel-matrix" role="group" aria-label="Services and levels">
          {catalog.services.map((svc) => {
            const current = Object.hasOwn(draft.services, svc.id)
              ? draft.services[svc.id]
              : null;
            const group = `dl-gsel-${svc.id}`;
            return (
              <div key={svc.id} className="dl-gsel-row">
                <div className="dl-gsel-svc">
                  <a
                    href={svc.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Enable "${svc.enableApi}" in the Cloud console`}
                  >
                    {svc.name} <ExternalLink size={10} />
                  </a>
                  <span className="mono dl-gsel-svc-id">{svc.id}</span>
                </div>
                <div className="dl-gsel-levels">
                  <label className={`dl-gsel-opt ${current === null ? "is-on" : ""}`}>
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
                            : "not available with a service account"
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
            The Workspace user the service account acts as (domain-wide
            delegation). Without one it reaches only what is shared with its{" "}
            <span className="mono">client_email</span>. Agents never see it.
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
                  With a subject, paste this comma-separated list into the
                  Admin console (Security → Access and data control → API
                  controls → Manage Domain Wide Delegation) for the service
                  account&apos;s client ID; the
                  entry must cover every scope here. Without a subject, no
                  consent step is needed: share the files with the
                  account&apos;s <span className="mono">client_email</span>.
                </>
              ) : (
                <>
                  The SCOPES line for the refresh-token recipe in
                  CONNECTIONS.md → Google. Consent the refresh token for
                  exactly these scopes. Adding or removing a service usually
                  needs a new refresh token (CONNECTIONS.md → Google ›
                  Changing the selection).
                </>
              )}
            </p>
          </>
        )}
        {removed.length > 0 && !sa && (
          <div className="dl-gsel-warn" role="status">
            <AlertTriangle size={12} />
            <span>
              Removes{" "}
              <span className="mono">{removed.map(shortScope).join(", ")}</span>
              : a token still granted those is refused as broader than the
              selection. Re-consent with the scopes above.
            </span>
          </div>
        )}
      </div>

      {notes.map((text) => (
        <div key={text} className="dl-gsel-warn" role="note">
          <AlertTriangle size={12} />
          <span>{text}</span>
        </div>
      ))}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="dl-gsel-copy dl-tap-compact"
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
