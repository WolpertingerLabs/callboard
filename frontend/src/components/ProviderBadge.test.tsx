// @vitest-environment jsdom
/**
 * The provider tag, and specifically the ACP case.
 *
 * "ACP" is a wire format, not a harness — every vendor speaks it — so a chat
 * running OpenCode showed a tag that named the transport rather than the thing
 * the user picked in the New Chat panel. The vendor was always available (chat
 * metadata carries `acpProviderId` alongside `provider`); the badge just never
 * read it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ProviderBadge from "./ProviderBadge";

afterEach(cleanup);

describe("ProviderBadge", () => {
  it("tags the ACP vendor, not the protocol", () => {
    render(<ProviderBadge provider="acp" acpProviderId="opencode" />);
    expect(screen.getByText("OC")).toBeTruthy();
    expect(screen.getByTitle("This chat runs on OpenCode")).toBeTruthy();
  });

  it("falls back to the family tag for a vendor it has no entry for", () => {
    // A preset wired in by hand through the override seam. "ACP" is
    // unspecific rather than wrong, which beats guessing a tag.
    render(<ProviderBadge provider="acp" acpProviderId="some-future-cli" />);
    expect(screen.getByText("ACP")).toBeTruthy();
    expect(screen.getByTitle("This chat runs on an ACP agent")).toBeTruthy();
  });

  it("falls back to the family tag when the vendor is unknown", () => {
    render(<ProviderBadge provider="acp" />);
    expect(screen.getByText("ACP")).toBeTruthy();
  });

  it("ignores the vendor id on every other provider", () => {
    render(<ProviderBadge provider="codex" acpProviderId="opencode" />);
    expect(screen.getByText("CX")).toBeTruthy();
  });

  it("still renders the other providers unchanged", () => {
    const { rerender } = render(<ProviderBadge provider="openrouter" />);
    expect(screen.getByText("OR")).toBeTruthy();
    rerender(<ProviderBadge provider={undefined} />);
    expect(screen.getByText("CC")).toBeTruthy();
  });
});
