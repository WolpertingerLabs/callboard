import type { ParamFieldSpec } from "shared/types/index.js";

/**
 * Catalog-driven parameter form. Renders one labeled input per {@link ParamFieldSpec},
 * coercing values into the shape the shared validators expect:
 *  - number/integer  → number (empty input removes the key)
 *  - enum            → string (empty "(default)" option removes the key)
 *  - boolean         → boolean
 *  - string          → string (empty removes the key)
 *  - stringList      → string[] (edited as comma-separated text)
 *
 * `nestUnder` specs are read/written at `value[nestUnder][key]`. A spec whose
 * `supportedParamKey` is in `unsupportedKeys` is disabled with a note. Unset ≠
 * default: empty values are removed from the bag, never sent as the default.
 */
interface Props {
  specs: readonly ParamFieldSpec[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  /** snake_case `supportedParamKey`s the selected model does NOT advertise. */
  unsupportedKeys?: Set<string>;
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--text)",
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "monospace",
  boxSizing: "border-box",
};

const helpStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  marginTop: 4,
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  fontStyle: "italic",
  marginLeft: 6,
};

const fieldWrap: React.CSSProperties = {
  marginBottom: 12,
};

/** Read the current raw value for a spec, honoring `nestUnder`. */
function readRaw(value: Record<string, unknown>, spec: ParamFieldSpec): unknown {
  if (spec.nestUnder) {
    const nested = value[spec.nestUnder];
    return nested && typeof nested === "object" ? (nested as Record<string, unknown>)[spec.key] : undefined;
  }
  return value[spec.key];
}

export default function ParamFieldForm({ specs, value, onChange, unsupportedKeys }: Props) {
  /**
   * Set or delete a spec's value in the bag, honoring `nestUnder`. Passing
   * `undefined` removes the key (and prunes the nest object if it empties out).
   */
  const setValue = (spec: ParamFieldSpec, next: unknown) => {
    const out = { ...value };
    if (spec.nestUnder) {
      const nested = { ...((out[spec.nestUnder] as Record<string, unknown>) ?? {}) };
      if (next === undefined) delete nested[spec.key];
      else nested[spec.key] = next;
      if (Object.keys(nested).length === 0) delete out[spec.nestUnder];
      else out[spec.nestUnder] = nested;
    } else {
      if (next === undefined) delete out[spec.key];
      else out[spec.key] = next;
    }
    onChange(out);
  };

  return (
    <div>
      {specs.map((spec) => {
        const raw = readRaw(value, spec);
        const unsupported = spec.supportedParamKey !== undefined && (unsupportedKeys?.has(spec.supportedParamKey) ?? false);

        const labelEl = (
          <label style={labelStyle}>
            {spec.label}
            {spec.providerDependent && <span style={hintStyle}>provider-dependent</span>}
            {unsupported && <span style={hintStyle}>(not supported by this model)</span>}
          </label>
        );

        let inputEl: React.ReactNode;
        switch (spec.type) {
          case "number":
          case "integer":
            inputEl = (
              <input
                type="number"
                value={typeof raw === "number" ? raw : (raw as string) ?? ""}
                min={spec.min}
                max={spec.max}
                step={spec.step ?? (spec.type === "integer" ? 1 : "any")}
                placeholder={spec.default !== undefined ? `default: ${String(spec.default)}` : ""}
                disabled={unsupported}
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
                onChange={(e) => {
                  const v = e.target.value;
                  setValue(spec, v === "" ? undefined : Number(v));
                }}
              />
            );
            break;
          case "enum":
            inputEl = (
              <select
                value={typeof raw === "string" ? raw : ""}
                disabled={unsupported}
                style={inputStyle}
                onChange={(e) => setValue(spec, e.target.value === "" ? undefined : e.target.value)}
              >
                <option value="">(default)</option>
                {(spec.options ?? []).map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            );
            break;
          case "boolean":
            inputEl = (
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text)" }}>
                <input
                  type="checkbox"
                  checked={raw === true}
                  disabled={unsupported}
                  onChange={(e) => setValue(spec, e.target.checked ? true : undefined)}
                />
                Enabled
              </label>
            );
            break;
          case "string":
            inputEl = (
              <input
                type="text"
                value={typeof raw === "string" ? raw : ""}
                placeholder={spec.default !== undefined ? `default: ${String(spec.default)}` : ""}
                disabled={unsupported}
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
                onChange={(e) => setValue(spec, e.target.value === "" ? undefined : e.target.value)}
              />
            );
            break;
          case "stringList":
            inputEl = (
              <input
                type="text"
                value={Array.isArray(raw) ? (raw as string[]).join(", ") : typeof raw === "string" ? raw : ""}
                placeholder="comma, separated, values"
                disabled={unsupported}
                autoComplete="off"
                spellCheck={false}
                style={inputStyle}
                onChange={(e) => {
                  const parts = e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
                  setValue(spec, parts.length === 0 ? undefined : parts);
                }}
              />
            );
            break;
          default:
            inputEl = null;
        }

        return (
          <div key={spec.nestUnder ? `${spec.nestUnder}.${spec.key}` : spec.key} style={fieldWrap}>
            {labelEl}
            {inputEl}
            {spec.type === "stringList" && <div style={helpStyle}>Comma-separated.</div>}
            {spec.description && <div style={helpStyle}>{spec.description}</div>}
          </div>
        );
      })}
    </div>
  );
}
