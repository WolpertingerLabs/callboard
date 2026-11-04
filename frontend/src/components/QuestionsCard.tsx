import { memo, useMemo, type CSSProperties } from "react";
import { Check, Circle, MessageCircleQuestion, Square } from "lucide-react";
import type { ParsedMessage } from "../api";
import { MessageMetadata } from "./MessageBubble";
import { parseQuestionsOutcome, type AskedQuestion, type QuestionAnswer, type QuestionsOutcome } from "./askUserQuestions";

interface Props {
  questions: AskedQuestion[];
  toolUse: ParsedMessage;
  toolResult: ParsedMessage | null;
  isRunning: boolean;
}

/** Read by screen readers, invisible on screen. */
const visuallyHidden: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

/**
 * An `AskUserQuestion` call as it reads in the transcript: what was asked,
 * what was offered, and what came back — so the point in a chat where a
 * decision was made can be found again by eye. The live prompt itself is
 * FeedbackPanel; this is the record left behind.
 */
function QuestionsCard({ questions, toolUse, toolResult, isRunning }: Props) {
  const outcome = useMemo(() => parseQuestionsOutcome(questions, toolResult), [questions, toolResult]);
  const count = questions.length;
  const answers = "answers" in outcome ? outcome.answers : null;
  // "No answer" under a question only means something beside one that *was*
  // answered; a result that answered none says so once, below.
  const partial = answers?.some((a) => a !== null) ?? false;
  const footer = outcome.status === "declined" || outcome.status === "timed_out" ? outcome.reason : undefined;
  const response = "response" in outcome ? outcome.response : undefined;

  return (
    <div style={{ margin: "4px 0" }}>
      <div
        data-testid="questions-card"
        style={{
          margin: "2px 0",
          border: "1px solid var(--border)",
          borderRadius: 10,
          overflow: "hidden",
          background: "var(--assistant-bg)",
          maxWidth: "min(100%, 680px)",
          minWidth: 0,
          overflowWrap: "anywhere",
        }}
      >
        <div
          style={{
            padding: "9px 14px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <MessageCircleQuestion size={15} style={{ flexShrink: 0, color: "var(--accent-text)" }} />
          <span style={{ fontWeight: 600, fontSize: 14, flex: 1, minWidth: 0 }}>
            Asked {count} question{count === 1 ? "" : "s"}
          </span>
          <StatusLabel outcome={outcome} isRunning={isRunning} />
        </div>

        {questions.map((q, qi) => (
          <QuestionBlock key={qi} question={q} first={qi === 0} answer={answers?.[qi] ?? null} showMissing={partial} />
        ))}

        {response && (
          <div style={{ padding: "0 14px 10px" }}>
            <QuoteBlock label={outcome.status === "follow_up" ? "They also wrote" : "Your response"} text={response} />
          </div>
        )}

        {footer && (
          <div
            data-testid="questions-card-footer"
            style={{
              padding: "8px 14px",
              borderTop: "1px solid var(--border)",
              fontSize: 12,
              color: "var(--text-muted)",
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
            title={footer}
          >
            {footer}
          </div>
        )}
      </div>

      <MessageMetadata message={toolResult || toolUse} align="left" />
    </div>
  );
}

function StatusLabel({ outcome, isRunning }: { outcome: QuestionsOutcome; isRunning: boolean }) {
  let text: string;
  let color = "var(--text-muted)";
  switch (outcome.status) {
    case "answered":
      text = "Answered";
      color = "var(--success)";
      break;
    case "follow_up":
      text = "Asked for more questions";
      color = "var(--accent-text)";
      break;
    case "timed_out":
      text = "Timed out";
      color = "var(--warning)";
      break;
    case "declined":
      text = "Not answered";
      color = "var(--warning)";
      break;
    default:
      // No result and not running: the turn ended (interrupt, crash) before
      // the question was answered, and nothing will answer it now.
      text = isRunning ? "Waiting for your answer" : "No answer recorded";
  }
  return <span style={{ flexShrink: 0, fontSize: 12, color, fontStyle: outcome.status === "pending" ? "italic" : undefined }}>{text}</span>;
}

function QuoteBlock({ label, text, quoted = true }: { label: string; text: string; quoted?: boolean }) {
  return (
    <div
      style={{
        marginTop: 7,
        padding: "5px 10px",
        borderLeft: "2px solid var(--accent)",
        background: "var(--accent-bg)",
        borderRadius: "0 6px 6px 0",
        fontSize: 13,
        lineHeight: 1.45,
      }}
    >
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 1 }}>{label}</div>
      <div style={{ whiteSpace: "pre-wrap" }}>{quoted ? `“${text}”` : text}</div>
    </div>
  );
}

function QuestionBlock({ question, first, answer, showMissing }: { question: AskedQuestion; first: boolean; answer: QuestionAnswer | null; showMissing: boolean }) {
  const chosen = new Set(answer?.selected ?? []);
  // Once this question is answered, what wasn't chosen recedes; before that
  // every option is still live and reads at full weight.
  const decided = chosen.size > 0 || !!answer?.other;
  return (
    <div style={{ padding: "10px 14px", borderTop: first ? undefined : "1px solid var(--border)" }}>
      {(question.header || question.multiSelect) && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 5 }}>
          {question.header && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "1px 7px",
                borderRadius: 999,
                background: "var(--accent-bg)",
                color: "var(--accent-text)",
              }}
            >
              {question.header}
            </span>
          )}
          {question.multiSelect && <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Select any</span>}
        </div>
      )}
      <div style={{ fontSize: 13.5, fontWeight: 500, lineHeight: 1.45, whiteSpace: "pre-wrap" }}>{question.question}</div>

      {question.options.length > 0 && (
        <ul style={{ listStyle: "none", margin: "7px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          {question.options.map((opt, oi) => {
            const picked = chosen.has(opt.label);
            const Marker = picked ? Check : question.multiSelect ? Square : Circle;
            return (
              <li
                key={oi}
                data-chosen={picked || undefined}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "4px 8px",
                  borderRadius: 6,
                  background: picked ? "var(--accent-bg)" : undefined,
                }}
              >
                <Marker
                  size={picked ? 14 : 12}
                  strokeWidth={picked ? 2.5 : 2}
                  style={{ flexShrink: 0, marginTop: picked ? 2 : 3, color: picked ? "var(--accent-text)" : "var(--text-muted)" }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    data-testid="question-option-label"
                    style={{
                      fontSize: 13,
                      lineHeight: 1.4,
                      fontWeight: picked ? 600 : 400,
                      // Receding is a colour step, not opacity: --text-muted is
                      // already the faintest ink that passes contrast.
                      color: picked ? "var(--accent-text)" : decided ? "var(--text-muted)" : undefined,
                    }}
                  >
                    {opt.label}
                    {picked && <span style={visuallyHidden}> (chosen)</span>}
                  </div>
                  {opt.description && (
                    <div
                      title={opt.description}
                      style={{
                        fontSize: 12,
                        lineHeight: 1.4,
                        color: "var(--text-muted)",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {opt.description}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {answer?.other && <QuoteBlock label="Your answer" text={answer.other} />}
      {answer?.notes && <QuoteBlock label="Your note" text={answer.notes} quoted={false} />}

      {showMissing && !answer && <div style={{ marginTop: 6, fontSize: 12, fontStyle: "italic", color: "var(--text-muted)" }}>No answer</div>}
    </div>
  );
}

export default memo(QuestionsCard);
