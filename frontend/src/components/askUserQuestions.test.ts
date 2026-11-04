import { describe, expect, it } from "vitest";
import {
  extractRawAnswers,
  isAskUserQuestionTool,
  parseAskedQuestions,
  parseQuestionsOutcome,
  resolveAnswer,
  tokenizeMultiSelect,
  type AskedQuestion,
} from "./askUserQuestions";

const AWS_Q =
  "AWS APIs need every request signed with SigV4 (computed from access key + secret per request), which drawlatch doesn't support today — templates only inject static headers. How should I handle AWS?";
// From a real transcript: the question text carries its own double quotes.
const QUOTED_Q = 'By "workspace", do you mean a Space (Work/Personal…) or the chat\'s working folder/worktree?';

const aws: AskedQuestion = {
  question: AWS_Q,
  header: "AWS auth",
  multiSelect: false,
  options: [{ label: "Implement SigV4 (Recommended)", description: "Sign requests" }, { label: "Separate PRs" }],
};
const quoted: AskedQuestion = {
  question: QUOTED_Q,
  header: "Which move?",
  multiSelect: false,
  options: [{ label: "Space, from the chat (Recommended)" }, { label: "Worktree" }],
};
const features: AskedQuestion = {
  question: "Which features?",
  multiSelect: true,
  options: [{ label: "Dark mode" }, { label: "Export, CSV" }, { label: "Sync" }],
};

function toolUse(toolName: string, input: unknown) {
  return { type: "tool_use" as const, toolName, content: JSON.stringify(input) };
}

describe("isAskUserQuestionTool", () => {
  it.each(["AskUserQuestion", "mcp__claude__AskUserQuestion", "x__AskUserQuestion"])("matches %s", (name) => {
    expect(isAskUserQuestionTool(name)).toBe(true);
  });
  it.each([undefined, "", "TodoWrite", "AskUserQuestionLater", "ask_question", "ask_user_question", "askUserQuestions"])("rejects %s", (name) => {
    expect(isAskUserQuestionTool(name)).toBe(false);
  });
});

describe("parseAskedQuestions", () => {
  it("reads the real tool input shape", () => {
    const parsed = parseAskedQuestions(
      toolUse("AskUserQuestion", {
        questions: [
          {
            question: AWS_Q,
            header: "AWS auth",
            multiSelect: false,
            options: [{ label: "Implement SigV4 (Recommended)", description: "Sign requests" }, { label: "Separate PRs", description: "" }],
          },
        ],
      }),
    );
    expect(parsed).toEqual([aws]);
  });

  it("requires a questions array, so a same-named tool with other input falls through", () => {
    expect(parseAskedQuestions(toolUse("AskUserQuestion", { question: "x" }))).toBeNull();
    expect(parseAskedQuestions(toolUse("AskUserQuestion", { questions: [] }))).toBeNull();
    expect(parseAskedQuestions(toolUse("AskUserQuestion", { questions: [{ header: "no text" }] }))).toBeNull();
    expect(parseAskedQuestions({ type: "tool_use", toolName: "AskUserQuestion", content: "not json" })).toBeNull();
  });

  it("requires the tool name and a tool_use", () => {
    expect(parseAskedQuestions(toolUse("Other", { questions: [{ question: "q" }] }))).toBeNull();
    expect(parseAskedQuestions({ type: "tool_result", toolName: "AskUserQuestion", content: JSON.stringify({ questions: [{ question: "q" }] }) })).toBeNull();
  });

  it("tolerates missing options and drops label-less ones", () => {
    expect(parseAskedQuestions(toolUse("AskUserQuestion", { questions: [{ question: "Free?", options: [{ description: "no label" }] }] }))).toEqual([
      { question: "Free?", header: undefined, multiSelect: false, options: [] },
    ]);
  });
});

const v = (value: string | null, notes?: string) => (notes ? { value, notes } : { value });

