/**
 * Vault item modals: New item, Edit (metadata, exposure, binding), and
 * Replace value. Values are write-only: nothing here ever shows a stored
 * value, and typed values live only in the modal's own state.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import type {
  AdminVaultExposure,
  AdminVaultItem,
  AdminVaultKind,
} from "drawlatch-admin-types";
import { api, type VaultItemPatch } from "../../api";
import { conflictMessage } from "./conflict";
import ValuesEditor, { rowsForKind, rowsToValues, type ValueRow } from "./ValuesEditor";
import "../ConfigureConnectionModal.css";

const KINDS: { kind: AdminVaultKind; label: string }[] = [
  { kind: "token", label: "Token" },
  { kind: "password", label: "Password" },
  { kind: "note", label: "Note" },
  { kind: "key-value", label: "Key/value set" },
];

// ── Shell ──────────────────────────────────────────────────────────────────

export function ModalShell({
  title,
  subtitle,
  busy,
  error,
  saveLabel,
  canSave,
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
  onSave: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const formId = useId();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  return (
    <div
      className="dl-secrets-overlay"
      role="presentation"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="dl-secrets-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dl-secrets-header">
          <div style={{ minWidth: 0 }}>
            <h2 className="dl-secrets-title">{title}</h2>
            <div className="dl-secrets-alias">{subtitle}</div>
          </div>
          <button
            type="button"
            className="dl-secrets-close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>
        <form
          className="dl-secrets-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave && !busy) onSave();
          }}
          id={formId}
        >
          {children}
        </form>
        <div className="dl-secrets-footer">
          <div className={"dl-secrets-status" + (error ? " is-error" : "")}>
            {error}
          </div>
          <div className="dl-secrets-actions">
            <button
              type="button"
              className="dl-secrets-btn dl-secrets-btn-secondary"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              form={formId}
              className="dl-secrets-btn dl-secrets-btn-primary"
              disabled={!canSave || busy}
            >
              {busy && <Loader2 size={14} className="dl-secrets-spin" />}
              {saveLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="dl-secrets-section">
      <h3 className="dl-secrets-section-title">{title}</h3>
      {children}
    </div>
  );
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
        <div className="dl-vault-radio-group">
          <label className="dl-vault-radio">
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
          <label className="dl-vault-radio">
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
        <div className="dl-vault-radio-group">
          <label className="dl-vault-radio">
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
            <div className="dl-vault-checks">
              {options.length === 0 && (
                <span className="cell-muted">
                  This caller has no connections enabled.
                </span>
              )}
              {options.map((c) => (
                <label key={c} className="dl-vault-check mono">
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
          <label className="dl-vault-radio">
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

      <Section title="Details (not secret: the agent can read these)">
        <div className="dl-secrets-fields">
          <div className="dl-secrets-field">
            <label className="dl-secrets-label" htmlFor={`${idPrefix}-tags`}>
              Tags (comma-separated)
            </label>
            <input
              id={`${idPrefix}-tags`}
              className="dl-secrets-input"
              value={meta.tags}
              onChange={(e) => setMeta({ ...meta, tags: e.target.value })}
            />
          </div>
          <div className="dl-secrets-field">
            <label className="dl-secrets-label" htmlFor={`${idPrefix}-notes`}>
              Notes
            </label>
            <textarea
              id={`${idPrefix}-notes`}
              className="dl-secrets-input dl-vault-textarea"
              rows={2}
              value={meta.notes}
              onChange={(e) => setMeta({ ...meta, notes: e.target.value })}
            />
          </div>
          <div className="dl-secrets-field">
            <label className="dl-secrets-label" htmlFor={`${idPrefix}-meta`}>
              Metadata (one key=value per line)
            </label>
            <textarea
              id={`${idPrefix}-meta`}
              className="dl-secrets-input dl-vault-textarea mono"
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
  const [name, setName] = useState("");
  const [kind, setKind] = useState<AdminVaultKind>("token");
  const [rows, setRows] = useState<ValueRow[]>(rowsForKind("token"));
  // Defaults: inject, bound to one of the caller's enabled connections.
  const [meta, setMeta] = useState<MetaState>({
    exposure: "inject",
    connections: callerConnections.length > 0 ? [callerConnections[0]] : null,
    tags: "",
    notes: "",
    metadata: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const values = rowsToValues(kind, rows);
  const canSave = name.trim() !== "" && Object.values(values).some((v) => v !== "");

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
    onSaved();
    onClose();
  };

  return (
    <ModalShell
      title="New vault item"
      subtitle={
        <>
          for <span className="mono dl-secrets-pill">{caller}</span>, created by
          the admin
        </>
      }
      busy={busy}
      error={error}
      saveLabel="Create"
      canSave={canSave}
      onSave={() => void save()}
      onClose={onClose}
    >
      <Section title="Item">
        <div className="dl-secrets-fields">
          <div className="dl-secrets-field">
            <label className="dl-secrets-label" htmlFor="dl-vault-new-name">
              Name
            </label>
            <input
              id="dl-vault-new-name"
              className="dl-secrets-input mono"
              placeholder="forgejo-token"
              autoComplete="off"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="dl-secrets-field">
            <label className="dl-secrets-label" htmlFor="dl-vault-new-kind">
              Kind
            </label>
            <select
              id="dl-vault-new-kind"
              className="dl-secrets-input"
              value={kind}
              onChange={(e) => {
                const k = e.target.value as AdminVaultKind;
                setKind(k);
                setRows(rowsForKind(k));
              }}
            >
              {KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Section>
      <Section title="Secret values (write-only)">
        <ValuesEditor kind={kind} rows={rows} onChange={setRows} idPrefix="dl-vault-new-v" />
      </Section>
      <MetaFields
        meta={meta}
        setMeta={setMeta}
        callerConnections={callerConnections}
        idPrefix="dl-vault-new"
      />
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
  const initial = useMemo(() => metaFromItem(item), [item]);
  const [name, setName] = useState(item.name);
  const [meta, setMeta] = useState<MetaState>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    onSaved();
    onClose();
  };

  return (
    <ModalShell
      title={`Edit ${item.name}`}
      subtitle={
        <>
          <span className="mono dl-secrets-pill">{caller}</span> · {item.kind} ·
          fields: <span className="mono">{item.fields.join(", ")}</span>
        </>
      }
      busy={busy}
      error={error}
      saveLabel="Save"
      canSave={name.trim() !== ""}
      onSave={() => void save()}
      onClose={onClose}
    >
      <Section title="Name">
        <input
          className="dl-secrets-input mono"
          aria-label="Name"
          autoComplete="off"
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {name.trim() !== item.name && (
          <p className="dl-secrets-help">
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
  const [rows, setRows] = useState<ValueRow[]>(() =>
    item.kind === "key-value"
      ? item.fields.map((f) => ({ field: f, value: "" }))
      : rowsForKind(item.kind),
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
    onSaved();
    onClose();
  };

  return (
    <ModalShell
      title={`Replace value of ${item.name}`}
      subtitle={
        <>
          <span className="mono dl-secrets-pill">{caller}</span> · replaces every
          field; the current value is never shown
        </>
      }
      busy={busy}
      error={error}
      saveLabel="Replace"
      canSave={canSave}
      onSave={() => void save()}
      onClose={onClose}
    >
      <Section title="New values (write-only)">
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
