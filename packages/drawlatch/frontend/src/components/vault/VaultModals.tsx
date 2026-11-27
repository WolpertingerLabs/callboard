/**
 * Vault item modals: New item, Edit (metadata, exposure, binding), and
 * Replace value. Values are write-only: nothing here ever shows a stored
 * value, and typed values live only in the modal's own state.
 */
import { useId, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type {
  AdminVaultExposure,
  AdminVaultItem,
  AdminVaultKind,
} from "drawlatch-admin-types";
import { api, type VaultItemPatch } from "../../api";
import { useDaemon } from "../../contexts/DaemonContext";
import Modal from "../Modal";
import ConfirmDialog from "../ConfirmDialog";
import { useToast } from "../Toast";
import { conflictMessage } from "./conflict";
import { KIND_LABEL } from "./labels";
import ValuesEditor, {
  convertRows,
  newRow,
  rowsDirty,
  rowsForKind,
  rowsToValues,
  type ValueRow,
} from "./ValuesEditor";
import "./VaultForms.css";

const KINDS: AdminVaultKind[] = ["token", "password", "note", "key-value"];

// ── Shell ──────────────────────────────────────────────────────────────────

/**
 * A vault form dialog on the shared Modal. While `dirty`, a backdrop click
 * does nothing and Escape, × or Cancel ask "Discard changes?" first.
 */
export function ModalShell({
  title,
  subtitle,
  busy,
  error,
  saveLabel,
  canSave,
  dirty = false,
  size = "md",
  onSave,
  onClose,
  children,
}: {
  title: string;
  subtitle: React.ReactNode;
  busy: boolean;
  error: string | null;
  saveLabel: string;
  canSave: boolean;
  /** Something typed would be lost by closing. */
  dirty?: boolean;
  /** "sm" for a short form (a bottom sheet on phones). */
  size?: "sm" | "md";
  onSave: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const formId = useId();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const offline = useDaemon().daemon === "down";
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  return (
    <Modal
      open
      title={title}
      subtitle={subtitle}
      onClose={requestClose}
      dismissible={!dirty}
      size={size}
      busy={busy}
      footer={
        <>
          {offline ? (
            <div className="modal-error dl-vf-footer-error" role="status">
              The Drawlatch daemon isn&apos;t reachable. What you typed is kept; save once it&apos;s
              back.
            </div>
          ) : (
            error && (
              <div className="modal-error dl-vf-footer-error" role="alert">
                {error}
              </div>
            )
          )}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={requestClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            form={formId}
            className="btn btn-primary"
            disabled={!canSave || busy || offline}
          >
            {busy && <Loader2 size={14} className="spinner" aria-hidden="true" />}
            {saveLabel}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="dl-vf-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave && !busy && !offline) onSave();
        }}
      >
        {children}
      </form>
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard changes?"
          description="What you typed in this dialog will be lost."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          onConfirm={() => {
            setConfirmDiscard(false);
            onClose();
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </Modal>
  );
}

function Section({
  title,
  help,
  children,
}: {
  title: string;
  help?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="dl-vf-section">
      <h3 className="dl-vf-section-title">{title}</h3>
      {help && <p className="dl-vf-help">{help}</p>}
      {children}
    </section>
  );
}

/** The caller alias as a small pill, for dialog subtitles. */
export function CallerPill({ alias }: { alias: string }) {
  return <span className="dl-vf-pill">{alias}</span>;
}

// ── Shared metadata fields ─────────────────────────────────────────────────

interface MetaState {
  exposure: AdminVaultExposure;
  /** null = not bound (any of the caller's connections). */
  connections: string[] | null;
  tags: string;
  notes: string;
  metadata: string;
}

function metaFromItem(item: AdminVaultItem): MetaState {
  return {
    exposure: item.exposure,
    connections: item.connections ?? null,
    tags: item.tags.join(", "),
    notes: item.notes ?? "",
    metadata: Object.entries(item.metadata)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  };
}

function parseTags(text: string): string[] {
  return [...new Set(text.split(",").map((t) => t.trim()).filter(Boolean))];
}

/** `key=value` lines → object; returns an error string for a bad line. */
function parseMetadata(text: string): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return `Metadata line ${i + 1} must be key=value`;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function MetaFields({
  meta,
  setMeta,
  callerConnections,
  idPrefix,
}: {
  meta: MetaState;
  setMeta: (m: MetaState) => void;
  callerConnections: string[];
  idPrefix: string;
}) {
  const options = useMemo(
    () => [...new Set([...callerConnections, ...(meta.connections ?? [])])].sort(),
    [callerConnections, meta.connections],
  );
  const bound = meta.connections !== null;
  const toggle = (c: string) => {
    const cur = meta.connections ?? [];
    setMeta({
      ...meta,
      connections: cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c],
    });
  };

  return (
    <>
      <Section title="Exposure">
        <div className="dl-vf-radios" role="radiogroup" aria-label="Exposure">
          <label className="dl-vf-radio">
            <input
              type="radio"
              name={`${idPrefix}-exposure`}
              checked={meta.exposure === "inject"}
              onChange={() => setMeta({ ...meta, exposure: "inject" })}
            />
            <span>
              <strong>Inject</strong>: the agent can use it as{" "}
              <code>{"${vault:name}"}</code> in requests but never read it.
            </span>
          </label>
          <label className="dl-vf-radio">
            <input
              type="radio"
              name={`${idPrefix}-exposure`}
              checked={meta.exposure === "reveal"}
              onChange={() => setMeta({ ...meta, exposure: "reveal" })}
            />
            <span>
              <strong>Reveal</strong>: the agent can also read it with{" "}
              <code>vault_get</code> (audit-logged).
            </span>
          </label>
        </div>
      </Section>

      <Section title="Connections">
        <div className="dl-vf-radios" role="radiogroup" aria-label="Connections">
          <label className="dl-vf-radio">
            <input
              type="radio"
              name={`${idPrefix}-binding`}
              checked={bound}
              onChange={() =>
                setMeta({
                  ...meta,
                  connections: callerConnections.length > 0 ? [callerConnections[0]] : [],
                })
              }
            />
            <span>Only on these connections (recommended)</span>
          </label>
          {bound && (
            <div className="dl-vf-checks">
              {options.length === 0 && (
                <span className="cell-muted">This caller has no connections enabled.</span>
              )}
              {options.map((c) => (
                <label key={c} className="dl-vf-check">
                  <input
                    type="checkbox"
                    checked={meta.connections?.includes(c) ?? false}
                    onChange={() => toggle(c)}
                  />
                  {c}
                  {!callerConnections.includes(c) && (
                    <span className="cell-muted"> (not enabled)</span>
                  )}
                </label>
              ))}
            </div>
          )}
          <label className="dl-vf-radio">
            <input
              type="radio"
              name={`${idPrefix}-binding`}
              checked={!bound}
              onChange={() => setMeta({ ...meta, connections: null })}
            />
            <span>Any of the caller&apos;s connections</span>
          </label>
        </div>
      </Section>

      <Section
        title="Details"
        help={
          <>
            Not secret: the agent can read these with <code>vault_list</code>.
          </>
        }
      >
        <div className="dl-vf-fields">
          <div className="dl-vf-field">
            <label className="field-label" htmlFor={`${idPrefix}-tags`}>
              Tags (comma-separated)
            </label>
            <input
              id={`${idPrefix}-tags`}
              className="input"
              value={meta.tags}
              onChange={(e) => setMeta({ ...meta, tags: e.target.value })}
            />
          </div>
          <div className="dl-vf-field">
            <label className="field-label" htmlFor={`${idPrefix}-notes`}>
              Notes
            </label>
            <textarea
              id={`${idPrefix}-notes`}
              className="input dl-vf-textarea"
              rows={2}
              value={meta.notes}
              onChange={(e) => setMeta({ ...meta, notes: e.target.value })}
            />
          </div>
          <div className="dl-vf-field">
            <label className="field-label" htmlFor={`${idPrefix}-meta`}>
              Metadata (one key=value per line)
            </label>
            <textarea
              id={`${idPrefix}-meta`}
              className="input dl-vf-textarea mono"
              rows={2}
              value={meta.metadata}
              onChange={(e) => setMeta({ ...meta, metadata: e.target.value })}
            />
          </div>
        </div>
      </Section>
    </>
  );
}

function sameMeta(a: MetaState, b: MetaState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── New item ───────────────────────────────────────────────────────────────

export function NewItemModal({
  caller,
  callerConnections,
  onClose,
  onSaved,
}: {
  caller: string;
  callerConnections: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AdminVaultKind>("token");
  const [rows, setRows] = useState<ValueRow[]>(() => rowsForKind("token"));
  // Defaults: inject, bound to one of the caller's enabled connections.
  const initialMeta = useMemo<MetaState>(
    () => ({
      exposure: "inject",
      connections: callerConnections.length > 0 ? [callerConnections[0]] : null,
      tags: "",
      notes: "",
      metadata: "",
    }),
    [callerConnections],
  );
  const [meta, setMeta] = useState<MetaState>(initialMeta);
  // A kind change that would drop typed values waits for a confirmation.
  const [pendingKind, setPendingKind] = useState<{
    kind: AdminVaultKind;
    rows: ValueRow[];
    dropped: string[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const values = rowsToValues(kind, rows);
  const canSave = name.trim() !== "" && Object.values(values).some((v) => v !== "");
  const dirty = name !== "" || rowsDirty(rows) || !sameMeta(meta, initialMeta);

  const changeKind = (k: AdminVaultKind) => {
    const next = convertRows(rows, k);
    if (next.dropped.length > 0) {
      setPendingKind({ kind: k, ...next });
      return;
    }
    setKind(k);
    setRows(next.rows);
  };

  const save = async () => {
    const metadata = parseMetadata(meta.metadata);
    if (typeof metadata === "string") {
      setError(metadata);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await api.vaultCreate(caller, {
      name: name.trim(),
      kind,
      values,
      exposure: meta.exposure,
      tags: parseTags(meta.tags),
      metadata,
      ...(meta.notes.trim() !== "" && { notes: meta.notes }),
      ...(meta.connections !== null && { connections: meta.connections }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    toast.show(`Created ${name.trim()}`);
    onSaved();
    onClose();
  };

  return (
    <ModalShell
      title="New vault item"
      subtitle={
        <>
          For <CallerPill alias={caller} />, created by you
        </>
      }
      busy={busy}
      error={error}
      saveLabel="Create"
      canSave={canSave}
      dirty={dirty}
      onSave={() => void save()}
      onClose={onClose}
    >
      <Section title="Item">
        <div className="dl-vf-fields">
          <div className="dl-vf-field">
            <label className="field-label" htmlFor="dl-vault-new-name">
              Name
            </label>
            <input
              id="dl-vault-new-name"
              className="input mono"
              placeholder="forgejo-token"
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="dl-vf-field">
            <label className="field-label" htmlFor="dl-vault-new-kind">
              Kind
            </label>
            <select
              id="dl-vault-new-kind"
              className="input"
              value={kind}
              onChange={(e) => changeKind(e.target.value as AdminVaultKind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Section>
      <Section title="Secret values" help="Write-only: nobody can read them back here without a Reveal.">
        <ValuesEditor kind={kind} rows={rows} onChange={setRows} idPrefix="dl-vault-new-v" />
      </Section>
      <MetaFields
        meta={meta}
        setMeta={setMeta}
        callerConnections={callerConnections}
        idPrefix="dl-vault-new"
      />
      {pendingKind && (
        <ConfirmDialog
          variant="neutral"
          title={`Change the kind to ${KIND_LABEL[pendingKind.kind]}?`}
          description={
            <>
              A {KIND_LABEL[pendingKind.kind].toLowerCase()} has no{" "}
              {pendingKind.dropped.map((f, i) => (
                <span key={f}>
                  {i > 0 && ", "}
                  <code>{f}</code>
                </span>
              ))}{" "}
              field, so what you typed there will be cleared.
            </>
          }
          confirmLabel="Change kind"
          onConfirm={() => {
            setKind(pendingKind.kind);
            setRows(pendingKind.rows);
            setPendingKind(null);
          }}
          onCancel={() => setPendingKind(null)}
        />
      )}
    </ModalShell>
  );
}

// ── Edit (metadata, exposure, binding, name) ───────────────────────────────

export function EditItemModal({
  caller,
  item,
  revision,
  callerConnections,
  onClose,
  onSaved,
  onConflict,
}: {
  caller: string;
  item: AdminVaultItem;
  revision: number;
  callerConnections: string[];
  onClose: () => void;
  onSaved: () => void;
  /** The save got 409: the parent reloads the list and revision. */
  onConflict: () => void;
}) {
  const toast = useToast();
  const initial = useMemo(() => metaFromItem(item), [item]);
  const [name, setName] = useState(item.name);
  const [meta, setMeta] = useState<MetaState>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = name !== item.name || !sameMeta(meta, initial);

  const save = async () => {
    const metadata = parseMetadata(meta.metadata);
    if (typeof metadata === "string") {
      setError(metadata);
      return;
    }
    // Send only what changed, so the audit line names the right properties.
    const patch: VaultItemPatch = {};
    if (name.trim() !== item.name) patch.rename = name.trim();
    if (meta.exposure !== item.exposure) patch.exposure = meta.exposure;
    const sameList = (a: string[] | null, b: string[] | undefined) =>
      (a === null && b === undefined) ||
      (a !== null && b !== undefined && [...a].sort().join() === [...b].sort().join());
    if (!sameList(meta.connections, item.connections)) patch.connections = meta.connections;
    const tags = parseTags(meta.tags);
    if (tags.join() !== item.tags.join()) patch.tags = tags;
    if (meta.notes !== (item.notes ?? "")) patch.notes = meta.notes === "" ? null : meta.notes;
    if (JSON.stringify(metadata) !== JSON.stringify(item.metadata)) patch.metadata = metadata;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    const res = await api.vaultUpdate(caller, item.name, patch, revision);
    setBusy(false);
    if (!res.ok) {
      setError(conflictMessage(res));
      if (res.status === 409) onConflict();
      return;
    }
    toast.show(`Saved ${patch.rename ?? item.name}`);
    onSaved();
    onClose();
  };

  return (
    <ModalShell
      title={`Edit ${item.name}`}
      subtitle={
        <>
          <CallerPill alias={caller} /> · {KIND_LABEL[item.kind]} · fields:{" "}
          <span className="mono">{item.fields.join(", ")}</span>
        </>
      }
      busy={busy}
      error={error}
      saveLabel="Save"
      canSave={name.trim() !== ""}
      dirty={dirty}
      onSave={() => void save()}
      onClose={onClose}
    >
      <Section title="Name">
        <input
          className="input mono"
          aria-label="Name"
          autoComplete="off"
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {name.trim() !== item.name && (
          <p className="dl-vf-help dl-vf-warn">
            Renaming keeps the item&apos;s id, but <code>{"${vault:" + item.name + "}"}</code>{" "}
            placeholders stop resolving.
          </p>
        )}
      </Section>
      <MetaFields
        meta={meta}
        setMeta={setMeta}
        callerConnections={callerConnections}
        idPrefix="dl-vault-edit"
      />
    </ModalShell>
  );
}

// ── Replace value ──────────────────────────────────────────────────────────

export function ReplaceValueModal({
  caller,
  item,
  revision,
  onClose,
  onSaved,
  onConflict,
}: {
  caller: string;
  item: AdminVaultItem;
  revision: number;
  onClose: () => void;
  onSaved: () => void;
  onConflict: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState<ValueRow[]>(() =>
    item.kind === "key-value" ? item.fields.map((f) => newRow(f)) : rowsForKind(item.kind),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const values = rowsToValues(item.kind, rows);
  const canSave = Object.values(values).some((v) => v !== "");

  const save = async () => {
    setBusy(true);
    setError(null);
    const res = await api.vaultUpdate(caller, item.name, { values }, revision);
    setBusy(false);
    if (!res.ok) {
      setError(conflictMessage(res));
      if (res.status === 409) onConflict();
      return;
    }
    toast.show(`Replaced the value of ${item.name}`);
    onSaved();
    onClose();
  };

  return (
    <ModalShell
      title={`Replace value of ${item.name}`}
      subtitle={
        <>
          <CallerPill alias={caller} /> · replaces every field; the current value is never shown
        </>
      }
      busy={busy}
      error={error}
      saveLabel="Replace"
      canSave={canSave}
      dirty={rowsDirty(rows)}
      onSave={() => void save()}
      onClose={onClose}
    >
      <Section title="New values" help="Write-only. Every field is replaced.">
        <ValuesEditor
          kind={item.kind}
          rows={rows}
          onChange={setRows}
          idPrefix="dl-vault-replace-v"
        />
      </Section>
    </ModalShell>
  );
}
