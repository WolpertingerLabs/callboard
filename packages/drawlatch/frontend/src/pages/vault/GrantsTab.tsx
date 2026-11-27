/**
 * Vault → Grants: active grants with Revoke; revoked ones collapsed below.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, Share2 } from "lucide-react";
import type { AdminVaultGrant } from "drawlatch-admin-types";
import { api, isDaemonDown, notifyVaultRequestsChanged } from "../../api";
import { useDaemon } from "../../contexts/DaemonContext";
import ConfirmDialog from "../../components/ConfirmDialog";
import EmptyState, { LoadingState } from "../../components/EmptyState";
import { useToast } from "../../components/Toast";
import { ModeBadge } from "../../components/vault/labels";
import { useIsMobile } from "../../hooks/useIsMobile";

type Load =
  | { status: "loading" }
  | { status: "ok"; data: AdminVaultGrant[] }
  | { status: "error"; message: string };

const REVOKED_REASON: Record<NonNullable<AdminVaultGrant["revokedReason"]>, string> = {
  admin: "Revoked by you",
  item_deleted: "Item deleted",
  caller_deleted: "Caller deleted",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function ModeCell({ g }: { g: AdminVaultGrant }) {
  const effective = g.effectiveMode ?? g.mode;
  return (
    <>
      <ModeBadge mode={effective} />
      {g.effectiveMode !== null && g.effectiveMode !== g.mode && (
        <div className="cell-secondary">
          Granted {g.mode}; the item is inject, so it works inject-only
        </div>
      )}
    </>
  );
}

export default function GrantsTab({ onChanged }: { onChanged: () => void }) {
  const isMobile = useIsMobile();
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [revoking, setRevoking] = useState<AdminVaultGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    const res = await api.vaultGrants();
    if (mine !== seq.current) return;
    if (isDaemonDown(res)) {
      setLoad((prev) => (prev.status === "ok" ? prev : { status: "error", message: res.error }));
      return;
    }
    setLoad({ status: "ok", data: res });
  }, []);

  // Back from an offline blip: reload what may have changed meanwhile.
  const { daemon } = useDaemon();
  const wasDown = useRef(false);
  useEffect(() => {
    if (daemon === "down") wasDown.current = true;
    else if (daemon === "up" && wasDown.current) {
      wasDown.current = false;
      void refresh();
    }
  }, [daemon, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const itemName = (g: AdminVaultGrant) => `${g.owner}/${g.item?.name ?? "(deleted item)"}`;

  const revoke = async (g: AdminVaultGrant) => {
    setBusy(true);
    setError(null);
    const res = await api.vaultRevoke(g.id);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setRevoking(null);
    toast.show(`Revoked ${g.grantee}'s access to ${itemName(g)}`);
    notifyVaultRequestsChanged();
    void refresh();
    onChanged();
  };

  const active = load.status === "ok" ? load.data.filter((g) => g.status === "active") : [];
  const revoked = load.status === "ok" ? load.data.filter((g) => g.status === "revoked") : [];

  const revokeButton = (g: AdminVaultGrant) => (
    <button
      type="button"
      className="btn btn-danger-outline btn-sm"
      aria-label={`Revoke ${g.grantee}'s access to ${itemName(g)}`}
      onClick={() => {
        setError(null);
        setRevoking(g);
      }}
    >
      <Ban size={14} aria-hidden="true" />
      Revoke
    </button>
  );

  return (
    <>
      <p className="detail-note dl-vault-intro">
        A grant lets another caller use an item as <code>{"${vault:owner/name}"}</code>, limited
        to the item&apos;s bound connections. Reveal grants can also read the value. Revoking takes
        effect on the next request.
      </p>

      {load.status === "loading" && <LoadingState label="Loading grants…" />}
      {load.status === "error" && (
        <div className="banner banner-offline" role="alert">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load grants: {load.message}</span>
        </div>
      )}

      {load.status === "ok" && active.length === 0 && (
        <EmptyState
          icon={<Share2 size={20} />}
          title="No active grants"
          body="Grant a request on the Requests tab to share an item with another caller."
        />
      )}
      {active.length > 0 && !isMobile && (
        <div className="data-table-wrap">
          <table className="data-table dl-vault-table">
            <thead>
              <tr>
                <th>Grantee</th>
                <th>Item</th>
                <th>Mode</th>
                <th>Granted</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {active.map((g) => (
                <tr key={g.id}>
                  <td className="mono dl-vault-break">{g.grantee}</td>
                  <td className="mono dl-vault-break">{itemName(g)}</td>
                  <td>
                    <ModeCell g={g} />
                  </td>
                  <td>{formatTime(g.grantedAt)}</td>
                  <td>
                    <div className="dl-vault-actions">{revokeButton(g)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {active.length > 0 && isMobile && (
        <ul className="mobile-card-list dl-vault-cards" aria-label="Active grants">
          {active.map((g) => (
            <li key={g.id} className="mobile-card">
              <div className="mobile-card-header">
                <div className="mobile-card-title mono">{g.grantee}</div>
                <ModeBadge mode={g.effectiveMode ?? g.mode} />
              </div>
              <dl className="mobile-card-kv">
                <div className="mobile-card-kv-row">
                  <dt>Item</dt>
                  <dd className="mono">{itemName(g)}</dd>
                </div>
                <div className="mobile-card-kv-row">
                  <dt>Granted</dt>
                  <dd>{formatTime(g.grantedAt)}</dd>
                </div>
              </dl>
              {g.effectiveMode !== null && g.effectiveMode !== g.mode && (
                <div className="cell-secondary">
                  Granted {g.mode}; the item is inject, so it works inject-only
                </div>
              )}
              <div className="dl-vault-card-actions">{revokeButton(g)}</div>
            </li>
          ))}
        </ul>
      )}

      {revoked.length > 0 && (
        <details className="dl-vault-history">
          <summary>Revoked ({revoked.length})</summary>
          {!isMobile ? (
            <div className="data-table-wrap">
              <table className="data-table dl-vault-table">
                <thead>
                  <tr>
                    <th>Grantee</th>
                    <th>Item</th>
                    <th>Mode</th>
                    <th>Revoked</th>
                  </tr>
                </thead>
                <tbody>
                  {revoked.map((g) => (
                    <tr key={g.id}>
                      <td className="mono dl-vault-break">{g.grantee}</td>
                      <td className="mono dl-vault-break">{itemName(g)}</td>
                      <td>
                        <ModeBadge mode={g.mode} />
                      </td>
                      <td>
                        <div>{g.revokedAt ? formatTime(g.revokedAt) : "—"}</div>
                        {g.revokedReason && (
                          <div className="cell-secondary">{REVOKED_REASON[g.revokedReason]}</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul className="mobile-card-list dl-vault-cards">
              {revoked.map((g) => (
                <li key={g.id} className="mobile-card">
                  <div className="mobile-card-header">
                    <div className="mobile-card-title mono">{g.grantee}</div>
                    <ModeBadge mode={g.mode} />
                  </div>
                  <dl className="mobile-card-kv">
                    <div className="mobile-card-kv-row">
                      <dt>Item</dt>
                      <dd className="mono">{itemName(g)}</dd>
                    </div>
                    <div className="mobile-card-kv-row">
                      <dt>Revoked</dt>
                      <dd>
                        {g.revokedAt ? formatTime(g.revokedAt) : "—"}
                        {g.revokedReason && (
                          <div className="cell-secondary">{REVOKED_REASON[g.revokedReason]}</div>
                        )}
                      </dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.grantee}'s access?`}
          description={
            <>
              <code>{revoking.grantee}</code> will no longer be able to use{" "}
              <code>{itemName(revoking)}</code>. It can ask again with{" "}
              <code>vault_request_access</code>.
            </>
          }
          confirmLabel="Revoke"
          busy={busy}
          error={error}
          onConfirm={() => revoke(revoking)}
          onCancel={() => {
            if (!busy) setRevoking(null);
          }}
        />
      )}
    </>
  );
}