describe("extractRawAnswers", () => {
  it("reads the 'Your questions have been answered' list", () => {
    expect(extractRawAnswers([aws], `"${AWS_Q}"="Implement SigV4 (Recommended)"`)).toEqual([v("Implement SigV4 (Recommended)")]);
  });

  it("finds a question with quotes inside it", () => {
    expect(extractRawAnswers([quoted], `"${QUOTED_Q}"="nevermind I just saw you added an auto move"`)).toEqual([v("nevermind I just saw you added an auto move")]);
  });

  it("splits several entries at the next known question", () => {
    expect(extractRawAnswers([quoted, features], `"${QUOTED_Q}"="Worktree", "Which features?"="Dark mode, Export, CSV"`)).toEqual([
      v("Worktree"),
      v("Dark mode, Export, CSV"),
    ]);
  });

  it("keeps quotes inside a free-text answer", () => {
    expect(extractRawAnswers([features], `"Which features?"="Use "sync". Then stop"`)).toEqual([v('Use "sync". Then stop')]);
  });

  it("separates notes from the answer, on any entry", () => {
    expect(extractRawAnswers([quoted, features], `"${QUOTED_Q}"="Worktree" notes: only if clean, "Which features?"="Sync" notes: "soon"`)).toEqual([
      v("Worktree", "only if clean"),
      v("Sync", '"soon"'),
    ]);
  });

  it("drops a selected preview but keeps the notes after it", () => {
    expect(extractRawAnswers([aws], `"${AWS_Q}"="Separate PRs" selected preview:\n<div>a notes: b</div> notes: fine`)).toEqual([v("Separate PRs", "fine")]);
    expect(extractRawAnswers([aws], `"${AWS_Q}"="Separate PRs" selected preview:\n<div>x</div>`)).toEqual([v("Separate PRs")]);
  });

  it("reads (no option selected) with its notes", () => {
    expect(extractRawAnswers([aws, features], `"${AWS_Q}"=(no option selected) notes: ask me later, "Which features?"="Sync"`)).toEqual([
      v(null, "ask me later"),
      v("Sync"),
    ]);
  });

  it("falls back to the last quote when handed trailing prose", () => {
    expect(extractRawAnswers([features], `Answers: "Which features?"="Sync". Go.`)).toEqual([v("Sync")]);
  });

  it("leaves an unanswered question null, and is null when nothing matches", () => {
    expect(extractRawAnswers([aws, features], `"Which features?"="Sync"`)).toEqual([null, v("Sync")]);
    expect(extractRawAnswers([aws], "User denied")).toBeNull();
  });
});

describe("tokenizeMultiSelect", () => {
  it("splits the CLI's quoted join", () => {
    expect(tokenizeMultiSelect('Dark mode, "Export, CSV", "say \\"hi\\""')).toEqual(["Dark mode", "Export, CSV", 'say "hi"']);
  });
  it("is null for text not in that form", () => {
    expect(tokenizeMultiSelect('a "b" c')).toBeNull();
    expect(tokenizeMultiSelect('"unterminated')).toBeNull();
  });
});

describe("resolveAnswer", () => {
  it("matches a single-select label, or treats the text as Other", () => {
    expect(resolveAnswer(aws, v("Implement SigV4 (Recommended)"))).toEqual({ selected: ["Implement SigV4 (Recommended)"] });
    expect(resolveAnswer(aws, v("do both"))).toEqual({ selected: [], other: "do both" });
    expect(resolveAnswer(aws, v("  "))).toBeNull();
  });

  it("reads the native CLI's JSON-quoted multi-select labels", () => {
    expect(resolveAnswer(features, v('Dark mode, "Export, CSV"'))).toEqual({ selected: ["Dark mode", "Export, CSV"] });
  });

  it("rejoins unquoted multi-select labels that contain commas, and keeps the leftover as Other", () => {
    expect(resolveAnswer(features, v("Dark mode, Export, CSV"))).toEqual({ selected: ["Dark mode", "Export, CSV"] });
    expect(resolveAnswer(features, v("Sync, also printing"))).toEqual({ selected: ["Sync"], other: "also printing" });
  });

  it("carries notes, including on no selection", () => {
    expect(resolveAnswer(aws, v("Separate PRs", "later"))).toEqual({ selected: ["Separate PRs"], notes: "later" });
    expect(resolveAnswer(aws, v(null, "later"))).toEqual({ selected: [], notes: "later" });
    expect(resolveAnswer(aws, v(null))).toBeNull();
  });
});

