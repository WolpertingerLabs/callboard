import type { ParsedMessage } from "../api";

/**
 * Reading an `AskUserQuestion` call back out of the transcript, for
 * QuestionsCard.
 *
 * The questions come from the tool input, which is structured. The answers do
 * not: ParsedMessage carries a tool result as the text the model saw, which the
 * CLI writes as prose (`mapToolResultToToolResultBlockParam` in the bundled
 * binary, 2.1.306). Each answered question is one entry, entries joined ", ":
 *
 *   "<question>"="<answer>"[ selected preview:\n<preview>][ notes: <notes>]
 *   "<question>"=(no option selected) notes: <notes>
 *
 * and the list sits inside one of several sentences —
 *
 *   Your questions have been answered: <list>. You can now continue …
 *   The user answered: <list>. Read the answers carefully — …
 *   The user responded: <free text>
 *   The user asked for more questions before you proceed. So far they answered: <list>.[ They also wrote: "<text>".] Call AskUserQuestion again …
 *   No response after <N>s — …[\nBefore going idle the user had selected: <list>.]
 *   The user did not answer the questions.
 *
 * The JSONL does keep a structured `toolUseResult.answers` beside it, but it is
 * not on the wire, and the prose is the same on the live stream and on reload,
 * so the prose is what this reads. Nothing in an entry is escaped, so question
 * text can itself contain double quotes and no regex over `"…"="…"` can split
 * it; instead each *known* question is located as `"<question>"=`, and an
 * entry runs from there to where the next known question begins.
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
  /** Notes the user attached to the question, with or without a selection. */
  notes?: string;
}

/** One question's entry in the result list, before matching against options. */
export interface RawAnswer {
  /** The answer string, or null for `=(no option selected)`. */
  value: string | null;
  notes?: string;
}

type Answers = (QuestionAnswer | null)[];

export type QuestionsOutcome =
  /** No result yet. */
  | { status: "pending" }
  /** One entry per question; null where that question went unanswered. `response` is free text given instead of (or beside) the answers. */
  | { status: "answered"; answers: Answers; response?: string }
  /** The user asked for another round instead of finishing this one. */
  | { status: "follow_up"; answers: Answers; response?: string }
  /** The dialog gave up waiting; `answers` is whatever was selected before it did. */
  | { status: "timed_out"; answers: Answers; reason: string }
  /** A result that answered nothing: denied, interrupted, or an error. */
  | { status: "declined"; reason?: string };

/** `AskUserQuestion`, bare or behind a `server__` namespace. */
export function isAskUserQuestionTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return toolName.split("__").pop() === "AskUserQuestion";
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

const NO_SELECTION = "(no option selected)";
const PREVIEW_MARK = " selected preview:";
const NOTES_MARK = " notes: ";

/** Split one entry's text — everything after `"<question>"=` — into answer and notes. */
function parseEntry(entry: string): RawAnswer {
  let value: string | null;
  let rest: string;
  if (entry.startsWith(NO_SELECTION)) {
    value = null;
    rest = entry.slice(NO_SELECTION.length);
  } else if (entry.startsWith('"')) {
    // The answer closes at the quote that the preview or notes follow, or at
    // the entry's last quote when neither does.
    const body = entry.slice(1);
    const marks = [`"${PREVIEW_MARK}`, `"${NOTES_MARK}`].map((m) => body.indexOf(m)).filter((at) => at !== -1);
    const close = marks.length > 0 ? Math.min(...marks) : body.lastIndexOf('"');
    value = close === -1 ? body : body.slice(0, close);
    rest = close === -1 ? "" : body.slice(close + 1);
  } else {
    return { value: entry };
  }
  // A preview is free-form markup that could say " notes: " itself; notes,
  // which come after it, are the more likely place for the last occurrence.
  const notesAt = rest.startsWith(PREVIEW_MARK) ? rest.lastIndexOf(NOTES_MARK) : rest.indexOf(NOTES_MARK);
  const notes = notesAt === -1 ? undefined : rest.slice(notesAt + NOTES_MARK.length).trim() || undefined;
  return notes ? { value, notes } : { value };
}

/**
 * Each question's entry in an answer list, or null where the list has none
 * for it. Null overall when it names no question at all.
 *
 * `list` should be the list alone; a caller that cannot isolate it can pass
 * more, and the last entry then ends at its last quote.
 */
export function extractRawAnswers(questions: AskedQuestion[], list: string): (RawAnswer | null)[] | null {
  const found: { qi: number; start: number; end: number }[] = [];
  let cursor = 0;
  questions.forEach((q, qi) => {
    const marker = `"${q.question}"=`;
    // Entries are written in question order, so searching on from the last
    // hit keeps a question quoted inside an earlier answer from matching.
    let at = list.indexOf(marker, cursor);
    if (at === -1) at = list.indexOf(marker);
    if (at === -1 || found.some((f) => f.start === at)) return;
    found.push({ qi, start: at, end: at + marker.length });
    cursor = at + marker.length;
  });
  if (found.length === 0) return null;
  found.sort((a, b) => a.start - b.start);

  const answers: (RawAnswer | null)[] = questions.map(() => null);
  found.forEach((f, i) => {
    const next = found[i + 1];
    const entry = next ? list.slice(f.end, next.start).replace(/,\s*$/, "") : list.slice(f.end);
    answers[f.qi] = parseEntry(entry);
  });
  return answers;
}

