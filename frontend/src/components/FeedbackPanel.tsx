import { useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { CU_ACTION_TOOL_NAME, CU_REQUEST_CONTROL_TOOL_NAME } from "shared/types/index.js";
import MarkdownRenderer from "./MarkdownRenderer";

export interface PendingAction {
  type: "permission_request" | "user_question" | "plan_review";
  requestId?: string;
  humanOnly?: boolean;
  controlRequest?: boolean;
  toolName?: string;
  input?: Record<string, unknown>;
  questions?: any[];
  suggestions?: any[];
  content?: string;
  /** True when reconstructed from message history (no live backend session) */
  stale?: boolean;
}

interface Props {
  action: PendingAction;
  onRespond: (allow: boolean, updatedInput?: Record<string, unknown>) => void;
  /** Display name of the harness running this chat (e.g. "Claude", "Codex", "OpenCode") */
  agentName?: string;
}

export default function FeedbackPanel({ action, onRespond, agentName = "Claude" }: Props) {
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  const [planExpanded, setPlanExpanded] = useState(false);

  if (
    action.type === "permission_request" &&
    action.toolName === CU_REQUEST_CONTROL_TOOL_NAME &&
    action.humanOnly === true &&
    action.controlRequest === true &&
    action.requestId
  ) {
    const desktop = action.input?.kind === "desktop";
    const label = desktop ? "desktop" : "browser";
    return (
      <div style={questionPanelStyle}>
        <strong>Enable {label} control</strong>
        <div style={questionScrollArea}>
          <p>Target: {String(action.input?.target ?? "")}</p>
          <p style={{ whiteSpace: "pre-wrap" }}>{String(action.input?.reason ?? "")}</p>
          <p>Screenshots of this target are sent to the configured model when requested. Pixel actions may transmit data, change files or execute code.</p>
          <p>
            {action.input?.permission === "ask"
              ? "Ask: each agent action requires a separate confirmation here in chat."
              : "Allow: the agent can act unattended after you enable control."}
          </p>
          <p>Grant duration: up to 15 minutes. You can Stop computer control at any time.</p>
          {desktop && (
            <p>Native desktop control covers the full desktop and existing app windows on the service host, not an isolated browser or your viewing device.</p>
          )}
          <p>Subagents running inside this chat’s turn share this grant and this chat’s permissions.</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button onClick={() => onRespond(true)} style={allowBtn}>
            Enable {label} control
          </button>
          <button onClick={() => onRespond(false)} style={denyBtn}>
            Deny
          </button>
        </div>
      </div>
    );
  }

  if (action.type === "permission_request") {
    const guiAction = isComputerUseAction(action.toolName);
    return (
      <div style={panelStyle}>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 4 }}>{guiAction ? "Confirm this GUI action" : "Permission requested"}</div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>{guiAction ? "Computer control" : action.toolName}</div>
        {action.input && <pre style={preStyle}>{formatInput(action.toolName!, action.input)}</pre>}
        {guiAction && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 0, marginBottom: 10 }}>
            This chat asks before every GUI action: a pixel action may transmit data, change files or execute code.
          </p>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => onRespond(true)} style={allowBtn}>
            {guiAction ? "Confirm" : "Allow"}
          </button>
          <button onClick={() => onRespond(false)} style={denyBtn}>
            Deny
          </button>
        </div>
      </div>
    );
  }

  if (action.type === "user_question") {
    const questions = action.questions || [];
    return (
      <div style={questionPanelStyle}>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 8, flexShrink: 0 }}>{agentName} is asking</div>
        <div style={questionScrollArea}>
          {questions.map((q: any, qi: number) => (
            <div key={qi} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{q.question}</div>
              {(q.options || []).map((opt: any, oi: number) => {
                const selected = q.multiSelect ? ((answers[qi] as string[]) || []).includes(opt.label) : answers[qi] === opt.label;
                return (
                  <button
                    key={oi}
                    onClick={() => {
                      if (q.multiSelect) {
                        const cur = (answers[qi] as string[]) || [];
                        setAnswers((prev) => ({
                          ...prev,
                          [qi]: selected ? cur.filter((l) => l !== opt.label) : [...cur, opt.label],
                        }));
                      } else {
                        setAnswers((prev) => ({ ...prev, [qi]: opt.label }));
                      }
                    }}
                    style={{
                      ...optionBtn,
                      border: selected ? "2px solid var(--accent)" : "1px solid var(--border)",
                      background: selected ? "var(--accent-light)" : "var(--surface)",
                    }}
                  >
                    <div style={{ fontWeight: 500 }}>{opt.label}</div>
                    {opt.description && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{opt.description}</div>}
                  </button>
                );
              })}
              <input
                placeholder="Other..."
                value={otherText[qi] || ""}
                onChange={(e) => {
                  setOtherText((prev) => ({ ...prev, [qi]: e.target.value }));
                  if (e.target.value) {
                    setAnswers((prev) => ({ ...prev, [qi]: e.target.value }));
                  }
                }}
                style={{ ...inputStyle, marginTop: 4 }}
              />
            </div>
          ))}
        </div>
        <button
          onClick={() => {
            // The SDK schema expects answers as Record<questionText, string>,
            // with multi-select answers joined into a comma-separated string.
            const formatted: Record<string, string> = {};
            questions.forEach((q: any, qi: number) => {
              const val = answers[qi];
              if (Array.isArray(val)) {
                if (val.length > 0) formatted[q.question] = val.join(", ");
              } else if (val) {
                formatted[q.question] = val;
              }
            });
            onRespond(true, { answers: formatted });
          }}
          style={{ ...allowBtn, flexShrink: 0 }}
        >
          Submit
        </button>
      </div>
    );
  }

  if (action.type === "plan_review") {
    const planContent = extractPlanFromContent(action.content);

    return (
      <div style={panelStyle}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Plan review</div>
          <button onClick={() => setPlanExpanded((e) => !e)} title={planExpanded ? "Contract" : "Expand"} style={expandToggleBtn}>
            {planExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
        <div
          style={{
            ...planContainerStyle,
            maxHeight: planExpanded ? "75vh" : 300,
            transition: "max-height 0.3s ease",
          }}
        >
          <MarkdownRenderer content={planContent} className="plan-review-markdown" />
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => onRespond(true)} style={allowBtn}>
            Approve
          </button>
          <button onClick={() => onRespond(false)} style={denyBtn}>
            Reject
          </button>
        </div>
      </div>
    );
  }

  return null;
}

