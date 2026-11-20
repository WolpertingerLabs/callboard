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
import type { AdminConnectionStatus } from "drawlatch-admin-types";
import { api } from "../api";
import { AuthSummary, SECRET_HELP } from "./AuthSummary";
import "./ConfigureConnectionModal.css";

interface ConfigureConnectionModalProps {
  /** Caller alias to manage secrets for. */
  caller: string;
  connection: AdminConnectionStatus;
  onClose: () => void;
  /** Parent refetches connection status after this fires. */
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

  const { requiredSecrets, optionalSecrets } = connection;

  const isSetMap = useMemo<Record<string, boolean>>(
    () => ({
      ...connection.requiredSecretsSet,
      ...connection.optionalSecretsSet,
    }),
    [connection.requiredSecretsSet, connection.optionalSecretsSet],
  );

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
  const pendingSecrets = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      if (value !== "") out[name] = value;
    }
    for (const name of clearing) {
      out[name] = "";
    }
    return out;
  }, [values, clearing]);

  const hasChanges = Object.keys(pendingSecrets).length > 0;

  const handleSave = useCallback(async () => {
    if (!hasChanges) return;
    setSave({ phase: "saving" });
    const result = await api.setSecrets(caller, connection.alias, pendingSecrets);
    if (!result.ok) {
      setSave({ phase: "error", message: result.error });
      return;
    }
    setSave({ phase: "saved" });
    onSaved();
    onClose();
  }, [hasChanges, caller, connection.alias, pendingSecrets, onSaved, onClose]);

  const hasAnySecret = requiredSecrets.length > 0 || optionalSecrets.length > 0;

  return (
    <div
      className="dl-secrets-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="dl-secrets-panel"
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
            {(connection.auth || connection.problem) && (
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
          {!hasAnySecret ? (
            <div className="dl-secrets-empty">
              <span className="dl-secrets-empty-title">No secrets needed</span>
              This connection works without any configured secrets.
            </div>
          ) : (
            <>
              {requiredSecrets.length > 0 && (
                <div className="dl-secrets-section">
                  <h3 className="dl-secrets-section-title">Required Secrets</h3>
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
            {save.phase === "saved" && (
              <>
                <Check size={14} />
                Saved
              </>
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
                save.phase === "saving" ||
                save.phase === "saved"
              }
            >
              {save.phase === "saving" && (
                <Loader2 size={14} className="dl-secrets-spin" />
              )}
              {save.phase === "saved" && <Check size={14} />}
              {save.phase === "saving"
                ? "Saving…"
                : save.phase === "saved"
                  ? "Saved"
                  : "Save"}
            </button>
          </div>
        </div>
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
