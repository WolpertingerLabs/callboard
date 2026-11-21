/**
 * Grant and Deny dialogs for a vault access request.
 *
 * Grant offers inject (preselected) and reveal, and reveal is disabled
 * unless the item's exposure is reveal: the daemon refuses it otherwise.
 * Deny takes an optional note the requesting agent sees.
 */
import { useState } from "react";
import type { AdminVaultExposure, AdminVaultRequest } from "drawlatch-admin-types";
import { api, notifyVaultRequestsChanged } from "../../api";
import { ModalShell } from "./VaultModals";
import "../ConfigureConnectionModal.css";

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
              in its requests, within the item&apos;s connections binding, but can never read
              it.
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
      canSave={!busy}
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
            maxLength={1024}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="dl-secrets-help">
            The requesting agent sees this note in <code>vault_list_requests</code>.
          </p>
        </div>
      </div>
    </ModalShell>
  );
}
