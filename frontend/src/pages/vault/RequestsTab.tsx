/**
 * Vault → Requests: the pending access-request queue (Grant, Deny) and a
 * collapsible history. The reason is agent-written text: it is labelled as
 * such and rendered as plain text (React escapes it).
 */
import { useCallback, useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import type { AdminVaultRequest } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../../api";
import { DenyRequestModal, GrantRequestModal } from "../../components/vault/RequestModals";

type Load =
  | { status: "loading" }
  | { status: "ok"; data: AdminVaultRequest[] }
  | { status: "error"; message: string };

type Action =
  | { kind: "grant"; request: AdminVaultRequest }
  | { kind: "deny"; request: AdminVaultRequest };

function ItemCell({ r }: { r: AdminVaultRequest }) {
  return (
    <>
      <div className="cell-primary mono">
        {r.owner}/{r.item?.name ?? r.itemName}
      </div>
      <div className="cell-secondary">
        {r.item === null ? (
          <span className="dl-vault-missing">no such item</span>
        ) : (
          <>
            {r.item.kind} · {r.item.exposure}
            {r.item.name !== r.itemName && <> · asked as {r.itemName}</>}
          </>
        )}
      </div>
    </>
  );
}

function ReasonCell({ r }: { r: AdminVaultRequest }) {
  return (
    <div className="dl-vault-reason">
      <div className="dl-vault-reason-label">
        Written by the requesting agent{" "}
        <span className="mono dl-vault-reason-who">{r.requester}</span>, not by the owner
      </div>
      <div className="dl-vault-reason-text">{r.reason}</div>
    </div>
  );
}

export default function RequestsTab({ onChanged }: { onChanged: () => void }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [action, setAction] = useState<Action | null>(null);

  const refresh = useCallback(async () => {
    const res = await api.vaultRequests();
    if (isDaemonDown(res)) {
      setLoad({ status: "error", message: res.error });
      return;
    }
    setLoad({ status: "ok", data: res });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const done = () => {
    void refresh();
    onChanged();
  };
  const close = useCallback(() => setAction(null), []);

  const pending = load.status === "ok" ? load.data.filter((r) => r.status === "pending") : [];
  const history = load.status === "ok" ? load.data.filter((r) => r.status !== "pending") : [];

  return (
    <>
      <p className="detail-note">
        Agents ask for another caller&apos;s item with <code>vault_request_access</code>. Only
        you can grant or deny here; no agent tool can. Grant <strong>inject</strong> unless the
        agent really needs to read the value.
      </p>

      {load.status === "loading" && <div className="banner banner-loading">Loading…</div>}
      {load.status === "error" && (
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load requests: {load.message}</span>
        </div>
      )}

      {load.status === "ok" && pending.length === 0 && (
        <div className="placeholder">
          <span className="placeholder-title">No pending requests</span>
        </div>
      )}
      {pending.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Requester</th>
                <th>Item</th>
                <th>Mode asked</th>
                <th>Reason</th>
                <th>Asked</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {pending.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.requester}</td>
                  <td>
                    <ItemCell r={r} />
                  </td>
                  <td>
                    <span className={`dl-vault-exposure dl-vault-exposure-${r.mode}`}>
                      {r.mode}
                    </span>
                  </td>
                  <td>
                    <ReasonCell r={r} />
                  </td>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>
                    <div className="dl-vault-actions">
                      {r.item === null ? (
                        <span
                          className="cell-muted dl-vault-deny-only"
                          title="The owner has no such item: this request can only be denied"
                        >
                          deny only
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="dl-cred-btn dl-cred-btn-primary"
                          onClick={() => setAction({ kind: "grant", request: r })}
                        >
                          <Check size={14} />
                          Grant
                        </button>
                      )}
                      <button
                        type="button"
                        className="dl-cred-btn"
                        onClick={() => setAction({ kind: "deny", request: r })}
                      >
                        <X size={14} />
                        Deny
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {history.length > 0 && (
        <details className="dl-vault-history">
          <summary>History ({history.length})</summary>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Requester</th>
                  <th>Item</th>
                  <th>Mode asked</th>
                  <th>Status</th>
                  <th>Reason</th>
                  <th>Decided</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td className="mono">{r.requester}</td>
                    <td>
                      <ItemCell r={r} />
                    </td>
                    <td>{r.mode}</td>
                    <td>
                      <div>{r.status}</div>
                      {r.decidedNote && (
                        <div className="cell-secondary">note: {r.decidedNote}</div>
                      )}
                    </td>
                    <td>
                      <ReasonCell r={r} />
                    </td>
                    <td>{r.decidedAt ? new Date(r.decidedAt).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {action?.kind === "grant" && (
        <GrantRequestModal request={action.request} onClose={close} onDone={done} />
      )}
      {action?.kind === "deny" && (
        <DenyRequestModal request={action.request} onClose={close} onDone={done} />
      )}
    </>
  );
}
