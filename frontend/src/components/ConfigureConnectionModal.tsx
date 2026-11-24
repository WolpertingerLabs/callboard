import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react";
import type {
  AdminConnectionStatus,
  AdminGoogleCatalog,
  AdminGoogleSelection,
} from "drawlatch-admin-types";
import { api, isDaemonDown } from "../api";
import { AuthSummary, SECRET_HELP, shortScope } from "./AuthSummary";
import ConfirmDialog from "./ConfirmDialog";
import GoogleSelectionEditor, {
  consentScopesOf,
  draftFrom,
  draftProblem,
  pickedLevels,
  sameSelection,
  selectionFrom,
  type GoogleDraft,
} from "./GoogleSelectionEditor";
import { TestResultView, toOutcome, type TestOutcome } from "./TestResult";
import "./ConfigureConnectionModal.css";

interface ConfigureConnectionModalProps {
  /** Caller alias to manage secrets for. */
  caller: string;
  connection: AdminConnectionStatus;
  onClose: () => void;
  /** Parent refetches connection status after this fires. The modal closes
   *  itself after a save, except for `google`, where it stays open to offer
   *  a test. */
  onSaved: () => void;
}

type SaveState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved" }
  | { phase: "error"; message: string };

export default function ConfigureConnectionModal({
  caller,
  connection,
  onClose,
  onSaved,
}: ConfigureConnectionModalProps) {
  // Pending new values, keyed by secret name (only modified fields are sent).
  const [values, setValues] = useState<Record<string, string>>({});
  // Secrets the user marked for deletion (sent as empty string on save).
  const [clearing, setClearing] = useState<Set<string>>(new Set());
  const [showOptional, setShowOptional] = useState(false);
  const [save, setSave] = useState<SaveState>({ phase: "idle" });

  // ── Google: the selection editor (callers.<alias>.google) ──
  const isGoogle = connection.composed === "google";
  const [catalog, setCatalog] = useState<AdminGoogleCatalog | null>(null);
  const [googleView, setGoogleView] = useState<AdminGoogleSelection | null>(null);
  const [googleLoadError, setGoogleLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<GoogleDraft | null>(null);
  const [widen, setWiden] = useState<string[] | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);

  // Close on Escape, unless a confirm dialog is open (Escape cancels that).
  const dialogOpen = widen !== null || confirmRemove;
  useEffect(() => {
    if (dialogOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, dialogOpen]);

  useEffect(() => {
    if (!isGoogle) return;
    let live = true;
    void Promise.all([api.googleCatalog(), api.googleSelection(caller)]).then(
      ([cat, view]) => {
        if (!live) return;
        if (isDaemonDown(cat)) return setGoogleLoadError(cat.error);
        if (isDaemonDown(view)) return setGoogleLoadError(view.error);
        setCatalog(cat);
        setGoogleView(view);
        setDraft(draftFrom(view.selection));
      },
    );
    return () => {
      live = false;
    };
  }, [isGoogle, caller]);

  const draftSelection = useMemo(
    () => (catalog && draft ? selectionFrom(catalog, draft) : null),
    [catalog, draft],
  );
  const selectionDirty =
    draftSelection !== null &&
    !sameSelection(draftSelection, googleView?.selection ?? null);
  const selectionProblem =
    selectionDirty && catalog && draft ? draftProblem(catalog, draft) : null;

  // For google, the secrets section follows the draft's auth mode.
  const modeSecrets =
    isGoogle && catalog && draft
      ? catalog.authModes.find((m) => m.id === draft.auth)?.secrets ?? []
      : null;
  const requiredSecrets = modeSecrets ?? connection.requiredSecrets;
  const optionalSecrets = modeSecrets ? [] : connection.optionalSecrets;

  const isSetMap = useMemo<Record<string, boolean>>(
    () => ({
      ...connection.requiredSecretsSet,
      ...connection.optionalSecretsSet,
    }),
    [connection.requiredSecretsSet, connection.optionalSecretsSet],
  );


  const setValue = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    // Typing into a field un-marks it for clearing.
    setClearing((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }, []);

  const markClear = useCallback((name: string) => {
    setClearing((prev) => new Set(prev).add(name));
    setValues((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  }, []);

  const undoClear = useCallback((name: string) => {
    setClearing((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
  }, []);

  // Build the payload of *only* modified fields.
  // Only the fields on screen: a value typed for the other Google mode is
  // not sent.
  const pendingSecrets = useMemo<Record<string, string>>(() => {
    const shown = new Set([...requiredSecrets, ...optionalSecrets]);
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      if (value !== "" && shown.has(name)) out[name] = value;
    }
    for (const name of clearing) {
      if (shown.has(name)) out[name] = "";
    }
    return out;
  }, [values, clearing, requiredSecrets, optionalSecrets]);

  const hasChanges = Object.keys(pendingSecrets).length > 0 || selectionDirty;

  const doSave = useCallback(async () => {
    setWiden(null);
    setSave({ phase: "saving" });
    if (selectionDirty && draftSelection) {
      // Written by the admin Google route directly, never through a tool.
      const put = await api.setGoogleSelection(caller, draftSelection);
      if (!put.ok) {
        setSave({ phase: "error", message: put.error });
        return;
      }
      setGoogleView(put.data);
      setDraft(draftFrom(put.data.selection));
    }
    if (Object.keys(pendingSecrets).length > 0) {
      // Secrets still go through set_secrets with origin "admin".
      const result = await api.setSecrets(caller, connection.alias, pendingSecrets);
      if (!result.ok) {
        setSave({ phase: "error", message: result.error });
        return;
      }
      setValues({});
      setClearing(new Set());
    }
    setSave({ phase: "saved" });
    onSaved();
    if (!isGoogle) onClose();
  }, [
    selectionDirty,
    draftSelection,
    pendingSecrets,
    caller,
    connection.alias,
    isGoogle,
    onSaved,
    onClose,
  ]);

  const handleSave = useCallback(async () => {
    if (!hasChanges || selectionProblem) return;
    if (selectionDirty && catalog && draftSelection) {
      // Confirm before widening: list each level that brings a new scope.
      const before = googleView?.consentScopes ?? [];
      const added = consentScopesOf(catalog, draftSelection).filter(
        (s) => !before.includes(s),
      );
      const lines = pickedLevels(catalog, draftSelection)
        .filter((p) => p.level.scopes.some((s) => added.includes(s)))
        .map((p) => `${p.service} · ${p.level.id}: ${p.level.summary}`);
      const subject = draftSelection.subject;
      if (subject !== undefined && subject !== googleView?.selection?.subject) {
        lines.push(`acts as ${subject} for every selected service`);
      }
      if (lines.length > 0) {
        setWiden(lines);
        return;
      }
    }
    await doSave();
  }, [
    hasChanges,
    selectionProblem,
    selectionDirty,
    catalog,
    draftSelection,
    googleView,
    doSave,
  ]);

  const handleRemove = useCallback(async () => {
    const res = await api.deleteGoogleSelection(caller);
    setConfirmRemove(false);
    if (!res.ok) {
      setSave({ phase: "error", message: res.error });
      return;
    }
    setGoogleView(res.data);
    setDraft(draftFrom(null));
    onSaved();
  }, [caller, onSaved]);

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    setTestResult(toOutcome("Test", await api.testConnection(caller, connection.alias)));
    setTesting(false);
  }, [caller, connection.alias]);

  const addedScopes =
    widen && catalog && draftSelection
      ? consentScopesOf(catalog, draftSelection).filter(
          (s) => !(googleView?.consentScopes ?? []).includes(s),
        )
      : [];

  const hasAnySecret = requiredSecrets.length > 0 || optionalSecrets.length > 0;

  return (
    <div
      className="dl-secrets-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className={"dl-secrets-panel" + (isGoogle ? " is-wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={`Configure secrets for ${connection.name}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="dl-secrets-header">
          <div style={{ minWidth: 0 }}>
            <h2 className="dl-secrets-title">{connection.name}</h2>
            <div className="dl-secrets-alias">
              <span className="mono dl-secrets-pill">{connection.alias}</span>
              {" → "}
              <span className="mono dl-secrets-pill">{caller}</span>
            </div>
            {connection.description && (
              <p className="dl-secrets-desc">{connection.description}</p>
            )}
            {isGoogle && googleView?.problem && (
              <div className="dl-secrets-auth">
                <AuthSummary problem={googleView.problem} />
              </div>
            )}
            {!isGoogle && (connection.auth || connection.problem) && (
              <div className="dl-secrets-auth">
                <AuthSummary
                  auth={connection.auth}
                  callerAuth={connection.callerAuth}
                  problem={connection.problem}
                />
              </div>
            )}
            {connection.docsUrl && (
              <a
                className="dl-secrets-docs"
                href={connection.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={12} />
                API docs
              </a>
            )}
          </div>
          <button
            type="button"
            className="dl-secrets-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="dl-secrets-body">
          {isGoogle && googleLoadError && (
            <div className="dl-gsel-error" role="alert">
              Could not load the Google catalog: {googleLoadError}
            </div>
          )}
          {isGoogle && !googleLoadError && (!catalog || !draft) && (
            <div className="dl-secrets-help">
              <Loader2 size={12} className="dl-secrets-spin" /> Loading the
              Google catalog…
            </div>
          )}
          {isGoogle && catalog && draft && (
            <>
              <GoogleSelectionEditor
                catalog={catalog}
                draft={draft}
                saved={googleView?.selection ?? null}
                onChange={(d) => {
                  setDraft(d);
                  setTestResult(null);
                  if (save.phase !== "saving") setSave({ phase: "idle" });
                }}
              />
              {googleView?.selection && (
                <button
                  type="button"
                  className="dl-secrets-clear-btn dl-gsel-remove"
                  onClick={() => setConfirmRemove(true)}
                >
                  <X size={11} />
                  Remove this caller&apos;s Google selection
                </button>
              )}
            </>
          )}
          {isGoogle && (!catalog || !draft) ? null : !hasAnySecret ? (
            <div className="dl-secrets-empty">
              <span className="dl-secrets-empty-title">No secrets needed</span>
              This connection works without any configured secrets.
            </div>
          ) : (
            <>
              {requiredSecrets.length > 0 && (
                <div className="dl-secrets-section">
                  <h3 className="dl-secrets-section-title">
                    {isGoogle && draft
                      ? `Secrets for ${draft.auth === "user" ? "user OAuth" : "the service account"}`
                      : "Required Secrets"}
                  </h3>
                  <div className="dl-secrets-fields">
                    {requiredSecrets.map((name) => (
                      <SecretField
                        key={name}
                        name={name}
                        currentlySet={isSetMap[name] ?? false}
                        clearing={clearing.has(name)}
                        value={values[name] ?? ""}
                        onChange={(v) => setValue(name, v)}
                        onClear={() => markClear(name)}
                        onUndoClear={() => undoClear(name)}
                      />
                    ))}
                  </div>
                </div>
              )}

              {optionalSecrets.length > 0 && (
                <div className="dl-secrets-section">
                  <button
                    type="button"
                    className="dl-secrets-optional-toggle"
                    aria-expanded={showOptional}
                    onClick={() => setShowOptional((s) => !s)}
                  >
                    {showOptional ? (
                      <ChevronDown size={14} />
                    ) : (
                      <ChevronRight size={14} />
                    )}
                    Optional Secrets{" "}
                    <span className="dl-secrets-count">
                      ({optionalSecrets.length})
                    </span>
                  </button>
                  {showOptional && (
                    <div className="dl-secrets-fields">
                      {optionalSecrets.map((name) => (
                        <SecretField
                          key={name}
                          name={name}
                          currentlySet={isSetMap[name] ?? false}
                          clearing={clearing.has(name)}
                          value={values[name] ?? ""}
                          onChange={(v) => setValue(name, v)}
                          onClear={() => markClear(name)}
                          onUndoClear={() => undoClear(name)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="dl-secrets-footer">
          <div
            className={
              "dl-secrets-status" +
              (save.phase === "error" ? " is-error" : "") +
              (save.phase === "saved" ? " is-success" : "")
            }
          >
            {save.phase === "error" && save.message}
            {save.phase !== "error" && selectionProblem}
            {save.phase === "saved" && (
              <>
                <Check size={14} />
                Saved
              </>
            )}
            {isGoogle && save.phase === "saved" && (
              connection.enabled ? (
                <button
                  type="button"
                  className="dl-secrets-btn dl-secrets-btn-secondary dl-gsel-test-btn"
                  onClick={() => void runTest()}
                  disabled={testing}
                >
                  {testing && <Loader2 size={14} className="dl-secrets-spin" />}
                  Run the test now
                </button>
              ) : (
                <span>Enable the Google card to test it.</span>
              )
            )}
          </div>
          <div className="dl-secrets-actions">
            <button
              type="button"
              className="dl-secrets-btn dl-secrets-btn-secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className={
                "dl-secrets-btn dl-secrets-btn-primary" +
                (save.phase === "saved" ? " is-saved" : "")
              }
              onClick={handleSave}
              disabled={
                !hasChanges ||
                selectionProblem !== null ||
                save.phase === "saving" ||
                (save.phase === "saved" && !hasChanges)
              }
            >
              {save.phase === "saving" && (
                <Loader2 size={14} className="dl-secrets-spin" />
              )}
              {save.phase === "saved" && <Check size={14} />}
              {save.phase === "saving"
                ? "Saving…"
                : save.phase === "saved" && !hasChanges
                  ? "Saved"
                  : "Save"}
            </button>
          </div>
        </div>
        {testResult && (
          <div className="dl-gsel-test-result">
            <TestResultView result={testResult} onDismiss={() => setTestResult(null)} />
          </div>
        )}

        {/* Inside the panel, whose onClick stops propagation: a click on a
            dialog's overlay must not reach this modal's overlay. */}
        {widen && (
          <ConfirmDialog
            title={`Widen Google access for "${caller}"?`}
            confirmLabel="Save and widen"
            busy={save.phase === "saving"}
            description={
              <>
                <p>
                This selection asks for access the caller doesn&apos;t have
                now. Its agent will be able to use:
              </p>
                <ul className="dl-gsel-widen-list">
                  {widen.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {addedScopes.length > 0 && (
                  <p>
                    {draft?.auth === "service-account"
                      ? "The Admin console's domain-wide delegation entry must include: "
                      : "The refresh token must be re-consented for: "}
                    <span className="mono">
                      {addedScopes.map(shortScope).join(", ")}
                    </span>
                  </p>
                )}
              </>
            }
            onConfirm={doSave}
            onCancel={() => setWiden(null)}
          />
        )}
        {confirmRemove && (
          <ConfirmDialog
            title={`Remove "${caller}"'s Google selection?`}
            confirmLabel="Remove"
            description={
              connection.enabled
                ? "The Google connection stays enabled but is dropped for this caller until a selection is saved."
                : "The caller keeps its Google secrets; only the services and levels are removed."
            }
            onConfirm={handleRemove}
            onCancel={() => setConfirmRemove(false)}
          />
        )}
      </div>

    </div>
  );
}

// ── Secret field ───────────────────────────────────────────────────────

interface SecretFieldProps {
  name: string;
  /** Whether a value is currently stored for this secret. */
  currentlySet: boolean;
  /** Whether the user has marked this secret for deletion. */
  clearing: boolean;
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  onUndoClear: () => void;
}

function SecretField({
  name,
  currentlySet,
  clearing,
  value,
  onChange,
  onClear,
  onUndoClear,
}: SecretFieldProps) {
  const [reveal, setReveal] = useState(false);

  const placeholder = clearing
    ? "(will be removed on save)"
    : currentlySet
      ? "•••••••• (set)"
      : "Enter value";

  return (
    <div className="dl-secrets-field">
      <div className="dl-secrets-field-head">
        <label className="dl-secrets-label" htmlFor={`dl-secret-${name}`}>
          {name}
        </label>
        <div className="dl-secrets-field-meta">
          {clearing ? (
            <button
              type="button"
              className="dl-secrets-undo-btn dl-tap-compact"
              onClick={onUndoClear}
              title="Keep this secret"
            >
              <RotateCcw size={11} />
              Undo clear
            </button>
          ) : (
            currentlySet && (
              <>
                <span className="dl-secrets-set-badge">
                  <Check size={11} />
                  Set
                </span>
                <button
                  type="button"
                  className="dl-secrets-clear-btn dl-tap-compact"
                  onClick={onClear}
                  title="Remove this secret on save"
                >
                  <X size={11} />
                  Clear
                </button>
              </>
            )
          )}
        </div>
      </div>

      <div className="dl-secrets-input-wrap">
        <input
          id={`dl-secret-${name}`}
          className={"dl-secrets-input" + (clearing ? " is-clearing" : "")}
          type={reveal ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          disabled={clearing}
          value={clearing ? "" : value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        {!clearing && (
          <button
            type="button"
            className="dl-secrets-eye dl-tap-compact"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? "Hide value" : "Show value"}
            title={reveal ? "Hide value" : "Show value"}
          >
            {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </div>
      {SECRET_HELP[name] && (
        <p className="dl-secrets-help">{SECRET_HELP[name]}</p>
      )}
    </div>
  );
}