/**
 * The chat's per-action computer-control gate.
 *
 * Exact equality, never a pattern. Matching here is trust-side: it grants the
 * computer-control header AND makes {@link formatInput} render only `summary` +
 * `action`, dropping every other input key. A looser match would let a
 * third-party MCP server exposing its own `cu_action` — the bare spelling the
 * cline/pi custom-tool bridges use — render as a Callboard GUI confirmation
 * with, say, its `command` field never shown. The backend raises exactly one
 * name; recognize exactly that one.
 */
function isComputerUseAction(toolName?: string): boolean {
  return toolName === CU_ACTION_TOOL_NAME;
}

function formatInput(toolName: string, input: Record<string, unknown>): string {
  // The backend already wrote this one for a human: what will happen, where.
  // The raw action follows so nothing is hidden behind the summary.
  if (isComputerUseAction(toolName) && typeof input.summary === "string") {
    return [String(input.summary), input.action ? JSON.stringify(input.action) : ""].filter(Boolean).join("\n\n");
  }
  if (toolName === "Bash" && input.command) return String(input.command);
  if (toolName === "Write" && input.file_path) return `Write to ${input.file_path}`;
  if (toolName === "Edit" && input.file_path) return `Edit ${input.file_path}`;
  if (toolName === "Read" && input.file_path) return `Read ${input.file_path}`;
  return JSON.stringify(input, null, 2).slice(0, 500);
}

function extractPlanFromContent(content: string | undefined): string {
  if (!content) return "(No plan content)";

  try {
    const parsed = JSON.parse(content);
    return parsed.plan || content;
  } catch {
    // If it's not valid JSON, return as-is
    return content;
  }
}

const panelStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderTop: "1px solid var(--border)",
  background: "var(--surface)",
  flexShrink: 0,
};

const questionPanelStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderTop: "1px solid var(--border)",
  background: "var(--surface)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  maxHeight: "60vh",
};

const questionScrollArea: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  minHeight: 0,
  marginBottom: 8,
  WebkitOverflowScrolling: "touch",
};

const preStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 13,
  overflow: "auto",
  maxHeight: 200,
  marginBottom: 10,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const allowBtn: React.CSSProperties = {
  background: "var(--accent)",
  color: "var(--text-on-accent)",
  padding: "8px 20px",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 500,
};

const denyBtn: React.CSSProperties = {
  background: "var(--danger-solid)",
  color: "var(--text-on-danger)",
  padding: "8px 20px",
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 500,
};

const optionBtn: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 14,
  marginBottom: 4,
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "8px 12px",
  fontSize: 14,
};

const planContainerStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "12px",
  marginBottom: 10,
  overflow: "auto",
  fontSize: 14,
  lineHeight: 1.5,
};

const expandToggleBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text-muted)",
  cursor: "pointer",
  padding: "2px 4px",
  borderRadius: 4,
  display: "flex",
  alignItems: "center",
};
