/**
 * Vault → Items: one caller's items as metadata (never values), with New
 * item, Edit, Replace value, Delete and Reveal.
 */
import { useCallback, useEffect, useState } from "react";
import { Eye, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import type { AdminCaller, AdminVaultItem, AdminVaultItems } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../../api";
import ConfirmDialog from "../../components/ConfirmDialog";
import {
  EditItemModal,
  NewItemModal,
  ReplaceValueModal,
} from "../../components/vault/VaultModals";
import RevealFlow from "../../components/vault/RevealFlow";
import { conflictMessage } from "../../components/vault/conflict";

type Load =
  | { status: "loading" }
  | { status: "ok"; data: AdminVaultItems }
  | { status: "error"; message: string };

type Action =
  | { kind: "new" }
  | { kind: "edit"; item: AdminVaultItem }
  | { kind: "replace"; item: AdminVaultItem }
  | { kind: "delete"; item: AdminVaultItem }
  | { kind: "reveal"; item: AdminVaultItem };

const KIND_LABEL: Record<AdminVaultItem["kind"], string> = {
  token: "token",
  password: "password",
  note: "note",
  "key-value": "key/value",
};

export default function ItemsTab({
  caller,
  onChanged,
}: {
  caller: AdminCaller;
  /** Item counts changed (refresh the caller selector). */
  onChanged: () => void;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [action, setAction] = useState<Action | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await api.vaultItems(caller.alias);
    if (isDaemonDown(res)) {
      setLoad({ status: "error", message: res.error });
      return;
    }
    setLoad({ status: "ok", data: res });
    // An open dialog follows the reloaded item (renamed or edited meanwhile).
    setAction((a) => {
      if (a === null || a.kind === "new") return a;
      const fresh = res.items.find((i) => i.id === a.item.id);
      return fresh ? { ...a, item: fresh } : a;
    });
  }, [caller.alias]);

  /** A write got 409 (the vault changed since the list loaded): reload the
   *  list and its revision so the next attempt can succeed. */
  const conflict = useCallback(() => {
    void refresh();
    onChanged();
  }, [refresh, onChanged]);

  useEffect(() => {
    setLoad({ status: "loading" });
    setAction(null);
    void refresh();
  }, [refresh]);

  const saved = () => {
    void refresh();
    onChanged();
  };
  const closeAction = useCallback(() => setAction(null), []);

  const revision = load.status === "ok" ? load.data.revision : undefined;

  const handleDelete = async (item: AdminVaultItem) => {
    setDeleting(true);
    setDeleteError(null);
    const res = await api.vaultDelete(caller.alias, item.name, revision);
    setDeleting(false);
    if (!res.ok) {
      setDeleteError(conflictMessage(res));
      if (res.status === 409) conflict();
      return;
    }
    setAction(null);
    saved();
  };

  return (
    <>
      <div className="dl-vault-toolbar">
        <p className="detail-note">
          Values are write-only here. <strong>Inject</strong> items can be used
          by <code>{caller.alias}</code>&apos;s agent as{" "}
          <code>{"${vault:name}"}</code> but never read; bind them to the
          connection that needs them.
        </p>
        <button
          type="button"
          className="dl-cred-btn dl-cred-btn-primary"
          onClick={() => setAction({ kind: "new" })}
        >
          <Plus size={14} />
          New item
        </button>
      </div>

      {load.status === "loading" && <div className="banner banner-loading">Loading…</div>}
      {load.status === "error" && (
        <div className="banner banner-offline">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load the vault: {load.message}</span>
        </div>
      )}
      {load.status === "ok" && load.data.items.length === 0 && (
        <div className="placeholder">
          <span className="placeholder-title">No items</span>
          <span>
            <code>{caller.alias}</code>&apos;s vault is empty.
          </span>
        </div>
      )}
      {load.status === "ok" && load.data.items.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Exposure</th>
                <th>Tags</th>
                <th>Connections</th>
                <th>Shared with</th>
                <th>Updated</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {load.data.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <div className="cell-primary mono">{item.name}</div>
                    <div className="cell-secondary">
                      {item.fields.join(", ")} · by {item.createdBy}
                    </div>
                  </td>
                  <td>{KIND_LABEL[item.kind]}</td>
                  <td>
                    <span className={`dl-vault-exposure dl-vault-exposure-${item.exposure}`}>
                      {item.exposure}
                    </span>
                  </td>
                  <td>
                    {item.tags.length === 0 ? (
                      <span className="cell-muted">—</span>
                    ) : (
                      <div className="badge-row">
                        {item.tags.map((t) => (
                          <span key={t} className="tag">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    {item.connections === undefined ? (
                      <span className="cell-muted">any</span>
                    ) : item.connections.length === 0 ? (
                      <span className="cell-muted">none</span>
                    ) : (
                      <span className="mono">{item.connections.join(", ")}</span>
                    )}
                  </td>
                  <td>
                    {item.grants.length === 0 ? (
                      <span className="cell-muted">—</span>
                    ) : (
                      item.grants.map((g) => `${g.grantee} (${g.mode})`).join(", ")
                    )}
                  </td>
                  <td title={`value changed ${new Date(item.valueUpdatedAt).toLocaleString()}`}>
                    {new Date(item.updatedAt).toLocaleString()}
                  </td>
                  <td>
                    <div className="dl-vault-actions">
                      <IconButton label="Edit" onClick={() => setAction({ kind: "edit", item })}>
                        <Pencil size={14} />
                      </IconButton>
                      <IconButton
                        label="Replace value"
                        onClick={() => setAction({ kind: "replace", item })}
                      >
                        <KeyRound size={14} />
                      </IconButton>
                      <IconButton
                        label="Reveal"
                        onClick={() => setAction({ kind: "reveal", item })}
                      >
                        <Eye size={14} />
                      </IconButton>
                      <IconButton
                        label="Delete"
                        danger
                        onClick={() => {
                          setDeleteError(null);
                          setAction({ kind: "delete", item });
                        }}
                      >
                        <Trash2 size={14} />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {action?.kind === "new" && (
        <NewItemModal
          caller={caller.alias}
          callerConnections={caller.connections}
          onClose={closeAction}
          onSaved={saved}
        />
      )}
      {action?.kind === "edit" && revision !== undefined && (
        <EditItemModal
          caller={caller.alias}
          item={action.item}
          revision={revision}
          callerConnections={caller.connections}
          onClose={closeAction}
          onSaved={saved}
          onConflict={conflict}
        />
      )}
      {action?.kind === "replace" && revision !== undefined && (
        <ReplaceValueModal
          caller={caller.alias}
          item={action.item}
          revision={revision}
          onClose={closeAction}
          onSaved={saved}
          onConflict={conflict}
        />
      )}
      {action?.kind === "reveal" && (
        <RevealFlow caller={caller.alias} item={action.item} onClose={closeAction} />
      )}
      {action?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete "${action.item.name}"?`}
          description={
            <>
              This deletes the item from <code>{caller.alias}</code>&apos;s vault.
              Requests that use <code>{"${vault:" + action.item.name + "}"}</code>{" "}
              will fail. This cannot be undone.
            </>
          }
          busy={deleting}
          error={deleteError}
          onConfirm={() => handleDelete(action.item)}
          onCancel={() => {
            if (!deleting) setAction(null);
          }}
        />
      )}
    </>
  );
}

function IconButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`dl-vault-icon-btn${danger ? " is-danger" : ""}`}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