/**
 * The CLI's own multi-select split: labels joined ", ", with any label that
 * contains ", " or `"` written as a JSON string. Null when the text is not in
 * that form.
 */
export function tokenizeMultiSelect(text: string): string[] | null {
  const tokens: string[] = [];
  let rest = text;
  for (;;) {
    if (rest.startsWith('"')) {
      let close = -1;
      for (let i = 1, escaped = false; i < rest.length; i++) {
        if (escaped) escaped = false;
        else if (rest[i] === "\\") escaped = true;
        else if (rest[i] === '"') {
          close = i;
          break;
        }
      }
      if (close === -1) return null;
      try {
        tokens.push(JSON.parse(rest.slice(0, close + 1)) as string);
      } catch {
        return null;
      }
      rest = rest.slice(close + 1);
    } else {
      const comma = rest.indexOf(", ");
      const token = comma === -1 ? rest : rest.slice(0, comma);
      if (token.includes('"')) return null;
      tokens.push(token);
      rest = comma === -1 ? "" : rest.slice(comma);
    }
    if (rest === "") return tokens;
    if (!rest.startsWith(", ")) return null;
    rest = rest.slice(2);
  }
}

/**
 * Split a raw answer into the options it picked and any free text. A
 * multi-select answer is tokenized the way the CLI joins it; pieces are then
 * rejoined greedily, longest run first, against the real labels — callboard's
 * own answer panel joins labels with ", " unquoted, so a label containing a
 * comma arrives in several pieces.
 */
export function resolveAnswer(question: AskedQuestion, raw: RawAnswer): QuestionAnswer | null {
  const notes = raw.notes;
  const text = raw.value?.trim() ?? "";
  if (!text) return notes ? { selected: [], notes } : null;
  const withNotes = (a: QuestionAnswer): QuestionAnswer => (notes ? { ...a, notes } : a);

  const byLabel = new Map(question.options.map((o) => [o.label.trim().toLowerCase(), o.label]));
  const exact = byLabel.get(text.toLowerCase());
  if (exact) return withNotes({ selected: [exact] });
  if (!question.multiSelect) return withNotes({ selected: [], other: text });

  const parts = tokenizeMultiSelect(text) ?? text.split(", ");
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
  return withNotes(other ? { selected, other } : { selected });
}

function resolveAll(questions: AskedQuestion[], list: string): Answers | null {
  const raw = extractRawAnswers(questions, list);
  if (!raw) return null;
  const answers = questions.map((q, qi) => (raw[qi] ? resolveAnswer(q, raw[qi]!) : null));
  return answers.some((a) => a !== null) ? answers : null;
}

/**
 * The answer list out of the result sentence. Anchored on the *last*
 * occurrence of each closing phrase, so an answer that happens to contain one
 * is not cut short.
 */
function answerList(text: string, closers: string[]): string {
  const ends = closers.map((c) => text.lastIndexOf(c)).filter((at) => at !== -1);
  return ends.length > 0 ? text.slice(0, Math.max(...ends)) : text;
}

const FOLLOW_UP = "The user asked for more questions";
const SO_FAR = "So far they answered: ";
const ALSO_WROTE = '. They also wrote: "';
const CALL_AGAIN = ". Call ";
const IDLE = "Before going idle the user had selected: ";
const RESPONDED = "The user responded: ";

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
  const text = toolResult.content ?? "";
  const none = (): Answers => questions.map(() => null);

  const timeout = /^No response after (\d+)s/.exec(text);
  if (timeout) {
    const idleAt = text.indexOf(IDLE);
    const answers = idleAt === -1 ? null : resolveAll(questions, text.slice(idleAt + IDLE.length).replace(/\.\s*$/, ""));
    const reason = `No response after ${timeout[1]}s — ${answers ? "continued with the selection so far" : "continued without an answer"}`;
    return { status: "timed_out", answers: answers ?? none(), reason };
  }

  if (text.startsWith(FOLLOW_UP)) {
    const callAt = text.lastIndexOf(CALL_AGAIN);
    const head = callAt === -1 ? text : text.slice(0, callAt + 1);
    const wroteAt = head.lastIndexOf(ALSO_WROTE);
    const response = wroteAt === -1 ? undefined : head.slice(wroteAt + ALSO_WROTE.length).replace(/"\.$/, "").trim() || undefined;
    const soFarAt = text.indexOf(SO_FAR);
    const list = soFarAt === -1 ? "" : (wroteAt === -1 ? head : head.slice(0, wroteAt + 1)).slice(soFarAt + SO_FAR.length).replace(/\.$/, "");
    const answers = (list && resolveAll(questions, list)) || none();
    return response ? { status: "follow_up", answers, response } : { status: "follow_up", answers };
  }

  if (text.startsWith(RESPONDED)) {
    const response = text.slice(RESPONDED.length).trim();
    if (response) return { status: "answered", answers: none(), response };
  }

  const answers = resolveAll(questions, answerList(text, [". You can now continue", ". Read the answers carefully"]));
  if (!answers) return { status: "declined", reason: declineReason(text) };
  return { status: "answered", answers };
}
