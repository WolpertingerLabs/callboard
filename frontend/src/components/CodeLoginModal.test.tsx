/**
 * The modal that told everyone to run `claude auth login`.
 *
 * Two things were wrong with that, and this suite pins both. It appeared for
 * users who had configured an API key and needed no login at all — fixed on the
 * server, in `services/claude-auth-status.ts` — and, when it did legitimately
 * appear, it named a command the machine may not have: a daemon running on the
 * Agent SDK's bundled binary has no native `claude`, so `claude auth login` is
 * not something anyone can type there.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import CodeLoginModal from "./CodeLoginModal";

vi.mock("../api", () => ({ checkClaudeStatus: vi.fn() }));

afterEach(cleanup);

const noop = () => {};

describe("which remedy it offers", () => {
  it("offers `claude auth login` when the server resolved a native CLI", () => {
    render(<CodeLoginModal isOpen onClose={noop} onStatusChange={noop} status={{ loggedIn: false, cliPath: "/usr/local/bin/claude" }} />);

    expect(screen.getByText("claude auth login")).toBeTruthy();
    expect(screen.getByText(/open a terminal on that machine and run/)).toBeTruthy();
  });

  it("does NOT offer it when there is no native CLI on that machine", () => {
    render(<CodeLoginModal isOpen onClose={noop} onStatusChange={noop} status={{ loggedIn: false }} />);

    // The command still appears — inside the sentence saying it is not
    // available here. What must be gone is the *instruction*: the copy block and
    // the "open a terminal and run this" that used to sit above it.
    expect(screen.queryByText(/open a terminal on that machine and run/)).toBeNull();
    expect(screen.getByText(/is not a command it can run/)).toBeTruthy();
  });

  // The route an API-key user takes, and the one the old copy never mentioned —
  // so someone with no `claude` and no way to install one was left with a modal
  // offering nothing they could do.
  it.each([
    ["with a CLI", { loggedIn: false, cliPath: "/usr/local/bin/claude" }],
    ["without one", { loggedIn: false }],
  ])("names the credential path that needs no CLI at all, %s", (_label, status) => {
    render(<CodeLoginModal isOpen onClose={noop} onStatusChange={noop} status={status} />);
    expect(screen.getByText(/API key or auth token under Settings/)).toBeTruthy();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<CodeLoginModal isOpen={false} onClose={noop} onStatusChange={noop} />);
    expect(container.firstChild).toBeNull();
  });
});
