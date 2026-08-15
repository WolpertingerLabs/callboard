import { useEffect, useState } from "react";
import ModalOverlay from "./ModalOverlay";
import ClaudeModelSelector from "./ClaudeModelSelector";
import CodexModelSelector from "./CodexModelSelector";
import PiModelSelector from "./PiModelSelector";
import type { ForkProvider, ForkSourceProvider } from "../api";

interface Props {
  /** Target harness, or null when the modal is closed. */
  target: ForkProvider | null;
  /**
   * The chat's own harness, named in the explanation. Widened past
   * {@link ForkProvider} because a retired harness can still be forked *out of*
   * — see {@link ForkSourceProvider}. `null` for a chat that cannot be forked at
   * all (ACP).
   */
  from: ForkSourceProvider | null;
  onCancel: () => void;
  onConfirm: (opts: { model?: string }) => void;
}

const LABELS: Record<ForkSourceProvider, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  openrouter: "OpenRouter",
  cline: "Cline",
  pi: "pi",
};

/**
 * Confirmation step for handing a conversation to a different harness.
 *
 * Exists mainly to carry the model field: a switch cannot inherit the source
 * chat's model (the ids are per-harness), so without somewhere to choose one
 * every handoff would silently land on the target's global default. The
 * explanatory text is the other half — the fidelity loss is real and easier to
 * accept when stated before the fork than discovered after it.
 */
/**
 * Model state resets between openings because the caller keys this component
 * on the target harness — a different target remounts it, so a slug typed for
 * one harness can't leak into a handoff to another where it means nothing.
 */
export default function ForkHandoffModal({ target, from, onCancel, onConfirm }: Props) {
  const [model, setModel] = useState("");

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [target, onCancel]);

  if (!target || !from) return null;

  const label = LABELS[target];

  return (
    <ModalOverlay>
      <div
        style={{
          background: "var(--bg)",
          borderRadius: 8,
          padding: 24,
          width: "90%",
          maxWidth: 460,
          border: "1px solid var(--border)",
        }}
      >
        <h2 style={{ margin: "0 0 12px 0", fontSize: 18 }}>Continue in {label}</h2>

        <p style={{ margin: "0 0 16px 0", fontSize: 14, color: "var(--text)", lineHeight: 1.5 }}>
          Forks this conversation into a new {label} chat, carrying the history up to the message you picked. {LABELS[from]} stays untouched.
        </p>
        <p style={{ margin: "0 0 20px 0", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Tool calls carry over as text summaries rather than real tool history, and {label} re-reads the whole conversation on its first reply.
        </p>

        <label htmlFor="fork-handoff-model" style={{ display: "block", fontSize: 13, marginBottom: 6, color: "var(--text)" }}>
          Model <span style={{ color: "var(--text-muted)" }}>— optional</span>
        </label>
        <div style={{ marginBottom: 24 }}>
          {target === "claude-code" && <ClaudeModelSelector id="fork-handoff-model" value={model} onChange={setModel} placeholder="Default model" />}
          {target === "codex" && <CodexModelSelector id="fork-handoff-model" value={model} onChange={setModel} placeholder="Default model" />}
          {target === "pi" && <PiModelSelector id="fork-handoff-model" value={model} onChange={setModel} placeholder="Default model" />}
          {/* Cline has no selector of its own: its catalog is per-provider and
              the provider is a global setting, so there is no list to offer
              here. Free text, same as the Model Aliases column. */}
          {target === "cline" && (
            <input
              id="fork-handoff-model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Default model"
              autoComplete="off"
              spellCheck={false}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 8,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                fontSize: 13,
                fontFamily: "monospace",
                boxSizing: "border-box",
              }}
            />
          )}
        </div>

        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm({ ...(model.trim() && { model: model.trim() }) })}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              fontSize: 14,
              background: "var(--accent)",
              color: "var(--text-on-accent)",
              border: "none",
              cursor: "pointer",
            }}
          >
            Continue in {label}
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
