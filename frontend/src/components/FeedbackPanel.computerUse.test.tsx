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
import { afterEach, describe, expect, it, vi } from "vitest";
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

it("says when nothing is waiting on the answer, and that a stale screen means it will not run", () => {
  render(<FeedbackPanel action={{ ...guiAction, nonBlocking: true }} onRespond={() => {}} agentName="Codex" />);
  expect(screen.getByText(/Codex isn’t waiting on this/).textContent).toContain("runs only if the screen it was aimed at hasn’t changed");
  cleanup();
  render(<FeedbackPanel action={guiAction} onRespond={() => {}} />);
  expect(screen.queryByText(/isn’t waiting on this/)).toBeNull();
});

it("keeps Confirm disabled while the card is locked, and lets Deny through", () => {
  const onRespond = vi.fn();
  render(<FeedbackPanel action={{ ...guiAction, humanOnly: true, nonBlocking: true }} onRespond={onRespond} approveLocked />);
  const confirm = screen.getByRole("button", { name: "Confirm" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.click(confirm);
  expect(onRespond).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(onRespond).toHaveBeenCalledWith(false);
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
// tool is called `cu_action` (the bare spelling the pi custom-tool
// bridge uses) must not borrow that, or a human could confirm a `command` they
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

it.each(["ask", "allow"])("renders trusted enablement disclosure for %s, with escaped reason and explicit buttons", (level) => {
  const onRespond = vi.fn();
  const { container } = render(
    <FeedbackPanel
      action={{
        type: "permission_request",
        toolName: "mcp__computer_use__cu_request_control",
        requestId: "server-id",
        humanOnly: true,
        controlRequest: true,
        input: { kind: "desktop", target: "trusted-host", reason: "<img src=x onerror=alert(1)>", permission: level },
      }}
      onRespond={onRespond}
    />,
  );
  expect(screen.getByText("Target: trusted-host")).toBeTruthy();
  expect(screen.getByText(/Screenshots of this target/)).toBeTruthy();
  expect(screen.getByText(/Subagents running inside/)).toBeTruthy();
  expect(screen.getByText(/existing app windows on the service host/)).toBeTruthy();
  expect(screen.getByText(/15 minutes/)).toBeTruthy();
  expect(screen.getByText(level === "ask" ? /each agent action requires/ : /act unattended/)).toBeTruthy();
  expect(container.querySelector("img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Enable desktop control" }));
  expect(onRespond).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(onRespond).toHaveBeenCalledWith(false);
});
it("a lookalike name or input-supplied trust markers cannot render the enablement card", () => {
  render(
    <FeedbackPanel
      action={{
        type: "permission_request",
        toolName: "mcp__computer_use__cu_request_control",
        input: { kind: "desktop", controlRequest: true, humanOnly: true, requestId: "forged" },
      }}
      onRespond={() => {}}
    />,
  );
  expect(screen.queryByRole("button", { name: "Enable desktop control" })).toBeNull();
  expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy();
});

it("titles a Sandbox desktop request as such and says it is a container desktop, not this machine", () => {
  const onRespond = vi.fn();
  render(
    <FeedbackPanel
      action={{
        type: "permission_request",
        toolName: "mcp__computer_use__cu_request_control",
        requestId: "server-id",
        humanOnly: true,
        controlRequest: true,
        input: { kind: "sandbox", target: "sandbox 127.0.0.1:7801", reason: "Test the signup flow", permission: "allow" },
      }}
      onRespond={onRespond}
    />,
  );
  expect(screen.getByText("Enable Sandbox desktop control", { selector: "strong" })).toBeTruthy();
  expect(screen.queryByText(/Enable browser control/)).toBeNull();
  const note = screen.getByText(/The Sandbox desktop is a Linux desktop in a hardened container/).textContent!;
  expect(note).toContain("not this machine");
  // What it is today: shared and persistent, with an open network that reaches this machine's services.
  expect(note).toContain("shared by every chat and kept until the container is restarted");
  expect(note).toContain("later sessions and other chats can see");
  expect(note).toContain("any service on this machine that listens on all interfaces, Callboard included");
  expect(note).not.toMatch(/disposable|fresh|reset/i);
  expect(screen.queryByText(/existing app windows on the service host/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Enable Sandbox desktop control" }));
  expect(onRespond).toHaveBeenCalledWith(true);
});

it("says a GUI action on the Sandbox desktop is on the container, not this machine", () => {
  render(<FeedbackPanel action={{ ...guiAction, input: { ...guiAction.input, kind: "sandbox" } }} onRespond={() => {}} />);
  expect(screen.getByText(/This chat asks before every GUI action/).textContent).toContain(
    "Sandbox desktop, a Linux desktop in a hardened container, isolated from this machine's files and credentials, but shared by every chat",
  );
  cleanup();
  render(<FeedbackPanel action={{ ...guiAction, input: { ...guiAction.input, kind: "browser" } }} onRespond={() => {}} />);
  expect(screen.getByText(/This chat asks before every GUI action/).textContent).not.toContain("Sandbox desktop");
});

describe("the sandbox cards follow how the daemon runs it (input.sandbox)", () => {
  const consent = (sandbox?: unknown) => (
    <FeedbackPanel
      action={{
        type: "permission_request",
        toolName: "mcp__computer_use__cu_request_control",
        requestId: "server-id",
        humanOnly: true,
        controlRequest: true,
        input: { kind: "sandbox", target: "sandbox (container on this machine)", reason: "Try it", permission: "ask", ...(sandbox ? { sandbox } : {}) },
      }}
      onRespond={() => {}}
    />
  );
  const note = () => screen.getByText(/The Sandbox desktop is a Linux desktop in a hardened container/).textContent!;

  it("managed: a fresh container per session, removed at the end, with an open network", () => {
    render(consent({ mode: "managed", network: "internet" }));
    expect(note()).toContain("starts a fresh one for each session and removes it, with everything in it, when the session ends");
    expect(note()).toContain("no other chat ever sees it");
    expect(note()).toContain("it can reach the internet, and any service on this machine that listens on all interfaces");
    expect(note()).not.toContain("shared by every chat");
  });

  it("managed with network none: no internet, but this machine's services are still reachable", () => {
    render(consent({ mode: "managed", network: "none" }));
    expect(note()).toContain("no internet access, but it can still reach any service on this machine that listens on all interfaces");
    expect(note()).not.toContain("it can reach the internet");
  });

  it.each([
    ["endpoint", { mode: "endpoint" }],
    ["missing (an older daemon)", undefined],
    ["malformed", { mode: "fresh!", network: 7 }],
  ])("%s: the shared-container wording", (_name, sandbox) => {
    render(consent(sandbox));
    expect(note()).toContain("shared by every chat and kept until the container is restarted");
    expect(note()).toContain("later sessions and other chats can see");
  });

  it("the per-action card says the action is on a fresh managed container", () => {
    render(
      <FeedbackPanel
        action={{ ...guiAction, input: { ...guiAction.input, kind: "sandbox", sandbox: { mode: "managed", network: "none" } } }}
        onRespond={() => {}}
      />,
    );
    const text = screen.getByText(/This chat asks before every GUI action/).textContent!;
    expect(text).toContain("Callboard starts a fresh one for each session");
    expect(text).not.toContain("shared by every chat");
    // The prompt body shows the summary and the action, never the variant.
    expect(screen.getByText(/Open https:\/\/example.com/).textContent).not.toContain(`"mode"`);
  });
});
