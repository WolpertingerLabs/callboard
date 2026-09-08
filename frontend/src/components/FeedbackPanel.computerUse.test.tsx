/**
 * The GUI-action confirmation, as the human sees it in the chat. It is raised
 * only by a chat whose computer control is set to Ask; under Allow the agent
 * acts and this panel never appears.
 *
 * This is the panel that replaced the Computer Control panel's approval block.
 * The thing being fixed was legibility: the old request read `Confirm one GUI
 * action on session a47b366c-…, frame 1e638c55-…: {"type":"navigate","url":…}`.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import FeedbackPanel from "./FeedbackPanel";

afterEach(cleanup);

const guiAction = {
  type: "permission_request" as const,
  toolName: "mcp__computer_use__cu_action",
  input: {
    summary: "Open https://example.com in the managed browser on workshop",
    target: "managed browser on workshop",
    action: { type: "navigate", url: "https://example.com" },
  },
};

it("names the action and its target instead of the tool's wire name", () => {
  render(<FeedbackPanel action={guiAction} onRespond={() => {}} />);
  expect(screen.getByText("Confirm this GUI action")).toBeTruthy();
  expect(screen.getByText("Computer control")).toBeTruthy();
  expect(screen.queryByText("mcp__computer_use__cu_action")).toBeNull();
  const body = screen.getByText(/Open https:\/\/example\.com/).textContent!;
  expect(body).toContain("Open https://example.com in the managed browser on workshop");
  // The exact action still follows the summary: nothing is hidden behind it.
  expect(body).toContain('{"type":"navigate","url":"https://example.com"}');
  expect(screen.getByText(/This chat asks before every GUI action/)).toBeTruthy();
});

it("offers Confirm and Deny, and reports each one faithfully", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={guiAction} onRespond={onRespond} />);
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(onRespond).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  expect(onRespond).toHaveBeenLastCalledWith(true);
});

// Matching here is trust-side: it grants the computer-control header and makes
// formatInput render ONLY `summary` + `action`. A third-party MCP server whose
// tool is called `cu_action` (the bare spelling the cline/pi custom-tool
// bridges use) must not borrow that, or a human could confirm a `command` they
// were never shown.
it.each(["cu_action", "computer_use_cu_action", "mcp__evil__cu_action", "my_cu_action", "MCP__COMPUTER_USE__CU_ACTION"])(
  "does not lend its chrome to a lookalike tool named %s",
  (toolName) => {
    render(<FeedbackPanel action={{ ...guiAction, toolName, input: { ...guiAction.input, command: "rm -rf /" } }} onRespond={() => {}} />);
    expect(screen.getByText("Permission requested")).toBeTruthy();
    expect(screen.getByText(toolName)).toBeTruthy();
    expect(screen.queryByText(/This chat asks before every GUI action/)).toBeNull();
    // And its other inputs are rendered rather than hidden behind `summary`.
    expect(screen.getByText(/rm -rf \//)).toBeTruthy();
  },
);

it("leaves every other permission request exactly as it was", () => {
  render(<FeedbackPanel action={{ type: "permission_request", toolName: "Bash", input: { command: "ls -la" } }} onRespond={() => {}} />);
  expect(screen.getByText("Permission requested")).toBeTruthy();
  expect(screen.getByText("Bash")).toBeTruthy();
  expect(screen.getByText("ls -la")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
});
