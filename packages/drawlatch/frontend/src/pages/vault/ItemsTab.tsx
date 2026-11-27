/**
 * Vault → Items: one caller's items as metadata (never values), with New
 * item, Edit, Replace value, Delete and Reveal. A table on wide screens,
 * cards on phones.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, KeyRound, LockKeyhole, Pencil, Plus, Trash2 } from "lucide-react";
import type { AdminCaller, AdminVaultItem, AdminVaultItems } from "drawlatch-admin-types";
import { api, isDaemonDown } from "../../api";
import { useDaemon } from "../../contexts/DaemonContext";
import ConfirmDialog from "../../components/ConfirmDialog";
import EmptyState, { LoadingState } from "../../components/EmptyState";
import { useToast } from "../../components/Toast";
import {
  EditItemModal,
  NewItemModal,
  ReplaceValueModal,
} from "../../components/vault/VaultModals";
import RevealFlow from "../../components/vault/RevealFlow";
import { conflictMessage } from "../../components/vault/conflict";
import { KIND_LABEL, ModeBadge } from "../../components/vault/labels";
import { useIsMobile } from "../../hooks/useIsMobile";

type ListedItem = AdminVaultItems["items"][number];

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

type ItemAction = Exclude<Action["kind"], "new">;

const ROW_ACTIONS: { kind: Exclude<ItemAction, "delete">; label: string; icon: React.ReactNode }[] = [
  { kind: "edit", label: "Edit", icon: <Pencil size={14} aria-hidden="true" /> },
  { kind: "replace", label: "Replace value", icon: <KeyRound size={14} aria-hidden="true" /> },
  { kind: "reveal", label: "Reveal", icon: <Eye size={14} aria-hidden="true" /> },
];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function Tags({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span className="cell-muted">—</span>;
  return (
    <div className="badge-row">
      {tags.map((t) => (
        <span key={t} className="tag dl-vault-tag" title={t}>
          {t}
        </span>
      ))}
    </div>
  );
}

function Connections({ item }: { item: AdminVaultItem }) {
  if (item.connections === undefined) return <span className="cell-muted">any</span>;
  if (item.connections.length === 0) return <span className="cell-muted">none</span>;
  return <span className="mono">{item.connections.join(", ")}</span>;
}

function SharedWith({ item }: { item: ListedItem }) {
  if (item.grants.length === 0) return <span className="cell-muted">—</span>;
  return (
    <>
      {item.grants
        .map((g) =>
          g.effectiveMode === g.mode
            ? `${g.grantee} (${g.mode})`
            : `${g.grantee} (${g.effectiveMode}; granted ${g.mode})`,
        )
        .join(", ")}
    </>
  );
}

export default function ItemsTab({
  caller,
  onChanged,
}: {
  caller: AdminCaller;
  /** Item counts changed (refresh the caller selector). */
  onChanged: () => void;
}) {
  const isMobile = useIsMobile();
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [action, setAction] = useState<Action | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Focus after the delete dialog: the row's trash button on Cancel; "New
  // item" once the row is gone.
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const newItemRef = useRef<HTMLButtonElement>(null);

  // Only the latest refresh may write (they overlap after a save).
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    const res = await api.vaultItems(caller.alias);
    if (mine !== seq.current) return;
    if (isDaemonDown(res)) {
      // A failed refresh keeps the list (and any open dialog) on screen.
      setLoad((prev) => (prev.status === "ok" ? prev : { status: "error", message: res.error }));
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
  const open = (kind: ItemAction, item: AdminVaultItem) => {
    if (kind === "delete") setDeleteError(null);
    setAction({ kind, item });
  };

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
    if (newItemRef.current) returnFocusRef.current = newItemRef.current;
    setAction(null);
    toast.show(`Deleted ${item.name}`);
    saved();
  };

  const newButton = (
    <button
      ref={newItemRef}
      type="button"
      className="btn btn-primary"
      onClick={() => setAction({ kind: "new" })}
    >
      <Plus size={14} aria-hidden="true" />
      New item
    </button>
  );
  const items = load.status === "ok" ? load.data.items : [];

  return (
    <>
      <div className="dl-vault-toolbar">
        <p className="detail-note">
          Values are write-only here. <strong>Inject</strong> items can be used by{" "}
          <code>{caller.alias}</code>&apos;s agent as <code>{"${vault:name}"}</code> but never
          read; bind them to the connection that needs them.
        </p>
        {items.length > 0 && newButton}
      </div>

      {load.status === "loading" && <LoadingState label="Loading items…" />}
      {load.status === "error" && (
        <div className="banner banner-offline" role="alert">
          <span className="status-dot down" aria-hidden="true" />
          <span>Failed to load the vault: {load.message}</span>
        </div>
      )}
      {load.status === "ok" && items.length === 0 && (
        <EmptyState
          icon={<LockKeyhole size={20} />}
          title="No items yet"
          body={
            <>
              <code>{caller.alias}</code>&apos;s vault is empty. Items its agent saves with{" "}
              <code>vault_create</code> show up here, or add one yourself.
            </>
          }
          action={newButton}
        />
      )}

      {items.length > 0 && !isMobile && (
        <div className="data-table-wrap">
          <table className="data-table dl-vault-table has-actions">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Exposure</th>
                <th>Tags</th>
                <th>Connections</th>
                <th>Shared with</th>
                <th className="dl-vault-col-optional">Updated</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="dl-vault-name-cell">
                    <div className="cell-primary mono">{item.name}</div>
                    <div className="cell-secondary">
                      {item.fields.join(", ")} · by {item.createdBy}
                    </div>
                  </td>
                  <td className="dl-vault-nowrap">{KIND_LABEL[item.kind]}</td>
                  <td>
                    <ModeBadge mode={item.exposure} />
                  </td>
                  <td>
                    <Tags tags={item.tags} />
                  </td>
                  <td>
                    <Connections item={item} />
                  </td>
                  <td>
                    <SharedWith item={item} />
                  </td>
                  <td
                    className="dl-vault-col-optional"
                    title={`Value changed ${formatTime(item.valueUpdatedAt)}`}
                  >
                    {formatTime(item.updatedAt)}
                  </td>
                  <td>
                    <div className="dl-vault-actions">
                      {ROW_ACTIONS.map((a) => (
                        <button
                          key={a.kind}
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm"
                          onClick={() => open(a.kind, item)}
                          aria-label={`${a.label} ${item.name}`}
                          title={a.label}
                        >
                          {a.icon}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="btn btn-ghost btn-icon btn-sm dl-vault-icon-danger"
                        onClick={(e) => {
                    returnFocusRef.current = e.currentTarget;
                    open("delete", item);
                  }}
                        aria-label={`Delete ${item.name}`}
                        title="Delete"
                      >
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {items.length > 0 && isMobile && (
        <ul className="mobile-card-list dl-vault-cards" aria-label="Vault items">
          {items.map((item) => (
            <li key={item.id} className="mobile-card">
              <div className="mobile-card-header">
                <div className="mobile-card-title">
                  <div className="mono">{item.name}</div>
                  <div className="cell-secondary">
                    {item.fields.join(", ")} · by {item.createdBy}
                  </div>
                </div>
                <ModeBadge mode={item.exposure} />
              </div>
              <dl className="mobile-card-kv">
                <div className="mobile-card-kv-row">
                  <dt>Kind</dt>
                  <dd>{KIND_LABEL[item.kind]}</dd>
                </div>
                <div className="mobile-card-kv-row">
                  <dt>Connections</dt>
                  <dd>
                    <Connections item={item} />
                  </dd>
                </div>
                {item.tags.length > 0 && (
                  <div className="mobile-card-kv-row">
                    <dt>Tags</dt>
                    <dd className="dl-vault-kv-tags">
                      <Tags tags={item.tags} />
                    </dd>
                  </div>
                )}
                {item.grants.length > 0 && (
                  <div className="mobile-card-kv-row">
                    <dt>Shared with</dt>
                    <dd>
                      <SharedWith item={item} />
                    </dd>
                  </div>
                )}
                <div className="mobile-card-kv-row">
                  <dt>Updated</dt>
                  <dd>{formatTime(item.updatedAt)}</dd>
                </div>
              </dl>
              <div className="dl-vault-card-actions">
                {ROW_ACTIONS.map((a) => (
                  <button
                    key={a.kind}
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => open(a.kind, item)}
                    aria-label={`${a.label} ${item.name}`}
                  >
                    {a.icon}
                    {a.kind === "replace" ? "Replace" : a.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn btn-danger-outline btn-sm btn-icon"
                  onClick={(e) => {
                    returnFocusRef.current = e.currentTarget;
                    open("delete", item);
                  }}
                  aria-label={`Delete ${item.name}`}
                  title="Delete"
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
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
              This deletes the item from <code>{caller.alias}</code>&apos;s vault. Requests that
              use <code>{"${vault:" + action.item.name + "}"}</code> will fail. This cannot be
              undone.
            </>
          }
          busy={deleting}
          error={deleteError}
          returnFocusRef={returnFocusRef}
          onConfirm={() => handleDelete(action.item)}
          onCancel={() => {
            if (!deleting) setAction(null);
          }}
        />
      )}
    </>
  );
}
