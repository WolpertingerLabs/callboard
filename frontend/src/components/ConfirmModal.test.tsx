// @vitest-environment jsdom
/**
 * `onCancel` is "closed without confirming": Cancel calls it before `onClose`,
 * Confirm never does. `onClose` still follows both, so callers that pass no
 * `onCancel` behave exactly as before it existed.
 */
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ConfirmModal from "./ConfirmModal";

afterEach(cleanup);

function renderModal(withCancel: boolean) {
  const calls: string[] = [];
  render(
    <ConfirmModal
      isOpen
      title="Sure?"
      message="Really."
      confirmText="Do it"
      onConfirm={() => calls.push("confirm")}
      onClose={() => calls.push("close")}
      {...(withCancel && { onCancel: () => calls.push("cancel") })}
    />,
  );
  return calls;
}

it("calls onCancel then onClose on Cancel", () => {
  const calls = renderModal(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(calls).toEqual(["cancel", "close"]);
});

it("never calls onCancel on Confirm", () => {
  const calls = renderModal(true);
  fireEvent.click(screen.getByRole("button", { name: "Do it" }));
  expect(calls).toEqual(["confirm", "close"]);
});

it("without onCancel, behaves as before: Cancel closes, Confirm confirms then closes", () => {
  const calls = renderModal(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Do it" }));
  expect(calls).toEqual(["close", "confirm", "close"]);
});
