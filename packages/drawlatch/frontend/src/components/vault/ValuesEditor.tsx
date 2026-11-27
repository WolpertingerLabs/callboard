/**
 * Write-only inputs for a vault item's secret values.
 *
 * The daemon never sends values back (except an explicit Reveal), so these
 * inputs always start empty. Each one is masked, with a show/hide toggle
 * while typing. Typed values live only in the owning modal's state and are
 * gone when it closes.
 *
 * Rows carry a stable `id`: removing a key/value row must not move another
 * row's show/hide state (and so unmask a different secret).
 */
import { useState } from "react";
import { Eye, EyeOff, Plus, X } from "lucide-react";
import type { AdminVaultKind } from "drawlatch-admin-types";
import "./VaultForms.css";

export interface ValueRow {
  /** Stable React key; never sent anywhere. */
  id: number;
  field: string;
  value: string;
}

let nextRowId = 1;

export function newRow(field = "", value = ""): ValueRow {
  return { id: nextRowId++, field, value };
}

/** The fixed fields for a kind; key-value starts with one editable row. */
function fieldsForKind(kind: AdminVaultKind): string[] {
  switch (kind) {
    case "token":
    case "note":
      return ["value"];
    case "password":
      return ["username", "value"];
    case "key-value":
      return [""];
  }
}

export function rowsForKind(kind: AdminVaultKind): ValueRow[] {
  return fieldsForKind(kind).map((f) => newRow(f));
}

/**
 * Rows for `kind`, keeping what was typed where the field still exists
 * (`value` stays `value`; into a key/value set every typed row carries over).
 * `dropped` names the typed fields the new kind has no place for.
 */
export function convertRows(
  rows: ValueRow[],
  kind: AdminVaultKind,
): { rows: ValueRow[]; dropped: string[] } {
  const typed = rows.filter((r) => r.value !== "");
  if (kind === "key-value") {
    const kept = typed.map((r) => newRow(r.field, r.value));
    return { rows: kept.length > 0 ? kept : rowsForKind(kind), dropped: [] };
  }
  const fields = fieldsForKind(kind);
  const next = fields.map((f) => newRow(f, rows.find((r) => r.field === f)?.value ?? ""));
  const dropped = typed.filter((r) => !fields.includes(r.field)).map((r) => r.field || "(unnamed)");
  return { rows: next, dropped };
}

/** Rows to a `values` object. An empty optional `username` is left out. */
export function rowsToValues(
  kind: AdminVaultKind,
  rows: ValueRow[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (kind === "password" && r.field === "username" && r.value === "") continue;
    if (kind === "key-value" && r.field === "" && r.value === "") continue;
    out[r.field] = r.value;
  }
  return out;
}

/** Anything typed at all (for "discard changes?"). */
export function rowsDirty(rows: ValueRow[]): boolean {
  return rows.some((r) => r.value !== "");
}

const LABELS: Record<string, string> = {
  value: "Value",
  username: "Username (optional, also secret)",
};

interface Props {
  kind: AdminVaultKind;
  rows: ValueRow[];
  onChange: (rows: ValueRow[]) => void;
  /** Prefix for input ids, unique per modal. */
  idPrefix: string;
}

export default function ValuesEditor({ kind, rows, onChange, idPrefix }: Props) {
  const editableNames = kind === "key-value";
  const set = (id: number, patch: Partial<ValueRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div className="dl-vf-fields">
      {rows.map((row, i) => (
        <div className="dl-vf-field" key={row.id}>
          {editableNames ? (
            <div className="dl-vf-kv-head">
              <input
                className="input dl-vf-kv-name"
                aria-label={`Field ${i + 1} name`}
                placeholder="field_name"
                autoComplete="off"
                spellCheck={false}
                value={row.field}
                onChange={(e) => set(row.id, { field: e.target.value })}
              />
              {rows.length > 1 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon"
                  onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
                  aria-label={`Remove field ${row.field || i + 1}`}
                  title="Remove this field"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          ) : (
            <label className="field-label" htmlFor={`${idPrefix}-${row.id}`}>
              {LABELS[row.field] ?? row.field}
            </label>
          )}
          <MaskedInput
            id={`${idPrefix}-${row.id}`}
            label={editableNames ? `Field ${i + 1} value` : undefined}
            multiline={kind === "note"}
            value={row.value}
            onChange={(v) => set(row.id, { value: v })}
          />
        </div>
      ))}
      {editableNames && rows.length < 16 && (
        <button
          type="button"
          className="btn btn-ghost btn-sm dl-vf-add"
          onClick={() => onChange([...rows, newRow()])}
        >
          <Plus size={14} aria-hidden="true" />
          Add field
        </button>
      )}
    </div>
  );
}

function MaskedInput({
  id,
  label,
  multiline,
  value,
  onChange,
}: {
  id: string;
  label?: string;
  multiline: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="dl-vf-masked">
      {multiline ? (
        // Masked on screen only: a textarea has no type="password", so
        // assistive tech still reads what is typed. Say so rather than imply
        // otherwise. (A revealed note is different: RevealFlow keeps a hidden
        // value out of the page entirely.)
        <textarea
          id={id}
          className={`input dl-vf-textarea${show ? "" : " is-hidden"}`}
          aria-label={label}
          aria-describedby={show ? undefined : `${id}-masked`}
          autoComplete="off"
          spellCheck={false}
          rows={4}
          placeholder="Enter value"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={id}
          className="input"
          type={show ? "text" : "password"}
          aria-label={label}
          autoComplete="new-password"
          spellCheck={false}
          placeholder="Enter value"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {multiline && !show && (
        <span id={`${id}-masked`} className="sr-only">
          Hidden on screen only; a screen reader still reads this field.
        </span>
      )}
      <button
        type="button"
        className="btn btn-secondary btn-icon"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide value" : "Show value"}
        aria-pressed={show}
        title={show ? "Hide value" : "Show value"}
      >
        {show ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
      </button>
    </div>
  );
}
