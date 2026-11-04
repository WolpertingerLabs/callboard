import type { ParsedMessage } from "../api";

/**
 * Reading an `AskUserQuestion` call back out of the transcript, for
 * QuestionsCard.
 *
 * The questions come from the tool input, which is structured. The answers do
 * not: ParsedMessage carries a tool result as the text the model saw, and the
 * CLI writes that as prose whose wording has changed between versions —
 *
 *   Your questions have been answered: "q1"="a1", "q2"="a2". You can now continue …
 *   The user answered: "q1"="a1". Read the answers carefully — …
 *
 * The JSONL does keep a structured `toolUseResult.answers` beside it, but it is
 * not on the wire, and the prose is the same on the live stream and on reload,
 * so the prose is what this reads. Question text can itself contain double
 * quotes, so no regex over `"…"="…"` can split it; instead each *known*
 * question is located as `"<question>"="`, and an answer runs from there to
 * where the next known question begins.
 */

export interface AskedOption {
  label: string;
  description?: string;
}

export interface AskedQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: AskedOption[];
}

export interface QuestionAnswer {
  /** Option labels the answer picked, in the order given. */
  selected: string[];
  /** Whatever part of the answer matched no option — a typed "Other" reply. */
  other?: string;
}

export type QuestionsOutcome =
  /** No result yet. */
  | { status: "pending" }
  /** One entry per question; null where that question went unanswered. */
  | { status: "answered"; answers: (QuestionAnswer | null)[] }
  /** A result that answered nothing: denied, interrupted, or an error. */
  | { status: "declined"; reason?: string };

/** `AskUserQuestion`, bare or behind any `server__` namespace. */
export function isAskUserQuestionTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const bare = toolName.split("__").pop() ?? toolName;
  return /^ask_?user_?questions?$/i.test(bare);
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * The questions an AskUserQuestion call asked, or null when the message is not
 * one. Matched by tool name and payload shape, so a same-named tool with some
 * other input falls through to the generic tool row.
 */
export function parseAskedQuestions(message: Pick<ParsedMessage, "type" | "toolName" | "content">): AskedQuestion[] | null {
  if (message.type !== "tool_use" || !isAskUserQuestionTool(message.toolName)) return null;
  let input: unknown;
  try {
    input = JSON.parse(message.content);
  } catch {
    return null;
  }
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskedQuestion[] = [];
  for (const q of raw) {
    const question = asText((q as { question?: unknown })?.question);
    if (!question) return null;
    const { header, multiSelect, options } = q as { header?: unknown; multiSelect?: unknown; options?: unknown };
    questions.push({
      question,
      header: asText(header),
      multiSelect: multiSelect === true,
      options: (Array.isArray(options) ? options : []).flatMap((o): AskedOption[] => {
        const label = asText((o as { label?: unknown })?.label);
        if (!label) return [];
        const description = asText((o as { description?: unknown }).description);
        return [description ? { label, description } : { label }];
      }),
    });
  }
  return questions;
}

/**
 * Prose the CLI appends after the last answer. Anchoring on it lets the last
 * answer contain `".` itself; the fallback, for wording not listed here, is
 * the last quote in the text.
 */
const ANSWER_SUFFIXES = ['". You can now continue', '". Read the answers carefully'];

/**
 * Each question's raw answer string, or null where the result text names no
 * answer for it. Null overall when it names none at all.
 */
export function extractRawAnswers(questions: AskedQuestion[], result: string): (string | null)[] | null {
  const found: { qi: number; start: number; end: number }[] = [];
  let cursor = 0;
  questions.forEach((q, qi) => {
    const marker = `"${q.question}"="`;
    // Answers are written in question order, so searching on from the last
    // hit keeps a question quoted inside an earlier answer from matching.
    let at = result.indexOf(marker, cursor);
    if (at === -1) at = result.indexOf(marker);
    if (at === -1 || found.some((f) => f.start === at)) return;
    found.push({ qi, start: at, end: at + marker.length });
    cursor = at + marker.length;
  });
  if (found.length === 0) return null;
  found.sort((a, b) => a.start - b.start);

  const answers: (string | null)[] = questions.map(() => null);
  found.forEach((f, i) => {
    const next = found[i + 1];
    let value: string;
    if (next) {
      value = result.slice(f.end, next.start).replace(/"\s*,\s*$/, "");
    } else {
      const tail = result.slice(f.end);
      const suffixAt = ANSWER_SUFFIXES.map((s) => tail.indexOf(s)).find((at) => at !== -1);
      const close = suffixAt ?? tail.lastIndexOf('"');
      value = close === -1 ? tail : tail.slice(0, close);
    }
    answers[f.qi] = value;
  });
  return answers;
}

/**
 * Split a raw answer into the options it picked and any free text. A
 * multi-select answer is labels joined with ", " — but a label can contain a
 * comma, so the pieces are rejoined greedily, longest run first, against the
 * real labels.
 */
export function resolveAnswer(question: AskedQuestion, raw: string): QuestionAnswer | null {
  const text = raw.trim();
  if (!text) return null;
  const byLabel = new Map(question.options.map((o) => [o.label.trim().toLowerCase(), o.label]));
  const exact = byLabel.get(text.toLowerCase());
  if (exact) return { selected: [exact] };
  if (!question.multiSelect) return { selected: [], other: text };

  const parts = text.split(", ");
  const selected: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < parts.length; ) {
    let matched = 0;
    for (let j = parts.length; j > i; j--) {
      const label = byLabel.get(parts.slice(i, j).join(", ").trim().toLowerCase());
      if (label) {
        if (!selected.includes(label)) selected.push(label);
        matched = j - i;
        break;
      }
    }
    if (matched) i += matched;
    else rest.push(parts[i++]);
  }
  const other = rest.join(", ").trim();
  return other ? { selected, other } : { selected };
}

/** Strip the wrapper the SDK puts around a tool error. */
function declineReason(result: string): string | undefined {
  const text = result
    .replace(/<\/?tool_use_error>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

export function parseQuestionsOutcome(questions: AskedQuestion[], toolResult: Pick<ParsedMessage, "content"> | null): QuestionsOutcome {
  if (!toolResult) return { status: "pending" };
  const raw = extractRawAnswers(questions, toolResult.content ?? "");
  const answers = raw ? questions.map((q, qi) => (raw[qi] === null ? null : resolveAnswer(q, raw[qi]!))) : null;
  if (!answers || answers.every((a) => a === null)) return { status: "declined", reason: declineReason(toolResult.content ?? "") };
  return { status: "answered", answers };
}
