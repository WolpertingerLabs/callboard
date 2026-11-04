import { describe, expect, it } from "vitest";
import { extractRawAnswers, isAskUserQuestionTool, parseAskedQuestions, parseQuestionsOutcome, resolveAnswer, type AskedQuestion } from "./askUserQuestions";

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
  it.each(["AskUserQuestion", "mcp__claude__AskUserQuestion", "ask_user_question", "askUserQuestions"])("matches %s", (name) => {
    expect(isAskUserQuestionTool(name)).toBe(true);
  });
  it.each([undefined, "", "TodoWrite", "AskUserQuestionLater", "ask_question"])("rejects %s", (name) => {
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

describe("extractRawAnswers", () => {
  it("reads the 'Your questions have been answered' wording", () => {
    const text = `Your questions have been answered: "${AWS_Q}"="Implement SigV4 (Recommended)". You can now continue with these answers in mind.`;
    expect(extractRawAnswers([aws], text)).toEqual(["Implement SigV4 (Recommended)"]);
  });

  it("reads the 'The user answered' wording, with quotes inside the question", () => {
    const text = `The user answered: "${QUOTED_Q}"="nevermind I just saw you added an auto move". Read the answers carefully — they may request clarification, changes, or that you not proceed — and follow what they actually say.`;
    expect(extractRawAnswers([quoted], text)).toEqual(["nevermind I just saw you added an auto move"]);
  });

  it("splits several answers at the next known question", () => {
    const text = `The user answered: "${QUOTED_Q}"="Worktree", "Which features?"="Dark mode, Export, CSV". Read the answers carefully.`;
    expect(extractRawAnswers([quoted, features], text)).toEqual(["Worktree", "Dark mode, Export, CSV"]);
  });

  it('keeps quotes and ". " inside a free-text answer', () => {
    const text = `Your questions have been answered: "Which features?"="Use "sync". Then stop". You can now continue with these answers in mind.`;
    expect(extractRawAnswers([features], text)).toEqual(['Use "sync". Then stop']);
  });

  it("falls back to the last quote for unknown trailing wording", () => {
    expect(extractRawAnswers([features], `Answers: "Which features?"="Sync". Go.`)).toEqual(["Sync"]);
  });

  it("leaves an unanswered question null, and is null when nothing matches", () => {
    expect(extractRawAnswers([aws, features], `The user answered: "Which features?"="Sync". Read the answers carefully.`)).toEqual([null, "Sync"]);
    expect(extractRawAnswers([aws], "User denied")).toBeNull();
  });
});

describe("resolveAnswer", () => {
  it("matches a single-select label, or treats the text as Other", () => {
    expect(resolveAnswer(aws, "Implement SigV4 (Recommended)")).toEqual({ selected: ["Implement SigV4 (Recommended)"] });
    expect(resolveAnswer(aws, "do both")).toEqual({ selected: [], other: "do both" });
    expect(resolveAnswer(aws, "  ")).toBeNull();
  });

  it("rejoins multi-select labels that contain commas, and keeps the leftover as Other", () => {
    expect(resolveAnswer(features, "Dark mode, Export, CSV")).toEqual({ selected: ["Dark mode", "Export, CSV"] });
    expect(resolveAnswer(features, "Sync, also printing")).toEqual({ selected: ["Sync"], other: "also printing" });
  });
});

describe("parseQuestionsOutcome", () => {
  it("is pending with no result", () => {
    expect(parseQuestionsOutcome([aws], null)).toEqual({ status: "pending" });
  });

  it("is answered when any question has an answer", () => {
    const outcome = parseQuestionsOutcome([aws, features], { content: `The user answered: "Which features?"="Sync". Read the answers carefully.` });
    expect(outcome).toEqual({ status: "answered", answers: [null, { selected: ["Sync"] }] });
  });

  it("is declined for a denial or error, with the reason cleaned up", () => {
    expect(parseQuestionsOutcome([aws], { content: "User denied" })).toEqual({ status: "declined", reason: "User denied" });
    expect(parseQuestionsOutcome([aws], { content: "<tool_use_error>Interrupted</tool_use_error>" })).toEqual({ status: "declined", reason: "Interrupted" });
    expect(parseQuestionsOutcome([aws], { content: "" })).toEqual({ status: "declined", reason: undefined });
  });
});
