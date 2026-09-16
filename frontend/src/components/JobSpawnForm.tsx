import type { ReactNode } from "react";
import { type JobDefinition } from "../api";
import { MIN_TAP_TARGET } from "./SessionInfoNav";

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

const blockedNoteStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  marginBottom: 10,
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

/** "Target", "Target and Branch", "Target, Branch and Tag". */
function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

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
 * That predicate also has to *show*. A blocked submit that still renders at full
 * accent is a primary CTA for an irreversible action that looks live and does
 * nothing, so the button goes muted and names the empty field — in a note above
 * it and in its `title` — rather than leaving the user to work back from a red
 * asterisk.
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
  /**
   * Named, not counted. A red asterisk says *a* field is required; it does not
   * say which one is empty, and on a form with three of them that is the
   * difference between a fix and a hunt. The same string is the button's
   * `title`, because a disabled button carries no tooltip of its own and the
   * pointer is the first place a user asks "why is this dead?".
   */
  const missingRequired = inputs.filter((i) => i.required && !(values[i.key] ?? "").trim()).map((i) => i.label || i.key);
  const blockedReason = missingRequired.length > 0 ? `Fill in ${listNames(missingRequired)} to continue.` : null;
  const blocked = submitting || blockedReason !== null;

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
      {blockedReason && !submitting && <div style={blockedNoteStyle}>{blockedReason}</div>}
      {error && <div style={errorBoxStyle}>{error}</div>}
      {/* Raised as a pair: this is the confirm step of an irreversible action
          and it is reached from a phone, where a 29px button is a miss waiting
          to happen. See MIN_TAP_TARGET. */}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button
          onClick={onCancel}
          disabled={submitting}
          style={{
            padding: "6px 14px",
            minHeight: MIN_TAP_TARGET,
            boxSizing: "border-box",
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
          disabled={blocked}
          title={blockedReason ?? undefined}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 14px",
            minHeight: MIN_TAP_TARGET,
            boxSizing: "border-box",
            borderRadius: 6,
            border: "none",
            // Muted fill rather than a dimmed accent, matching NewChatPanel's
            // Create button. Spawning is irreversible, so the CTA must not read
            // as live while it is refusing.
            background: blocked ? "var(--border)" : "var(--accent)",
            color: blocked ? "var(--text-muted)" : "var(--text-on-accent)",
            fontSize: 13,
            fontWeight: 600,
            cursor: blocked ? "not-allowed" : "pointer",
          }}
        >
          {submitIcon}
          {submitting ? submittingLabel : submitLabel}
        </button>
      </div>
    </div>
  );
}
