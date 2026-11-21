/**
 * Write-only inputs for a vault item's secret values.
 *
 * The daemon never sends values back (except an explicit Reveal), so these
 * inputs always start empty. Each one is masked, with a show/hide toggle
 * while typing, as in ConfigureConnectionModal. Typed values live only in
 * the owning modal's state and are gone when it closes.
 */
import { useState } from "react";
import { Eye, EyeOff, Plus, X } from "lucide-react";
import type { AdminVaultKind } from "drawlatch-admin-types";

export interface ValueRow {
  field: string;
  value: string;
}

/** The fixed rows for a kind; key-value starts with one editable row. */
export function rowsForKind(kind: AdminVaultKind): ValueRow[] {
  switch (kind) {
    case "token":
    case "note":
      return [{ field: "value", value: "" }];
    case "password":
      return [
        { field: "username", value: "" },
        { field: "value", value: "" },
      ];
    case "key-value":
      return [{ field: "", value: "" }];
  }
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
  const set = (i: number, patch: Partial<ValueRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="dl-secrets-fields">
      {rows.map((row, i) => (
        <div className="dl-secrets-field" key={i}>
          {editableNames ? (
            <div className="dl-vault-kv-head">
              <input
                className="dl-secrets-input dl-vault-kv-name"
                aria-label={`Field ${i + 1} name`}
                placeholder="field_name"
                autoComplete="off"
                spellCheck={false}
                value={row.field}
                onChange={(e) => set(i, { field: e.target.value })}
              />
              {rows.length > 1 && (
                <button
                  type="button"
                  className="dl-secrets-clear-btn dl-tap-compact"
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  title="Remove this field"
                >
                  <X size={11} />
                  Remove
                </button>
              )}
            </div>
          ) : (
            <div className="dl-secrets-field-head">
              <label className="dl-secrets-label" htmlFor={`${idPrefix}-${i}`}>
                {LABELS[row.field] ?? row.field}
              </label>
            </div>
          )}
          <MaskedInput
            id={`${idPrefix}-${i}`}
            label={editableNames ? `Field ${i + 1} value` : undefined}
            value={row.value}
            onChange={(v) => set(i, { value: v })}
          />
        </div>
      ))}
      {editableNames && rows.length < 16 && (
        <button
          type="button"
          className="dl-secrets-optional-toggle"
          onClick={() => onChange([...rows, { field: "", value: "" }])}
        >
          <Plus size={14} />
          Add field
        </button>
      )}
    </div>
  );
}

function MaskedInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label?: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="dl-secrets-input-wrap">
      <input
        id={id}
        className="dl-secrets-input"
        type={show ? "text" : "password"}
        aria-label={label}
        autoComplete="new-password"
        spellCheck={false}
        placeholder="Enter value"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="dl-secrets-eye dl-tap-compact"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide value" : "Show value"}
        title={show ? "Hide value" : "Show value"}
      >
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}
