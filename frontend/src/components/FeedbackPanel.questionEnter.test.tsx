/**
 * Enter in an AskUserQuestion "Other..." box submits the same answers the
 * Submit button would — but only once every question is answered, and never
 * for Shift+Enter or a keystroke that is committing an IME composition.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import FeedbackPanel from "./FeedbackPanel";

afterEach(cleanup);

const oneQuestion = {
  type: "user_question" as const,
  questions: [{ question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] }],
};

const twoQuestions = {
  type: "user_question" as const,
  questions: [
    { question: "Which colour?", options: [{ label: "Red" }, { label: "Blue" }] },
    { question: "Which size?", options: [{ label: "Small" }, { label: "Large" }] },
  ],
};

it("Enter in the Other box submits the typed answer, like clicking Submit", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={oneQuestion} onRespond={onRespond} />);
  const other = screen.getByPlaceholderText("Other...");
  fireEvent.change(other, { target: { value: "Green" } });
  fireEvent.keyDown(other, { key: "Enter" });
  expect(onRespond).toHaveBeenCalledTimes(1);
  expect(onRespond).toHaveBeenCalledWith(true, { answers: { "Which colour?": "Green" } });
});

it("Enter submits every question's answer, not just the focused one", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={twoQuestions} onRespond={onRespond} />);
  fireEvent.click(screen.getByRole("button", { name: "Small" }));
  const other = screen.getAllByPlaceholderText("Other...")[0];
  fireEvent.change(other, { target: { value: "Green" } });
  fireEvent.keyDown(other, { key: "Enter" });
  expect(onRespond).toHaveBeenCalledWith(true, { answers: { "Which colour?": "Green", "Which size?": "Small" } });
});

it("Enter does not bubble to outer key handlers", () => {
  const outer = vi.fn();
  render(
    <div onKeyDown={outer}>
      <FeedbackPanel action={oneQuestion} onRespond={() => {}} />
    </div>,
  );
  const other = screen.getByPlaceholderText("Other...");
  fireEvent.change(other, { target: { value: "Green" } });
  const notCancelled = fireEvent.keyDown(other, { key: "Enter" });
  expect(notCancelled).toBe(false);
  expect(outer).not.toHaveBeenCalled();
});

it("Shift+Enter does not submit", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={oneQuestion} onRespond={onRespond} />);
  const other = screen.getByPlaceholderText("Other...");
  fireEvent.change(other, { target: { value: "Green" } });
  fireEvent.keyDown(other, { key: "Enter", shiftKey: true });
  expect(onRespond).not.toHaveBeenCalled();
});

it("Enter during IME composition does not submit", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={oneQuestion} onRespond={onRespond} />);
  const other = screen.getByPlaceholderText("Other...");
  fireEvent.change(other, { target: { value: "みどり" } });
  fireEvent.keyDown(other, { key: "Enter", isComposing: true });
  fireEvent.keyDown(other, { key: "Enter", keyCode: 229 });
  expect(onRespond).not.toHaveBeenCalled();
});

it("Enter with an unanswered question does not submit a partial answer", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={twoQuestions} onRespond={onRespond} />);
  const other = screen.getAllByPlaceholderText("Other...")[0];
  fireEvent.change(other, { target: { value: "Green" } });
  fireEvent.keyDown(other, { key: "Enter" });
  expect(onRespond).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Large" }));
  fireEvent.keyDown(other, { key: "Enter" });
  expect(onRespond).toHaveBeenCalledWith(true, { answers: { "Which colour?": "Green", "Which size?": "Large" } });
});

it("typing in the Other box still replaces a selected option", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={oneQuestion} onRespond={onRespond} />);
  fireEvent.click(screen.getByRole("button", { name: "Red" }));
  fireEvent.change(screen.getByPlaceholderText("Other..."), { target: { value: "Green" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect(onRespond).toHaveBeenCalledWith(true, { answers: { "Which colour?": "Green" } });
});