describe("parseQuestionsOutcome", () => {
  it("is pending with no result", () => {
    expect(parseQuestionsOutcome([aws], null)).toEqual({ status: "pending" });
  });

  it("reads the 'Your questions have been answered' wording", () => {
    const content = `Your questions have been answered: "${AWS_Q}"="Implement SigV4 (Recommended)". You can now continue with these answers in mind.`;
    expect(parseQuestionsOutcome([aws], { content })).toEqual({ status: "answered", answers: [{ selected: ["Implement SigV4 (Recommended)"] }] });
  });

  it("reads 'The user answered' with notes on the last entry", () => {
    const content = `The user answered: "${QUOTED_Q}"="nevermind" notes: I saw the auto move. Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`;
    expect(parseQuestionsOutcome([quoted], { content })).toEqual({
      status: "answered",
      answers: [{ selected: [], other: "nevermind", notes: "I saw the auto move" }],
    });
  });

  it("does not cut an answer short at a suffix phrase it contains", () => {
    const content = `Your questions have been answered: "Which features?"="x". You can now continue later". You can now continue with these answers in mind.`;
    expect(parseQuestionsOutcome([features], { content })).toEqual({ status: "answered", answers: [{ selected: [], other: 'x". You can now continue later' }] });
  });

  it("is answered when any question has an answer", () => {
    const outcome = parseQuestionsOutcome([aws, features], { content: `The user answered: "Which features?"="Sync". Read the answers carefully.` });
    expect(outcome).toEqual({ status: "answered", answers: [null, { selected: ["Sync"] }] });
  });

  it("treats 'The user responded' as a free-text answer", () => {
    expect(parseQuestionsOutcome([aws, features], { content: "The user responded: just do whatever is simplest" })).toEqual({
      status: "answered",
      answers: [null, null],
      response: "just do whatever is simplest",
    });
  });

  it("reads a follow-up request, with partial answers and what they also wrote", () => {
    const content = `The user asked for more questions before you proceed. So far they answered: "Which features?"="Sync". They also wrote: "what about "auth"?". Call AskUserQuestion again with follow-up questions that build on these answers (do not repeat these); do not start the task yet.`;
    expect(parseQuestionsOutcome([aws, features], { content })).toEqual({ status: "follow_up", answers: [null, { selected: ["Sync"] }], response: 'what about "auth"?' });
  });

  it("reads a follow-up request with nothing answered", () => {
    const content = `The user asked for more questions before answering. Call AskUserQuestion again now with further questions about this decision (do not repeat these); do not proceed with the task yet.`;
    expect(parseQuestionsOutcome([aws], { content })).toEqual({ status: "follow_up", answers: [null] });
  });

  it("reads an AFK timeout, with and without a partial selection", () => {
    const afk = "No response after 300s — the user may be away from keyboard. Proceed using your best judgment based on the context so far; you can re-ask this question later if it's still relevant.";
    expect(parseQuestionsOutcome([aws, features], { content: `${afk}\nBefore going idle the user had selected: "Which features?"="Sync".` })).toEqual({
      status: "timed_out",
      answers: [null, { selected: ["Sync"] }],
      reason: "No response after 300s — continued with the selection so far",
    });
    expect(parseQuestionsOutcome([aws], { content: afk })).toEqual({ status: "timed_out", answers: [null], reason: "No response after 300s — continued without an answer" });
  });

  it("is declined for a denial, an error, or no answers", () => {
    expect(parseQuestionsOutcome([aws], { content: "User denied" })).toEqual({ status: "declined", reason: "User denied" });
    expect(parseQuestionsOutcome([aws], { content: "The user did not answer the questions." })).toEqual({
      status: "declined",
      reason: "The user did not answer the questions.",
    });
    expect(parseQuestionsOutcome([aws], { content: "<tool_use_error>Interrupted</tool_use_error>" })).toEqual({ status: "declined", reason: "Interrupted" });
    expect(parseQuestionsOutcome([aws], { content: "" })).toEqual({ status: "declined", reason: undefined });
  });
});
