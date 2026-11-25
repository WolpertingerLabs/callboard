/**
 * IssueCredentialsModal — mint (or rotate) a caller credential bundle.
 *
 * Two phases in one modal:
 *   1. Configure: confirm alias, edit the pinned endpoint, pick connections,
 *      and optionally protect the private key with a passphrase.
 *   2. Issued: the bundle is auto-downloaded as {alias}.drawlatch-caller.json
 *      with a one-time "private keys included — shown once" banner and the
 *      fingerprint to verify out-of-band. drawlatch keeps no copy of the private
 *      key, so closing the modal is the point of no return (re-issue to rotate).
 */
import { useEffect, useState } from "react";
import { KeyRound, Loader2, X, ShieldCheck, Download } from "lucide-react";
import type { CallerBundleV1 } from "drawlatch-admin-types";
import { api } from "../api";
import "./IssueCredentialsModal.css";

interface IssueCredentialsModalProps {
  alias: string;
  /** Connections currently enabled for the caller (pre-checked defaults). */
  callerConnections: string[];
  /** All selectable connection aliases (built-in templates + caller customs). */
  availableConnections: string[];
  /** Pre-filled endpoint URL the bundle pins (user-overridable). */
  defaultEndpoint: string;
  /** Whether this is a rotation (caller already has issued/auto credentials). */
  isRotation: boolean;
  onClose: () => void;
  /** Called after a successful issue so the parent can refresh the source badge. */
  onIssued: () => void;
}

/**
 * Endpoint-from-bundle override is HIDDEN for now. cloudflared tunnel URLs for
 * callboard<->drawlatch connections are ephemeral and not guaranteed to persist,
 * so we don't surface the per-bundle endpoint override; the bundle still pins
 * `defaultEndpoint` silently and the consumer (callboard) sets its server URL
 * manually. Flip to `true` to revive the override UI once endpoints are stable.
 */
const SHOW_ENDPOINT_OVERRIDE = false;

