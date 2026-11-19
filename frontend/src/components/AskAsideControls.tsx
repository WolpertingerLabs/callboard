/**
 * "Ask as aside" for the quote tray (its `actions` slot): the tray's quotes
 * and the composer's text become a side question in a child chat forked at the
 * latest quote, instead of going to the main thread.
 *
 * A compact options row rides with the button:
 * - **Read only** — one click; asks fileWrite and codeExecution to "ask", the
 *   rest inherited (the daemon caps it to never be looser than this chat). Its
 *   last state is kept in localStorage and pre-selected next time.
 * - **Harness / model** — "Same as chat" by default. An explicit choice is
 *   remembered and offered next time as a one-click recent chip, but never
 *   pre-selected: a stored model may belong to another harness than the chat's.
 *
 * Pure presentation plus the two preferences; the request is the caller's
 * (`onAsk`), which resolves to whether the aside was created.
 */
import { useId, useRef, useState } from "react";
import { History, Lock, MessageSquareQuote } from "lucide-react";
import ClaudeModelSelector from "./ClaudeModelSelector";
import CodexModelSelector from "./CodexModelSelector";
import PiModelSelector from "./PiModelSelector";
import type { ForkProvider } from "../api";
import { getAsideReadOnly, getAsideRecentTarget, saveAsideReadOnly, saveAsideRecentTarget, type AsideTarget } from "../utils/localStorage";

export interface AskAsideOptions {
  readOnly: boolean;
  /** null = same harness and model as the chat. */
  target: AsideTarget | null;
}

interface Props {
  /** The chat's own harness, named in "Same as chat". */
  chatProvider: ForkProvider;
  /** True while a request is out: the button is disabled (no double submit). */
  busy: boolean;
  /** Why the last attempt failed, shown under the row. */
  error?: string | null;
  onAsk: (options: AskAsideOptions) => Promise<boolean>;
}

const HARNESSES: { kind: ForkProvider; label: string }[] = [
  { kind: "claude-code", label: "Claude Code" },
  { kind: "codex", label: "Codex" },
  { kind: "pi", label: "pi" },
];
const harnessLabel = (kind: ForkProvider) => HARNESSES.find((h) => h.kind === kind)?.label ?? kind;
const targetLabel = (t: AsideTarget) => (t.model ? `${harnessLabel(t.provider)} · ${t.model}` : harnessLabel(t.provider));
const sameTarget = (a: AsideTarget | null, b: AsideTarget | null) => !!a && !!b && a.provider === b.provider && (a.model ?? "") === (b.model ?? "");

/** Read only as the daemon takes it: only the two write-capable axes, the rest inherited. */
export const READ_ONLY_PERMISSIONS = { fileWrite: "ask", codeExecution: "ask" } as const;

const chipStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  minHeight: 28,
  padding: "2px 8px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--surface)",
  color: "var(--text)",
  fontSize: 12,
  cursor: "pointer",
} as const;

export default function AskAsideControls({ chatProvider, busy, error, onAsk }: Props) {
  const [readOnly, setReadOnly] = useState(getAsideReadOnly);
  const [target, setTarget] = useState<AsideTarget | null>(null);
  const [recent, setRecent] = useState(getAsideRecentTarget);
  const modelId = useId();
  // Two clicks in one tick both run before `busy` re-renders: guard locally too.
  const askingRef = useRef(false);

  const toggleReadOnly = () => {
    const next = !readOnly;
    setReadOnly(next);
    saveAsideReadOnly(next);
  };

  const ask = async () => {
    if (busy || askingRef.current) return;
    askingRef.current = true;
    const chosen = target && { provider: target.provider, ...(target.model?.trim() && { model: target.model.trim() }) };
    let created = false;
    try {
      created = await onAsk({ readOnly, target: chosen });
    } finally {
      askingRef.current = false;
    }
    if (created && chosen) {
      saveAsideRecentTarget(chosen);
      setRecent(chosen);
    }
  };

  const selectorProps = {
    id: modelId,
    value: target?.model ?? "",
    onChange: (model: string) => setTarget((t) => t && { ...t, model }),
    placeholder: "Default model",
  };

  return (
    <div role="group" aria-label="Ask as aside" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, flexBasis: "100%", minWidth: 0 }}>
      <button
        type="button"
        aria-pressed={readOnly}
        onClick={toggleReadOnly}
        title="Read only: the aside asks before writing files or running code"
        style={{
          ...chipStyle,
          ...(readOnly && { background: "var(--accent)", color: "var(--text-on-accent)", borderColor: "var(--accent)" }),
        }}
      >
        <Lock size={12} aria-hidden />
        Read only
      </button>
      <select
        aria-label="Aside harness"
        value={target?.provider ?? ""}
        onChange={(e) => setTarget(e.target.value ? { provider: e.target.value as ForkProvider } : null)}
        style={{ ...chipStyle, paddingRight: 4 }}
      >
        <option value="">Same as chat ({harnessLabel(chatProvider)})</option>
        {HARNESSES.map((h) => (
          <option key={h.kind} value={h.kind}>
            {h.label}
          </option>
        ))}
      </select>
      {target && (
        <div style={{ flex: "1 1 160px", minWidth: 140, maxWidth: 280, fontSize: 12 }}>
          <label htmlFor={modelId} style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
            Aside model
          </label>
          {target.provider === "claude-code" && <ClaudeModelSelector {...selectorProps} />}
          {target.provider === "codex" && <CodexModelSelector {...selectorProps} />}
          {target.provider === "pi" && <PiModelSelector {...selectorProps} />}
        </div>
      )}
      {recent && !sameTarget(recent, target) && (
        <button type="button" onClick={() => setTarget(recent)} title="Use the harness and model of your last aside" style={chipStyle}>
          <History size={12} aria-hidden />
          {targetLabel(recent)}
        </button>
      )}
      <button
        type="button"
        onClick={() => void ask()}
        disabled={busy}
        aria-busy={busy}
        title="Ask the composer's question about the quoted passages in a side branch"
        style={{
          ...chipStyle,
          marginLeft: "auto",
          background: "var(--accent)",
          color: "var(--text-on-accent)",
          borderColor: "var(--accent)",
          opacity: busy ? 0.6 : 1,
          cursor: busy ? "default" : "pointer",
        }}
      >
        <MessageSquareQuote size={12} aria-hidden />
        {busy ? "Asking…" : "Ask as aside"}
      </button>
      {error && (
        <div role="alert" style={{ flexBasis: "100%", color: "var(--error)", fontSize: 12 }}>
          {error}
        </div>
      )}
    </div>
  );
}
