/**
 * Grant and Deny dialogs for a vault access request.
 *
 * Grant offers inject (preselected) and reveal, and reveal is disabled
 * unless the item's exposure is reveal: the daemon refuses it otherwise.
 * Deny takes an optional note the requesting agent sees.
 */
import { useState } from "react";
import type {
  AdminVaultExposure,
  AdminVaultItemRef,
  AdminVaultRequest,
} from "drawlatch-admin-types";
import { api, notifyVaultRequestsChanged } from "../../api";
import { ModalShell } from "./VaultModals";
import "../ConfigureConnectionModal.css";

/** The deny-note limit, in UTF-8 bytes, as the daemon counts it. */
export const MAX_NOTE_BYTES = 1024;

/** UTF-8 length, the unit the daemon's 1 KiB limits use. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Where an item may be used: its connections binding, or that it has none. */
export function Binding({ item, grantee }: { item: AdminVaultItemRef; grantee: string }) {
  if (item.connections === undefined) {
    return (
      <span className="dl-vault-unbound">
        not bound: usable on any of <span className="mono">{grantee}</span>&apos;s connections
      </span>
    );
  }
  if (item.connections.length === 0) return <span>bound to no connection</span>;
  return (
    <span>
      bound to <span className="mono">{item.connections.join(", ")}</span>
    </span>
  );
}

function Subject({ request }: { request: AdminVaultRequest }) {
  return (
    <>
      <span className="mono dl-secrets-pill">{request.requester}</span> →{" "}
      <span className="mono">
        {request.owner}/{request.item?.name ?? request.itemName}
      </span>
    </>
  );
}

export function GrantRequestModal({
  request,
  onClose,
  onDone,
}: {
  request: AdminVaultRequest;
  onClose: () => void;
  onDone: () => void;
}) {
  const revealAllowed = request.item?.exposure === "reveal";
  const unbound = request.item?.connections === undefined;
  const [mode, setMode] = useState<AdminVaultExposure>("inject");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    const res = await api.vaultGrant(request.id, mode);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    notifyVaultRequestsChanged();
    onDone();
    onClose();
  };

  return (
    <ModalShell
      title="Grant access"
      subtitle={<Subject request={request} />}
      busy={busy}
      error={error}
      saveLabel="Grant"
      canSave={!busy}
      onSave={() => void save()}
      onClose={onClose}
    >
      {request.item && (
        <div className="dl-secrets-section">
          <h3 className="dl-secrets-section-title">Where it can be used</h3>
          <p className="dl-secrets-help">
            <Binding item={request.item} grantee={request.requester} />. Change the binding on
            the Items tab before granting if it should be narrower.
          </p>
        </div>
      )}
      <div className="dl-secrets-section">
        <h3 className="dl-secrets-section-title">Mode</h3>
        <p className="dl-secrets-help">
          The agent asked for <strong>{request.mode}</strong>.
        </p>
        <div className="dl-vault-radio-group">
          <label className="dl-vault-radio">
            <input
              type="radio"
              name="dl-vault-grant-mode"
              checked={mode === "inject"}
              onChange={() => setMode("inject")}
            />
            <span>
              <strong>Inject</strong>: <code>{request.requester}</code> can use it as{" "}
              <code>{`\${vault:${request.owner}/${request.item?.name ?? request.itemName}}`}</code>{" "}
              in its requests, and no tool returns the value to it.
              {unbound ? (
                <>
                  {" "}
                  The item isn&apos;t bound to a connection, so it can send the value to any API
                  it has enabled. One that stores what it&apos;s sent and returns it later (a
                  card title, say) gives the value back: bind the item to the connection that
                  needs it first.
                </>
              ) : (
                <>
                  {" "}
                  It can send the value only to the item&apos;s bound connections. An API there
                  that stores what it&apos;s sent and returns it later could still give it back.
                </>
              )}
            </span>
          </label>
          <label className="dl-vault-radio">
            <input
              type="radio"
              name="dl-vault-grant-mode"
              checked={mode === "reveal"}
              disabled={!revealAllowed}
              onChange={() => setMode("reveal")}
            />
            <span className={revealAllowed ? undefined : "cell-muted"}>
              <strong>Reveal</strong>: it can also read the value with <code>vault_get</code>.
              {!revealAllowed && " Only available when the item's exposure is reveal."}
            </span>
          </label>
        </div>
      </div>
    </ModalShell>
  );
}

export function DenyRequestModal({
  request,
  onClose,
  onDone,
}: {
  request: AdminVaultRequest;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const noteBytes = utf8Bytes(note.trim());
  const tooLong = noteBytes > MAX_NOTE_BYTES;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    const res = await api.vaultDeny(request.id, note.trim() || undefined);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    notifyVaultRequestsChanged();
    onDone();
    onClose();
  };

  return (
    <ModalShell
      title="Deny request"
      subtitle={<Subject request={request} />}
      busy={busy}
      error={error}
      saveLabel="Deny"
      canSave={!busy && !tooLong}
      onSave={() => void save()}
      onClose={onClose}
    >
      <div className="dl-secrets-fields">
        <div className="dl-secrets-field">
          <label className="dl-secrets-label" htmlFor="dl-vault-deny-note">
            Note (optional)
          </label>
          <textarea
            id="dl-vault-deny-note"
            className="dl-secrets-input dl-vault-textarea"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className={"dl-secrets-help" + (tooLong ? " dl-vault-over" : "")}>
            {noteBytes} / {MAX_NOTE_BYTES} bytes (UTF-8, as the daemon counts them). The
            requesting agent sees this note in <code>vault_list_requests</code>.
          </p>
        </div>
      </div>
    </ModalShell>
  );
}