function downloadBundle(alias: string, bundle: CallerBundleV1): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${alias}.drawlatch-caller.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function IssueCredentialsModal({
  alias,
  callerConnections,
  availableConnections,
  defaultEndpoint,
  isRotation,
  onClose,
  onIssued,
}: IssueCredentialsModalProps) {
  const [endpoint, setEndpoint] = useState(defaultEndpoint);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(callerConnections),
  );
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<CallerBundleV1 | null>(null);

  // Close on Escape unless mid-flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const toggle = (conn: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(conn)) next.delete(conn);
      else next.add(conn);
      return next;
    });
  };

  const handleIssue = async () => {
    if (!endpoint.trim()) {
      setError("Endpoint URL is required.");
      return;
    }
    if (usePassphrase) {
      if (!passphrase) {
        setError("Enter a passphrase, or uncheck passphrase protection.");
        return;
      }
      if (passphrase !== confirm) {
        setError("Passphrases do not match.");
        return;
      }
    }
    setError(null);
    setBusy(true);
    const res = await api.issueCaller(alias, {
      endpointUrl: endpoint.trim(),
      connections: [...selected],
      ...(usePassphrase ? { passphrase } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // Auto-download once, then switch to the "issued" confirmation view.
    downloadBundle(alias, res.data);
    setBundle(res.data);
    setPassphrase("");
    setConfirm("");
    onIssued();
  };

  return (
    <div
      className="dl-issue-overlay"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="dl-issue-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dl-issue-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dl-issue-header">
          <div className="dl-issue-header-text">
            <span className="dl-issue-icon" aria-hidden="true">
              <KeyRound size={18} />
            </span>
            <h2 id="dl-issue-title" className="dl-issue-title">
              {bundle
                ? "Credentials issued"
                : isRotation
                  ? `Rotate credentials for "${alias}"`
                  : `Issue credentials for "${alias}"`}
            </h2>
          </div>
          <button
            type="button"
            className="dl-issue-close"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {bundle ? (
          <div className="dl-issue-body">
            <div className="dl-issue-banner">
              <ShieldCheck size={16} aria-hidden="true" />
              <span>
                The downloaded{" "}
                <code>{alias}.drawlatch-caller.json</code> contains the caller{" "}
                <strong>private keys</strong>. It is shown{" "}
                <strong>once</strong> and cannot be re-downloaded — drawlatch
                keeps only the public key. Store it securely; re-issue to rotate.
              </span>
            </div>
            <dl className="dl-issue-facts">
              <div>
                <dt>Fingerprint</dt>
                <dd className="mono">{bundle.fingerprint}</dd>
              </div>
              <div>
                <dt>Server key</dt>
                <dd className="mono">{bundle.serverKeyFingerprint}</dd>
              </div>
              {SHOW_ENDPOINT_OVERRIDE && (
                <div>
                  <dt>Endpoint</dt>
                  <dd className="mono">{bundle.endpointUrl}</dd>
                </div>
              )}
              <div>
                <dt>Private keys</dt>
                <dd>
                  {bundle.encryption
                    ? "passphrase-protected"
                    : "plaintext (protect the file)"}
                </dd>
              </div>
            </dl>
            <div className="dl-issue-footer">
              <button
                type="button"
                className="dl-issue-btn dl-issue-btn-secondary"
                onClick={() => downloadBundle(alias, bundle)}
              >
                <Download size={14} />
                Download again
              </button>
              <button
                type="button"
                className="dl-issue-btn dl-issue-btn-primary"
                onClick={onClose}
                autoFocus
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="dl-issue-body">
            {SHOW_ENDPOINT_OVERRIDE && (
              <label className="dl-issue-field">
                <span className="dl-issue-label">Endpoint URL</span>
                <input
                  type="text"
                  className="dl-issue-input mono"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://drawlatch.example.com"
                />
                <span className="dl-issue-hint">
                  The bundle pins this drawlatch endpoint for the caller.
                </span>
              </label>
            )}

            <div className="dl-issue-field">
              <span className="dl-issue-label">
                Connections ({selected.size})
              </span>
              {availableConnections.length === 0 ? (
                <span className="dl-issue-hint">
                  No connections available.
                </span>
              ) : (
                <div className="dl-issue-conns">
                  {availableConnections.map((conn) => (
                    <label key={conn} className="dl-issue-conn">
                      <input
                        type="checkbox"
                        checked={selected.has(conn)}
                        onChange={() => toggle(conn)}
                      />
                      <span className="mono">{conn}</span>
                    </label>
                  ))}
                </div>
              )}
              <span className="dl-issue-hint">
                Informational in the bundle — authorization is enforced
                server-side.
              </span>
            </div>

            <div className="dl-issue-field">
              <label className="dl-issue-check">
                <input
                  type="checkbox"
                  checked={usePassphrase}
                  onChange={(e) => setUsePassphrase(e.target.checked)}
                />
                <span>Protect the private key with a passphrase</span>
              </label>
              {usePassphrase && (
                <div className="dl-issue-pass">
                  <input
                    type="password"
                    className="dl-issue-input"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="passphrase"
                    autoComplete="new-password"
                  />
                  <input
                    type="password"
                    className="dl-issue-input"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="confirm passphrase"
                    autoComplete="new-password"
                  />
                  <span className="dl-issue-hint">
                    For transfer over untrusted media — share the passphrase
                    out-of-band. Skip for same-host/local.
                  </span>
                </div>
              )}
            </div>

            {isRotation && (
              <div className="dl-issue-warn">
                Rotating mints a fresh keypair and{" "}
                <strong>invalidates the prior credential</strong> immediately.
              </div>
            )}

            {error && <div className="dl-issue-error">{error}</div>}

            <div className="dl-issue-footer">
              <button
                type="button"
                className="dl-issue-btn dl-issue-btn-secondary"
                disabled={busy}
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                type="button"
                className="dl-issue-btn dl-issue-btn-primary"
                disabled={busy}
                onClick={() => void handleIssue()}
              >
                {busy && <Loader2 size={14} className="dl-issue-spin" />}
                {isRotation ? "Rotate & download" : "Issue & download"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
