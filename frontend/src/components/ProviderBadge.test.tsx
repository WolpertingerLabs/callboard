// @vitest-environment jsdom
/**
 * The provider tag: a live harness gets its own filled tag, a retired one names
 * itself as removed, and anything else is the Claude Code default.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ProviderBadge from "./ProviderBadge";

afterEach(cleanup);

describe("ProviderBadge", () => {
  it("still renders the other providers unchanged", () => {
    const { rerender } = render(<ProviderBadge provider="pi" />);
    expect(screen.getByText("PI")).toBeTruthy();
    rerender(<ProviderBadge provider={undefined} />);
    expect(screen.getByText("CC")).toBeTruthy();
  });

  it("names a removed harness rather than falling through to CC", () => {
    // A chat on the retired OpenRouter harness is still reachable — by direct
    // URL, or as an ancestor in a chat tree — and this badge is the only place
    // the UI names the harness. "CC" would assert the one thing that is not
    // true: that Claude Code can pick the conversation up.
    render(<ProviderBadge provider="openrouter" />);
    expect(screen.getByText("OR")).toBeTruthy();
    expect(screen.getByTitle(/OpenRouter agent harness, which has been removed/)).toBeTruthy();
  });

  it("names the retired Cline harness as CL, removed — not as CC", () => {
    render(<ProviderBadge provider="cline" />);
    expect(screen.getByText("CL")).toBeTruthy();
    expect(screen.queryByText("CC")).toBeNull();
    expect(screen.getByTitle(/ran on Cline, which has been removed/)).toBeTruthy();
  });

  it("names the retired ACP harness as OpenCode (OC), removed — not as CC", () => {
    render(<ProviderBadge provider="acp" />);
    expect(screen.getByText("OC")).toBeTruthy();
    expect(screen.queryByText("CC")).toBeNull();
    expect(screen.getByTitle(/ran on OpenCode, which has been removed/)).toBeTruthy();
  });

  it("keeps an unrecognized provider on the CC default", () => {
    // Only a *known-retired* value gets the special case; anything else is a
    // typo or a kind this build predates, and both degrade to Claude Code.
    render(<ProviderBadge provider="open-router" />);
    expect(screen.getByText("CC")).toBeTruthy();
  });
});
