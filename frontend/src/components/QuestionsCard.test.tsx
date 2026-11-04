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

function chosenLabels(): string[] {
  return Array.from(document.querySelectorAll("[data-chosen]")).map((el) => el.textContent ?? "");
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
    expect(chosenLabels()).toEqual(["Implement SigV4 (Recommended)Sign each request.", "Dark mode", "Export"]);
    expect(screen.getByText("“and a CLI”")).toBeTruthy();
  });

  it("marks a question the result skipped as unanswered", () => {
    render(<ToolCallBubble toolUse={toolUse()} toolResult={result('The user answered: "Which features?"="Sync". Read.')} isRunning={false} />);
    expect(screen.getByText("No answer")).toBeTruthy();
    expect(chosenLabels()).toEqual(["Sync"]);
  });

  it("shows a denial as not answered, with the reason", () => {
    render(<ToolCallBubble toolUse={toolUse()} toolResult={result("User denied")} isRunning={false} />);
    expect(screen.getByText("Not answered")).toBeTruthy();
    expect(screen.getByText("User denied")).toBeTruthy();
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
