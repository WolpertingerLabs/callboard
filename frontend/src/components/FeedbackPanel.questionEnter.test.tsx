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

it("clearing the Other box withdraws its answer", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={oneQuestion} onRespond={onRespond} />);
  const other = screen.getByPlaceholderText("Other...");
  fireEvent.change(other, { target: { value: "G" } });
  fireEvent.change(other, { target: { value: "" } });
  fireEvent.keyDown(other, { key: "Enter" });
  expect(onRespond).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect(onRespond).toHaveBeenCalledWith(true, { answers: {} });
});

it("clearing the Other box keeps an option clicked after it", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={oneQuestion} onRespond={onRespond} />);
  const other = screen.getByPlaceholderText("Other...") as HTMLInputElement;
  fireEvent.change(other, { target: { value: "G" } });
  fireEvent.click(screen.getByRole("button", { name: "Blue" }));
  fireEvent.change(other, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect(onRespond).toHaveBeenCalledWith(true, { answers: { "Which colour?": "Blue" } });
});

it("clicking a single-select option clears the Other box it replaced", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={oneQuestion} onRespond={onRespond} />);
  const other = screen.getByPlaceholderText("Other...") as HTMLInputElement;
  fireEvent.change(other, { target: { value: "Green" } });
  fireEvent.click(screen.getByRole("button", { name: "Blue" }));
  expect(other.value).toBe("");
  fireEvent.keyDown(other, { key: "Enter" });
  expect(onRespond).toHaveBeenCalledWith(true, { answers: { "Which colour?": "Blue" } });
});

it("on a multi-select question, Other is an extra entry alongside clicked options", () => {
  const onRespond = vi.fn();
  const multi = {
    type: "user_question" as const,
    questions: [{ question: "Which toppings?", multiSelect: true, options: [{ label: "A" }, { label: "Olive" }] }],
  };
  render(<FeedbackPanel action={multi} onRespond={onRespond} />);
  const other = screen.getByPlaceholderText("Other...") as HTMLInputElement;
  // "Avocado" contains "A": a substring check would show option A as selected.
  fireEvent.change(other, { target: { value: "Avocado" } });
  const a = screen.getByRole("button", { name: "A" });
  expect(a.style.background).toBe("var(--surface)");
  fireEvent.click(a);
  fireEvent.click(screen.getByRole("button", { name: "Olive" }));
  expect(a.style.background).toBe("var(--accent-light)");
  expect(other.value).toBe("Avocado");
  fireEvent.keyDown(other, { key: "Enter" });
  expect(onRespond).toHaveBeenLastCalledWith(true, { answers: { "Which toppings?": "A, Olive, Avocado" } });

  // Clearing Other leaves the options; deselecting works on the real list.
  fireEvent.change(other, { target: { value: "" } });
  fireEvent.click(a);
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect(onRespond).toHaveBeenLastCalledWith(true, { answers: { "Which toppings?": "Olive" } });
});

it("typing in the Other box still replaces a selected option", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={oneQuestion} onRespond={onRespond} />);
  fireEvent.click(screen.getByRole("button", { name: "Red" }));
  fireEvent.change(screen.getByPlaceholderText("Other..."), { target: { value: "Green" } });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect(onRespond).toHaveBeenCalledWith(true, { answers: { "Which colour?": "Green" } });
});
