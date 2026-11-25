/**
 * Vault → Grants: active grants with Revoke; revoked ones collapsed below.
 */
import { useCallback, useEffect, useState } from "react";
import { Ban } from "lucide-react";
import type { AdminVaultGrant } from "drawlatch-admin-types";
import { api, isDaemonDown, notifyVaultRequestsChanged } from "../../api";
import ConfirmDialog from "../../components/ConfirmDialog";

type Load =
  | { status: "loading" }
  | { status: "ok"; data: AdminVaultGrant[] }
  | { status: "error"; message: string };

const REVOKED_REASON: Record<NonNullable<AdminVaultGrant["revokedReason"]>, string> = {
  admin: "revoked by the operator",
  item_deleted: "item deleted",
  caller_deleted: "caller deleted",
};

function ModeCell({ g }: { g: AdminVaultGrant }) {
  const effective = g.effectiveMode ?? g.mode;
  return (
    <>
      <span className={`dl-vault-exposure dl-vault-exposure-${effective}`}>{effective}</span>
      {g.effectiveMode !== null && g.effectiveMode !== g.mode && (
        <div className="cell-secondary">
          granted {g.mode}; the item is inject, so it works inject-only
        </div>
      )}
    </>
  );
}

export default function GrantsTab({ onChanged }: { onChanged: () => void }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [revoking, setRevoking] = useState<AdminVaultGrant | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await api.vaultGrants();
    if (isDaemonDown(res)) {
      setLoad({ status: "error", message: res.error });
      return;
    }
    setLoad({ status: "ok", data: res });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    notifyVaultRequestsChanged();
    void refresh();
    onChanged();
  };

  const active = load.status === "ok" ? load.data.filter((g) => g.status === "active") : [];
  const revoked = load.status === "ok" ? load.data.filter((g) => g.status === "revoked") : [];
  const itemName = (g: AdminVaultGrant) => `${g.owner}/${g.item?.name ?? "(deleted item)"}`;

  return (
    <>
      <p className="detail-note">
        A grant lets the grantee use another caller&apos;s item as{" "}
        <code>{"${vault:owner/name}"}</code>, within the item&apos;s connections binding, and
        at reveal also read it. Revoking takes effect on the next request.
      </p>

      {load.status === "loading" && <div className="banner banner-loading">Loading…</div>}
      {load.status === "error" && (
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load grants: {load.message}</span>
        </div>
      )}

      {load.status === "ok" && active.length === 0 && (
        <div className="placeholder">
          <span className="placeholder-title">No active grants</span>
        </div>
      )}
      {active.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Grantee</th>
                <th>Item</th>
                <th>Mode</th>
                <th>Granted</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {active.map((g) => (
                <tr key={g.id}>
                  <td className="mono">{g.grantee}</td>
                  <td className="mono">{itemName(g)}</td>
                  <td>
                    <ModeCell g={g} />
                  </td>
                  <td>{new Date(g.grantedAt).toLocaleString()}</td>
                  <td>
                    <div className="dl-vault-actions">
                      <button
                        type="button"
                        className="dl-cred-btn"
                        onClick={() => {
                          setError(null);
                          setRevoking(g);
                        }}
                      >
                        <Ban size={14} />
                        Revoke
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revoked.length > 0 && (
        <details className="dl-vault-history">
          <summary>Revoked ({revoked.length})</summary>
          <div className="data-table-wrap">
            <table className="data-table">
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
                    <td className="mono">{g.grantee}</td>
                    <td className="mono">{itemName(g)}</td>
                    <td>{g.mode}</td>
                    <td>
                      <div>{g.revokedAt ? new Date(g.revokedAt).toLocaleString() : "—"}</div>
                      {g.revokedReason && (
                        <div className="cell-secondary">{REVOKED_REASON[g.revokedReason]}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
          onCancel={() => setRevoking(null)}
        />
      )}
    </>
  );
}
