import { useState } from 'react';

export interface PendingAction {
  type: 'permission_request' | 'user_question' | 'plan_review';
  toolName?: string;
  input?: Record<string, unknown>;
  questions?: any[];
  suggestions?: any[];
  content?: string;
}

interface Props {
  action: PendingAction;
  onRespond: (allow: boolean, updatedInput?: Record<string, unknown>) => void;
}

export default function FeedbackPanel({ action, onRespond }: Props) {
  const [answers, setAnswers] = useState<Record<number, string | string[]>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});

  if (action.type === 'permission_request') {
    return (
      <div style={panelStyle}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
          Permission requested
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
          {action.toolName}
        </div>
        {action.input && (
          <pre style={preStyle}>
            {formatInput(action.toolName!, action.input)}
          </pre>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => onRespond(true)} style={allowBtn}>Allow</button>
          <button onClick={() => onRespond(false)} style={denyBtn}>Deny</button>
        </div>
      </div>
    );
  }

  if (action.type === 'user_question') {
    const questions = action.questions || [];
    return (
      <div style={panelStyle}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>
          Claude is asking
        </div>
        {questions.map((q: any, qi: number) => (
          <div key={qi} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{q.question}</div>
            {(q.options || []).map((opt: any, oi: number) => {
              const selected = q.multiSelect
                ? (answers[qi] as string[] || []).includes(opt.label)
                : answers[qi] === opt.label;
              return (
                <button
                  key={oi}
                  onClick={() => {
                    if (q.multiSelect) {
                      const cur = (answers[qi] as string[] || []);
                      setAnswers(prev => ({
                        ...prev,
                        [qi]: selected ? cur.filter(l => l !== opt.label) : [...cur, opt.label],
                      }));
                    } else {
                      setAnswers(prev => ({ ...prev, [qi]: opt.label }));
                    }
                  }}
                  style={{
                    ...optionBtn,
                    border: selected ? '2px solid var(--accent)' : '1px solid var(--border)',
                    background: selected ? 'var(--accent-light, rgba(99,102,241,0.1))' : 'var(--surface)',
                  }}
                >
                  <div style={{ fontWeight: 500 }}>{opt.label}</div>
                  {opt.description && (
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{opt.description}</div>
                  )}
                </button>
              );
            })}
            <input
              placeholder="Other..."
              value={otherText[qi] || ''}
              onChange={e => {
                setOtherText(prev => ({ ...prev, [qi]: e.target.value }));
                if (e.target.value) {
                  setAnswers(prev => ({ ...prev, [qi]: e.target.value }));
                }
              }}
              style={{ ...inputStyle, marginTop: 4 }}
            />
          </div>
        ))}
        <button
          onClick={() => {
            const formatted: Record<string, string | string[]> = {};
            questions.forEach((q: any, qi: number) => {
              if (answers[qi]) formatted[q.question] = answers[qi];
            });
            onRespond(true, { answers: formatted });
          }}
          style={allowBtn}
        >
          Submit
        </button>
      </div>
    );
  }

  if (action.type === 'plan_review') {
    return (
      <div style={panelStyle}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 4 }}>
          Plan review
        </div>
        <pre style={preStyle}>
          {action.content || '(No plan content)'}
        </pre>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => onRespond(true)} style={allowBtn}>Approve</button>
          <button onClick={() => onRespond(false)} style={denyBtn}>Reject</button>
        </div>
      </div>
    );
  }

  return null;
}

function formatInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && input.command) return String(input.command);
  if (toolName === 'Write' && input.file_path) return `Write to ${input.file_path}`;
  if (toolName === 'Edit' && input.file_path) return `Edit ${input.file_path}`;
  if (toolName === 'Read' && input.file_path) return `Read ${input.file_path}`;
  return JSON.stringify(input, null, 2).slice(0, 500);
}

const panelStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderTop: '1px solid var(--border)',
  background: 'var(--surface)',
  flexShrink: 0,
};

const preStyle: React.CSSProperties = {
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 13,
  overflow: 'auto',
  maxHeight: 200,
  marginBottom: 10,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const allowBtn: React.CSSProperties = {
  background: 'var(--accent)',
  color: '#fff',
  padding: '8px 20px',
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 500,
};

const denyBtn: React.CSSProperties = {
  background: 'var(--danger, #ef4444)',
  color: '#fff',
  padding: '8px 20px',
  borderRadius: 6,
  fontSize: 14,
  fontWeight: 500,
};

const optionBtn: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'left',
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 14,
  marginBottom: 4,
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 14,
};
