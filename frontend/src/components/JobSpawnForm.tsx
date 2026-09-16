import type { ReactNode } from "react";
import { type JobDefinition } from "../api";

interface Props {
  /** The definition being spawned — supplies the input fields and their rules. */
  job: JobDefinition;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitting: boolean;
  submitLabel: string;
  submittingLabel: string;
  /** Optional glyph before the submit label. */
  submitIcon?: ReactNode;
  /** Call-site framing rendered above the fields (a title, a description). */
  header?: ReactNode;
  /** Shown in place of the fields when the job declares none. */
  noInputsNote?: ReactNode;
  /** Rendered above the buttons. Omit where the call site has its own error surface. */
  error?: string | null;
  /** Target of the opener's `aria-controls`. */
  id?: string;
  /** Merged over the default box — margins and spacing are the caller's. */
  style?: React.CSSProperties;
}

const boxStyle: React.CSSProperties = {
  padding: 12,
  borderRadius: 6,
  border: "1px solid var(--accent)",
  background: "var(--surface)",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 6,
  color: "var(--text)",
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text)",
  fontSize: 13,
  boxSizing: "border-box",
};

const errorBoxStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  background: "var(--danger-bg)",
  border: "1px solid var(--danger-border)",
  color: "var(--danger)",
  fontSize: 12,
  marginBottom: 10,
  whiteSpace: "pre-wrap",
};

/**
 * The inline "run this job" form — its declared inputs, and the second click
 * that actually spawns.
 *
 * Shared between Settings → Jobs and the New Chat launchpad because the two had
 * drifted into near-identical copies of the same ninety lines: the same
 * `type === "text" ? textarea : input` branch, the same
 * required-field-blocks-submit predicate, the same cancel/confirm pair. That
 * predicate in particular is the thing worth having once — it is the only
 * client-side guard against spawning a run that the daemon will reject, and two
 * copies of it is two places for it to disagree with the job's schema.
 *
 * What is NOT shared is what happens after: Settings refreshes its run table
 * and expands the new row, the launchpad hands its space to the run panel. The
 * form reports `onSubmit` and the call site decides.
 */
export default function JobSpawnForm({
  job,
  values,
  onChange,
  onSubmit,
  onCancel,
  submitting,
  submitLabel,
  submittingLabel,
  submitIcon,
  header,
  noInputsNote,
  error,
  id,
  style,
}: Props) {
  const inputs = job.inputs ?? [];
  const missingRequired = inputs.some((i) => i.required && !(values[i.key] ?? "").trim());

  return (
    <div id={id} style={{ ...boxStyle, ...style }}>
      {header}
      {inputs.map((input) => (
        <div key={input.key} style={{ marginBottom: 10 }}>
          <label style={labelStyle} htmlFor={id ? `${id}-${input.key}` : undefined}>
            {input.label || input.key}
            {input.required && <span style={{ color: "var(--danger)" }}> *</span>}
          </label>
          {input.type === "text" ? (
            <textarea
              id={id ? `${id}-${input.key}` : undefined}
              style={{ ...fieldStyle, minHeight: 80, resize: "vertical" }}
              value={values[input.key] ?? ""}
              onChange={(e) => onChange({ ...values, [input.key]: e.target.value })}
            />
          ) : (
            <input
              id={id ? `${id}-${input.key}` : undefined}
              style={fieldStyle}
              value={values[input.key] ?? ""}
              onChange={(e) => onChange({ ...values, [input.key]: e.target.value })}
            />
          )}
        </div>
      ))}
      {inputs.length === 0 && noInputsNote}
      {error && <div style={errorBoxStyle}>{error}</div>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          disabled={submitting}
          style={{
            padding: "6px 12px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "transparent",
            color: "var(--text)",
            fontSize: 13,
            cursor: submitting ? "default" : "pointer",
          }}
        >
          Cancel
        </button>
        <button
          onClick={onSubmit}
          disabled={submitting || missingRequired}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 12px",
            borderRadius: 6,
            border: "none",
            background: submitting || missingRequired ? "var(--surface)" : "var(--accent)",
            color: submitting || missingRequired ? "var(--text-muted)" : "var(--text-on-accent)",
            fontSize: 13,
            fontWeight: 600,
            cursor: submitting || missingRequired ? "default" : "pointer",
          }}
        >
          {submitIcon}
          {submitting ? submittingLabel : submitLabel}
        </button>
      </div>
    </div>
  );
}
