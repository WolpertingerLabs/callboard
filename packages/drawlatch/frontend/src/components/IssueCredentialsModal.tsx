/**
 * IssueCredentialsModal — mint (or rotate) a caller credential bundle.
 *
 * Two phases in one modal:
 *   1. Configure: pick connections, and optionally protect the private key
 *      with a passphrase.
 *   2. Issued: the bundle is auto-downloaded as {alias}.drawlatch-caller.json
 *      with a one-time "private keys included" banner and the fingerprint to
 *      verify out-of-band. Drawlatch keeps no copy of the private key, so
 *      closing this view is the point of no return (re-issue to rotate). A
 *      backdrop click does nothing here; Escape, ×, and browser Back ask
 *      first; reloading or closing the tab gets the browser's "Leave site?"
 *      prompt. Only "Done" closes it straight away.
 *
 * The parent must keep this mounted whatever else its page does (offline,
 * a failed refresh): unmounting it throws the bundle away.
 */
import { useEffect, useRef, useState } from "react";
import { Download, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import type { CallerBundleV1 } from "drawlatch-admin-types";
import { api } from "../api";
import { useDaemon } from "../contexts/DaemonContext";
import Modal from "./Modal";
import ConfirmDialog from "./ConfirmDialog";
import "./IssueCredentialsModal.css";

interface IssueCredentialsModalProps {
  alias: string;
  /** Connections currently enabled for the caller (pre-checked defaults). */
  callerConnections: string[];
  /** All selectable connection aliases (built-in templates + caller customs). */
  availableConnections: string[];
  /** The template list failed to load: only the caller's own are offered. */
  connectionsIncomplete?: boolean;
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
  // Revoking at once can cancel the download in Firefox and Safari.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export default function IssueCredentialsModal({
  alias,
  callerConnections,
  availableConnections,
  connectionsIncomplete = false,
  defaultEndpoint,
  isRotation,
  onClose,
  onIssued,
}: IssueCredentialsModalProps) {
  const [endpoint, setEndpoint] = useState(defaultEndpoint);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(callerConnections));
  const [usePassphrase, setUsePassphrase] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<CallerBundleV1 | null>(null);
  // Why "Close without the file?" is up: Escape/× ("close") or browser
  // Back ("back"), which also leaves the page once confirmed.
  const [confirmClose, setConfirmClose] = useState<null | "close" | "back">(null);
  const leavingRef = useRef(false);
  const doneRef = useRef<HTMLButtonElement>(null);
  const { daemon } = useDaemon();
  const offline = daemon === "down";

  // While the bundle is on screen, leaving the page has to ask too.
  // - Reload / close tab / typed URL: the browser's own beforeunload prompt.
  // - Back: a guard entry (same URL) sits on top of the history, so Back
  //   only pops it. We put it back and ask; confirming then goes back for
  //   real. The router sees the same location and renders nothing new.
  useEffect(() => {
    if (!bundle) return;
    const pushGuard = () =>
      window.history.pushState(
        { ...(window.history.state ?? {}), dlIssueGuard: true },
        "",
        window.location.href,
      );
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onPop = () => {
      pushGuard();
      setConfirmClose("back");
    };
    pushGuard();
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("popstate", onPop);
      // Drop our guard entry (and, after a confirmed Back, the page too).
      if (window.history.state?.dlIssueGuard) {
        window.history.go(leavingRef.current ? -2 : -1);
      }
    };
  }, [bundle]);

  // The form (and the focused submit button) is gone once issued: put focus
  // on Done so the keyboard isn't left on <body>.
  useEffect(() => {
    if (bundle) doneRef.current?.focus();
  }, [bundle]);

  const toggle = (conn: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(conn)) next.delete(conn);
      else next.add(conn);
      return next;
    });
  };

  // Configure phase: typed passphrases are the only thing worth guarding.
  const dirty = passphrase !== "" || confirm !== "";

  const requestClose = () => {
    if (busy) return;
    if (bundle || dirty) setConfirmClose("close");
    else onClose();
  };

  const handleIssue = async () => {
    if (busy || offline) return;
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

  const title = bundle
    ? "Credentials issued"
    : isRotation
      ? `Rotate credentials for "${alias}"`
      : `Issue credentials for "${alias}"`;

  const footer = bundle ? (
    <>
      <button
        type="button"
        className="btn btn-secondary"
        onClick={() => downloadBundle(alias, bundle)}
      >
        <Download size={14} aria-hidden="true" />
        Download again
      </button>
      <button ref={doneRef} type="button" className="btn btn-primary" onClick={onClose}>
        Done
      </button>
    </>
  ) : (
    <>
      {offline ? (
        <div className="modal-error dl-issue-footer-error" role="status">
          The Drawlatch daemon isn&apos;t reachable, so credentials can&apos;t be issued right
          now. Your choices here are kept.
        </div>
      ) : (
        error && (
          <div className="modal-error dl-issue-footer-error" role="alert">
            {error}
          </div>
        )
      )}
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={requestClose}>
        Cancel
      </button>
      <button
        type="submit"
        form="dl-issue-form"
        className="btn btn-primary"
        disabled={busy || offline}
      >
        {busy && <Loader2 size={14} className="spinner" aria-hidden="true" />}
        {isRotation ? "Rotate and download" : "Issue and download"}
      </button>
    </>
  );

  return (
    <Modal
      open
      title={title}
      subtitle={bundle ? <span className="mono">{alias}</span> : undefined}
      icon={bundle ? <ShieldCheck size={18} /> : <KeyRound size={18} />}
      onClose={requestClose}
      dismissible={!bundle && !dirty}
      busy={busy}
      footer={footer}
      className="dl-issue-panel"
    >
      {bundle ? (
        <div className="dl-issue-body">
          <div className="dl-issue-banner" role="status">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>
              The downloaded <code>{alias}.drawlatch-caller.json</code> contains the caller&apos;s{" "}
              <strong>private keys</strong>. This is the <strong>only</strong> copy: Drawlatch
              keeps just the public key, and the file can&apos;t be downloaded again once you
              close this. Store it securely; issue again to rotate.
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
                {bundle.encryption ? "Passphrase-protected" : "Plaintext (protect the file)"}
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        <form
          id="dl-issue-form"
          className="dl-issue-body"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void handleIssue();
          }}
        >
          {SHOW_ENDPOINT_OVERRIDE && (
            <div className="dl-issue-field">
              <label className="field-label" htmlFor="dl-issue-endpoint">
                Endpoint URL
              </label>
              <input
                id="dl-issue-endpoint"
                type="text"
                className="input mono"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://drawlatch.example.com"
              />
              <span className="dl-issue-hint">
                The bundle pins this Drawlatch endpoint for the caller.
              </span>
            </div>
          )}

          <fieldset className="dl-issue-field">
            <legend className="field-label">Connections ({selected.size})</legend>
            {availableConnections.length === 0 ? (
              <span className="dl-issue-hint">No connections available.</span>
            ) : (
              <div className="dl-issue-conns">
                {availableConnections.map((conn) => (
                  <label
                    key={conn}
                    className={`dl-issue-conn${selected.has(conn) ? " is-checked" : ""}`}
                  >
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
              {connectionsIncomplete &&
                "Couldn't load the full connection list, so only this caller's are shown. "}
              Informational in the bundle: authorization is enforced by the daemon.
            </span>
          </fieldset>

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
                <div>
                  <label className="field-label" htmlFor="dl-issue-pass">
                    Passphrase
                  </label>
                  <input
                    id="dl-issue-pass"
                    type="password"
                    className="input"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
                <div>
                  <label className="field-label" htmlFor="dl-issue-pass-confirm">
                    Confirm passphrase
                  </label>
                  <input
                    id="dl-issue-pass-confirm"
                    type="password"
                    className="input"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                  />
                </div>
                <span className="dl-issue-hint">
                  For transfer over untrusted media: share the passphrase out-of-band. Skip it for
                  a callboard on the same host.
                </span>
              </div>
            )}
          </div>

          {isRotation && (
            <div className="dl-issue-warn">
              Rotating mints a fresh keypair and <strong>invalidates the prior credential</strong>{" "}
              immediately.
            </div>
          )}
        </form>
      )}

      {confirmClose && (
        <ConfirmDialog
          variant={bundle ? "neutral" : "danger"}
          title={bundle ? "Close without the file?" : "Discard the passphrase?"}
          description={
            bundle ? (
              <>
                Make sure <code>{alias}.drawlatch-caller.json</code> was saved. Once this closes it
                can&apos;t be downloaded again; you would have to rotate the credentials.
              </>
            ) : (
              "The passphrase you typed will be lost."
            )
          }
          confirmLabel={bundle ? (confirmClose === "back" ? "Close and go back" : "Close") : "Discard"}
          cancelLabel={bundle ? "Keep open" : "Keep editing"}
          onConfirm={() => {
            leavingRef.current = confirmClose === "back";
            setConfirmClose(null);
            onClose();
          }}
          onCancel={() => setConfirmClose(null)}
        />
      )}
    </Modal>
  );
}
