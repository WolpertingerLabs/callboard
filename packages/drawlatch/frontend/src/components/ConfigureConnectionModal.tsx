import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RotateCcw,
  RotateCw,
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
import EmptyState from "./EmptyState";
import GoogleSelectionEditor from "./GoogleSelectionEditor";
import Modal from "./Modal";
import { useToast } from "./Toast";
import {
  addedScopes,
  draftFrom,
  draftProblem,
  selectionChanged,
  selectionFrom,
  wideningReasons,
  type GoogleDraft,
} from "../utils/googleSelection";
import { TestResultView, toOutcome, type TestOutcome } from "./TestResult";
import { toolResult } from "../utils/toolResult";
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

type GoogleLoad = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready" };

export default function ConfigureConnectionModal({
  caller,
  connection,
  onClose,
  onSaved,
}: ConfigureConnectionModalProps) {
  const toast = useToast();
  // Pending new values, keyed by secret name (only modified fields are sent).
  const [values, setValues] = useState<Record<string, string>>({});
  // Secrets the user marked for deletion (sent as empty string on save).
  const [clearing, setClearing] = useState<Set<string>>(new Set());
  const [showOptional, setShowOptional] = useState(false);
  const [save, setSave] = useState<SaveState>({ phase: "idle" });
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Initial focus: the first secret, not the docs link above it.
  const firstInputRef = useRef<HTMLInputElement>(null);

  // Async work can finish after the dialog is gone (the parent unmounts it).
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  // ── Google: the selection editor (callers.<alias>.google) ──
  const isGoogle = connection.composed === "google";
  const [catalog, setCatalog] = useState<AdminGoogleCatalog | null>(null);
  const [googleView, setGoogleView] = useState<AdminGoogleSelection | null>(null);
  const [googleLoad, setGoogleLoad] = useState<GoogleLoad>({ phase: "loading" });
  const [googleLoadKey, setGoogleLoadKey] = useState(0);
  const [draft, setDraft] = useState<GoogleDraft | null>(null);
  const [widen, setWiden] = useState<string[] | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);

  useEffect(() => {
    if (!isGoogle) return;
    let live = true;
    setGoogleLoad({ phase: "loading" });
    Promise.all([api.googleCatalog(), api.googleSelection(caller)])
      .then(([cat, view]) => {
        if (!live) return;
        if (isDaemonDown(cat)) return setGoogleLoad({ phase: "error", message: cat.error });
        if (isDaemonDown(view)) return setGoogleLoad({ phase: "error", message: view.error });
        setCatalog(cat);
        setGoogleView(view);
        setDraft(draftFrom(view.selection));
        setGoogleLoad({ phase: "ready" });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setGoogleLoad({
          phase: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      live = false;
    };
  }, [isGoogle, caller, googleLoadKey]);

  const draftSelection = useMemo(
    () => (catalog && draft ? selectionFrom(catalog, draft) : null),
    [catalog, draft],
  );
  const selectionDirty =
    draftSelection !== null && selectionChanged(googleView?.selection ?? null, draftSelection);
  // Only a draft the user changed is checked: an untouched editor shows no
  // validation error, and Save stays disabled until there is something to save.
  const selectionProblem = selectionDirty && catalog && draft ? draftProblem(catalog, draft) : null;

  // For google, the secrets section follows the draft's auth mode.
  const modeSecrets =
    isGoogle && catalog && draft
      ? (catalog.authModes.find((m) => m.id === draft.auth)?.secrets ?? [])
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

  // Any edit clears a stale "Saved" (or an old error) from the footer.
  const touched = useCallback(() => {
    setSave((s) => (s.phase === "saving" || s.phase === "idle" ? s : { phase: "idle" }));
  }, []);

  const setValue = useCallback(
    (name: string, value: string) => {
      setValues((prev) => ({ ...prev, [name]: value }));
      // Typing into a field un-marks it for clearing.
      setClearing((prev) => {
        if (!prev.has(name)) return prev;
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
      touched();
    },
    [touched],
  );

  const markClear = useCallback(
    (name: string) => {
      setClearing((prev) => new Set(prev).add(name));
      setValues((prev) => {
        if (!(name in prev)) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      });
      touched();
    },
    [touched],
  );

  const undoClear = useCallback(
    (name: string) => {
      setClearing((prev) => {
        if (!prev.has(name)) return prev;
        const next = new Set(prev);
        next.delete(name);
        return next;
      });
      touched();
    },
    [touched],
  );

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
  // Typed but not yet counted (a value for the other Google mode) still
  // deserves a "Discard changes?".
  const hasEdits = hasChanges || Object.values(values).some((v) => v !== "");
  const saving = save.phase === "saving";

  /** Escape, ×, Cancel: ask first when something would be lost. */
  const requestClose = useCallback(() => {
    if (saving || removing) return;
    if (hasEdits) setConfirmDiscard(true);
    else onClose();
  }, [saving, removing, hasEdits, onClose]);

  const doSave = useCallback(async () => {
    setSave({ phase: "saving" });
    const secretCount = Object.keys(pendingSecrets).length;
    if (selectionDirty && draftSelection) {
      // Written by the admin Google route directly, never through a tool.
      const put = await api.setGoogleSelection(caller, draftSelection);
      if (!mounted.current) return;
      if (!put.ok) {
        setWiden(null);
        setSave({ phase: "error", message: put.error });
        return;
      }
      setGoogleView(put.data);
      setDraft(draftFrom(put.data.selection));
    }
    const selectionSaved = selectionDirty && draftSelection !== null;
    if (secretCount > 0) {
      // Secrets still go through set_secrets with origin "admin".
      const result = toolResult(await api.setSecrets(caller, connection.alias, pendingSecrets));
      if (!mounted.current) return;
      if (!result.ok) {
        setWiden(null);
        if (selectionSaved) {
          // The selection did save: refresh the card, and say which half failed.
          onSaved();
          setSave({
            phase: "error",
            message: `Selection saved, but the secrets were not: ${result.error}`,
          });
        } else {
          setSave({ phase: "error", message: result.error });
        }
        return;
      }
      setValues({});
      setClearing(new Set());
    }
    setWiden(null);
    setSave({ phase: "saved" });
    onSaved();
    const what =
      selectionSaved && secretCount > 0
        ? "Google selection and secrets saved"
        : selectionSaved
          ? "Google selection saved"
          : secretCount === 1
            ? "Secret saved"
            : "Secrets saved";
    toast.show(`${what} for ${connection.name} (${caller})`);
    if (!isGoogle) onClose();
  }, [
    selectionDirty,
    draftSelection,
    pendingSecrets,
    caller,
    connection.alias,
    connection.name,
    isGoogle,
    onSaved,
    onClose,
    toast,
  ]);

  const handleSave = useCallback(async () => {
    if (!hasChanges || selectionProblem || saving) return;
    if (selectionDirty && catalog && draftSelection) {
      // Confirm whenever reach could grow: a new scope, a mode change, or a
      // subject set or changed.
      const lines = wideningReasons(catalog, googleView?.selection ?? null, draftSelection);
      if (lines.length > 0) {
        setWiden(lines);
        return;
      }
    }
    await doSave();
  }, [
    hasChanges,
    selectionProblem,
    saving,
    selectionDirty,
    catalog,
    draftSelection,
    googleView,
    doSave,
  ]);

  const handleRemove = useCallback(async () => {
    if (removing) return;
    setRemoving(true);
    setRemoveError(null);
    const res = await api.deleteGoogleSelection(caller);
    if (!mounted.current) return;
    setRemoving(false);
    if (!res.ok) {
      setRemoveError(res.error);
      return;
    }
    setConfirmRemove(false);
    setGoogleView(res.data);
    setDraft(draftFrom(null));
    setSave({ phase: "idle" });
    setTestResult(null);
    onSaved();
    toast.show(`Removed ${caller}'s Google selection`);
  }, [caller, onSaved, removing, toast]);

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    const res = await api.testConnection(caller, connection.alias);
    if (!mounted.current) return;
    setTestResult(toOutcome("Test", res));
    setTesting(false);
  }, [caller, connection.alias]);

  const newScopes =
    widen && catalog && draftSelection
      ? addedScopes(catalog, googleView?.selection ?? null, draftSelection)
      : [];

  const hasAnySecret = requiredSecrets.length > 0 || optionalSecrets.length > 0;
  const googleReady = isGoogle && googleLoad.phase === "ready" && catalog && draft;

  const statusText =
    save.phase === "error" ? save.message : save.phase !== "saved" ? selectionProblem : null;

  const footer = (
    <>
      {testResult && (
        <div className="dl-cfg-footer-result">
          <TestResultView result={testResult} onDismiss={() => setTestResult(null)} />
        </div>
      )}
      {(statusText || save.phase === "saved") && (
        <div
          className={
            "dl-cfg-status" +
            (save.phase === "error" ? " is-error" : "") +
            (save.phase === "saved" ? " is-success" : "")
          }
          role={save.phase === "error" ? "alert" : "status"}
        >
          {statusText}
          {save.phase === "saved" && (
            <>
              <Check size={14} aria-hidden="true" />
              Saved
              {isGoogle &&
                (connection.enabled ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm dl-cfg-test-btn"
                    onClick={() => void runTest()}
                    disabled={testing}
                  >
                    {testing && <Loader2 size={13} className="spinner" aria-hidden="true" />}
                    Run the test now
                  </button>
                ) : (
                  <span className="dl-cfg-status-note">Enable the Google card to test it.</span>
                ))}
            </>
          )}
        </div>
      )}
      <button type="button" className="btn btn-secondary" onClick={requestClose} disabled={saving}>
        {save.phase === "saved" && !hasEdits ? "Done" : "Cancel"}
      </button>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => void handleSave()}
        disabled={!hasChanges || selectionProblem !== null || saving}
      >
        {saving && <Loader2 size={14} className="spinner" aria-hidden="true" />}
        {saving ? "Saving…" : "Save"}
      </button>
    </>
  );

  return (
    <>
      <Modal
        open
        title={connection.name}
        subtitle={
          <span className="dl-cfg-route">
            <span className="mono dl-secrets-pill">{connection.alias}</span>
            <span aria-hidden="true">→</span>
            <span className="sr-only">for caller</span>
            <span className="mono dl-secrets-pill">{caller}</span>
          </span>
        }
        icon={<KeyRound size={16} />}
        size={isGoogle ? "lg" : "md"}
        className={isGoogle ? "dl-cfg-wide" : undefined}
        bodyClassName="dl-cfg-body"
        // Unsaved edits: the backdrop doesn't close it, and Escape/× ask first.
        dismissible={!hasEdits}
        busy={saving || removing}
        onClose={requestClose}
        initialFocusRef={isGoogle ? undefined : firstInputRef}
        footer={footer}
      >
        {/* ── About ── */}
        {(connection.description ||
          connection.docsUrl ||
          (isGoogle && googleView?.problem) ||
          (!isGoogle && (connection.auth || connection.problem))) && (
          <div className="dl-cfg-intro">
            {connection.description && <p className="dl-cfg-desc">{connection.description}</p>}
            {isGoogle && googleView?.problem && <AuthSummary problem={googleView.problem} />}
            {!isGoogle && (connection.auth || connection.problem) && (
              <AuthSummary
                auth={connection.auth}
                callerAuth={connection.callerAuth}
                problem={connection.problem}
              />
            )}
            {connection.docsUrl && (
              <a
                className="dl-cfg-docs"
                href={connection.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={12} aria-hidden="true" />
                API docs
              </a>
            )}
          </div>
        )}

        {/* ── Google services ── */}
        {isGoogle && googleLoad.phase === "error" && (
          <div className="modal-error dl-cfg-load-error" role="alert">
            <span>Couldn&apos;t load the Google catalog: {googleLoad.message}</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setGoogleLoadKey((k) => k + 1)}
            >
              <RotateCw size={13} aria-hidden="true" />
              Retry
            </button>
          </div>
        )}
        {isGoogle && googleLoad.phase === "loading" && (
          <div className="dl-cfg-loading" role="status">
            <Loader2 size={14} className="spinner" aria-hidden="true" />
            Loading the Google catalog…
          </div>
        )}
        {googleReady && (
          <>
            <GoogleSelectionEditor
              catalog={catalog}
              draft={draft}
              saved={googleView?.selection ?? null}
              onChange={(d) => {
                setDraft(d);
                setTestResult(null);
                touched();
              }}
            />
            {googleView?.selection && (
              <button
                type="button"
                className="btn btn-danger-outline btn-sm dl-gsel-remove"
                onClick={() => {
                  setRemoveError(null);
                  setConfirmRemove(true);
                }}
              >
                <X size={13} aria-hidden="true" />
                Remove this caller&apos;s Google selection
              </button>
            )}
          </>
        )}

        {/* ── Secrets ── */}
        {isGoogle && !googleReady ? null : !hasAnySecret ? (
          <EmptyState
            compact
            icon={<Check size={20} />}
            title="No secrets needed"
            body="This connection works without any configured secrets."
          />
        ) : (
          <>
            {requiredSecrets.length > 0 && (
              <div className="dl-secrets-section">
                <h3 className="dl-secrets-section-title">
                  {isGoogle && draft
                    ? `Secrets for ${draft.auth === "user" ? "user OAuth" : "the service account"}`
                    : "Required secrets"}
                </h3>
                <div className="dl-secrets-fields">
                  {requiredSecrets.map((name, i) => (
                    <SecretField
                      key={name}
                      inputRef={i === 0 ? firstInputRef : undefined}
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
                    <ChevronDown size={14} aria-hidden="true" />
                  ) : (
                    <ChevronRight size={14} aria-hidden="true" />
                  )}
                  Optional secrets{" "}
                  <span className="dl-secrets-count">({optionalSecrets.length})</span>
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
      </Modal>

      {widen && (
        <ConfirmDialog
          title={`Widen Google access for "${caller}"?`}
          confirmLabel="Save and widen"
          variant="neutral"
          busy={saving}
          description={
            <>
              <p>This change can let the caller&apos;s agent reach more than it can now:</p>
              <ul className="dl-gsel-widen-list">
                {widen.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              {newScopes.length > 0 && (
                <p>
                  {draft?.auth === "service-account"
                    ? "The Admin console's domain-wide delegation entry must include: "
                    : "The refresh token must be re-consented for: "}
                  <span className="mono">{newScopes.map(shortScope).join(", ")}</span>
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
          busy={removing}
          error={removeError}
          description={
            connection.enabled
              ? "The Google connection stays enabled but is dropped for this caller until a selection is saved."
              : "The caller keeps its Google secrets; only the services and levels are removed."
          }
          onConfirm={handleRemove}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard changes?"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          description={
            <>
              Your changes to <strong>{connection.name}</strong> for <code>{caller}</code>{" "}
              haven&apos;t been saved.
            </>
          }
          onConfirm={() => {
            setConfirmDiscard(false);
            onClose();
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </>
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
  inputRef?: React.Ref<HTMLInputElement>;
}

function SecretField({
  name,
  currentlySet,
  clearing,
  value,
  onChange,
  onClear,
  onUndoClear,
  inputRef,
}: SecretFieldProps) {
  const [reveal, setReveal] = useState(false);
  const inputId = `dl-secret-${name}`;
  const helpId = SECRET_HELP[name] ? `${inputId}-help` : undefined;

  const placeholder = clearing
    ? "(will be removed on save)"
    : currentlySet
      ? "•••••••• (set)"
      : "Enter value";

  return (
    <div className="dl-secrets-field">
      <div className="dl-secrets-field-head">
        <label className="dl-secrets-label" htmlFor={inputId}>
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
              <RotateCcw size={11} aria-hidden="true" />
              Undo clear
            </button>
          ) : (
            currentlySet && (
              <>
                <span className="dl-secrets-set-badge">
                  <Check size={11} aria-hidden="true" />
                  Set
                </span>
                <button
                  type="button"
                  className="dl-secrets-clear-btn dl-tap-compact"
                  onClick={onClear}
                  title="Remove this secret on save"
                  aria-label={`Clear ${name}`}
                >
                  <X size={11} aria-hidden="true" />
                  Clear
                </button>
              </>
            )
          )}
        </div>
      </div>

      <div className="dl-secrets-input-wrap">
        <input
          ref={inputRef}
          id={inputId}
          className={"dl-secrets-input" + (clearing ? " is-clearing" : "")}
          type={reveal ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          disabled={clearing}
          value={clearing ? "" : value}
          placeholder={placeholder}
          aria-describedby={helpId}
          onChange={(e) => onChange(e.target.value)}
        />
        {!clearing && (
          <button
            type="button"
            className="dl-secrets-eye dl-tap-compact"
            onClick={() => setReveal((r) => !r)}
            aria-label={reveal ? `Hide ${name}` : `Show ${name}`}
            aria-pressed={reveal}
            title={reveal ? "Hide value" : "Show value"}
          >
            {reveal ? (
              <EyeOff size={14} aria-hidden="true" />
            ) : (
              <Eye size={14} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
      {helpId && (
        <p className="dl-secrets-help" id={helpId}>
          {SECRET_HELP[name]}
        </p>
      )}
    </div>
  );
}
