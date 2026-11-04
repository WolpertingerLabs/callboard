// @vitest-environment jsdom
/**
 * AskUserQuestion renders as a questions card rather than a generic tool row,
 * through ToolCallBubble — the same entry point the transcript uses.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import ToolCallBubble from "./ToolCallBubble";
import type { ParsedMessage } from "../api";

afterEach(cleanup);

const QUESTIONS = [
  {
    question: "How should I handle AWS?",
    header: "AWS auth",
    multiSelect: false,
    options: [
      { label: "Implement SigV4 (Recommended)", description: "Sign each request." },
      { label: "Separate PRs", description: "Ship the rest first." },
    ],
  },
  {
    question: "Which features?",
    header: "Scope",
    multiSelect: true,
    options: [{ label: "Dark mode" }, { label: "Sync" }, { label: "Export" }],
  },
];

function toolUse(toolName = "AskUserQuestion"): ParsedMessage {
  return { role: "assistant", type: "tool_use", toolName, content: JSON.stringify({ questions: QUESTIONS }), toolUseId: "q-1" };
}

function result(content: string): ParsedMessage {
  return { role: "assistant", type: "tool_result", content, toolName: "q-1", toolUseId: "q-1" };
}

/** The visible label of each chosen option (minus the screen-reader suffix). */
function chosenLabels(): string[] {
  return Array.from(document.querySelectorAll('[data-chosen] [data-testid="question-option-label"]')).map((el) => el.firstChild?.textContent ?? "");
}

describe("QuestionsCard", () => {
  it("shows every question, its header chip, and the options while waiting", () => {
    render(<ToolCallBubble toolUse={toolUse()} toolResult={null} isRunning />);
    const card = screen.getByTestId("questions-card");
    expect(within(card).getByText("Asked 2 questions")).toBeTruthy();
    expect(within(card).getByText("Waiting for your answer")).toBeTruthy();
    expect(within(card).getByText("AWS auth")).toBeTruthy();
    expect(within(card).getByText("How should I handle AWS?")).toBeTruthy();
    expect(within(card).getByText("Separate PRs")).toBeTruthy();
    expect(within(card).getByText("Sign each request.")).toBeTruthy();
    expect(chosenLabels()).toEqual([]);
  });

  it("highlights chosen options and quotes a free-text answer", () => {
    const text =
      'The user answered: "How should I handle AWS?"="Implement SigV4 (Recommended)", "Which features?"="Dark mode, Export, and a CLI". Read the answers carefully.';
    render(<ToolCallBubble toolUse={toolUse("mcp__x__AskUserQuestion")} toolResult={result(text)} isRunning={false} />);
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(chosenLabels()).toEqual(["Implement SigV4 (Recommended)", "Dark mode", "Export"]);
    // The description stays in the accessible text; "(chosen)" is appended for screen readers only.
    const chosen = document.querySelector("[data-chosen]")!;
    expect(chosen.textContent).toBe("Implement SigV4 (Recommended) (chosen)Sign each request.");
    expect(chosen.getAttribute("aria-label")).toBeNull();
    expect(screen.getByText("“and a CLI”")).toBeTruthy();
  });

  it("marks a question the result skipped as unanswered", () => {
    render(<ToolCallBubble toolUse={toolUse()} toolResult={result('The user answered: "Which features?"="Sync". Read.')} isRunning={false} />);
    expect(screen.getByText("No answer")).toBeTruthy();
    expect(chosenLabels()).toEqual(["Sync"]);
  });

  it("reads the native quoted multi-select and shows notes", () => {
    const text = 'Your questions have been answered: "Which features?"="Dark mode, "Sync, beta"" notes: ship behind a flag. You can now continue with these answers in mind.';
    const questions = [{ ...QUESTIONS[1], options: [{ label: "Dark mode" }, { label: "Sync, beta" }] }];
    render(
      <ToolCallBubble
        toolUse={{ role: "assistant", type: "tool_use", toolName: "AskUserQuestion", content: JSON.stringify({ questions }), toolUseId: "q-1" }}
        toolResult={result(text)}
        isRunning={false}
      />,
    );
    expect(chosenLabels()).toEqual(["Dark mode", "Sync, beta"]);
    expect(screen.getByText("Your note")).toBeTruthy();
    expect(screen.getByText("ship behind a flag")).toBeTruthy();
  });

  it("shows a free-text response as answered", () => {
    render(<ToolCallBubble toolUse={toolUse()} toolResult={result("The user responded: whatever is simplest")} isRunning={false} />);
    expect(screen.getByText("Answered")).toBeTruthy();
    expect(screen.getByText("Your response")).toBeTruthy();
    expect(screen.getByText("“whatever is simplest”")).toBeTruthy();
    expect(screen.queryByText("No answer")).toBeNull();
  });

  it("shows a follow-up request with what they also wrote", () => {
    const text =
      'The user asked for more questions before you proceed. So far they answered: "Which features?"="Sync". They also wrote: "what about auth?". Call AskUserQuestion again with follow-up questions.';
    render(<ToolCallBubble toolUse={toolUse()} toolResult={result(text)} isRunning={false} />);
    expect(screen.getByText("Asked for more questions")).toBeTruthy();
    expect(screen.getByText("They also wrote")).toBeTruthy();
    expect(chosenLabels()).toEqual(["Sync"]);
  });

  it("shows an AFK timeout distinctly, keeping the partial selection", () => {
    const text = 'No response after 300s — the user may be away from keyboard. Proceed.\nBefore going idle the user had selected: "Which features?"="Sync".';
    render(<ToolCallBubble toolUse={toolUse()} toolResult={result(text)} isRunning={false} />);
    expect(screen.getByText("Timed out")).toBeTruthy();
    expect(screen.queryByText("Answered")).toBeNull();
    expect(screen.getByTestId("questions-card-footer").textContent).toBe("No response after 300s — continued with the selection so far");
    expect(chosenLabels()).toEqual(["Sync"]);
  });

  it("shows a denial as not answered, with the reason", () => {
    render(<ToolCallBubble toolUse={toolUse()} toolResult={result("User denied")} isRunning={false} />);
    expect(screen.getByText("Not answered")).toBeTruthy();
    expect(screen.getByText("User denied")).toBeTruthy();
  });

  it("shows 'did not answer' as not answered", () => {
    render(<ToolCallBubble toolUse={toolUse()} toolResult={result("The user did not answer the questions.")} isRunning={false} />);
    expect(screen.getByText("Not answered")).toBeTruthy();
    expect(screen.queryByText("No answer")).toBeNull();
  });

  it("says no answer was recorded when the turn ended without a result", () => {
    render(<ToolCallBubble toolUse={toolUse()} toolResult={null} isRunning={false} />);
    expect(screen.getByText("No answer recorded")).toBeTruthy();
  });

  it("leaves a non-question payload to the generic tool row", () => {
    render(
      <ToolCallBubble
        toolUse={{ role: "assistant", type: "tool_use", toolName: "AskUserQuestion", content: '{"prompt":"x"}', toolUseId: "q-2" }}
        toolResult={null}
        isRunning={false}
      />,
    );
    expect(screen.queryByTestId("questions-card")).toBeNull();
  });
});
