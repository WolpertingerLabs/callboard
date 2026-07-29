/**
 * What the theme audit actually communicates, as opposed to what it contains.
 *
 * The engine's tests prove the numbers. These pin the two things a reader of the
 * panel depends on and neither the engine nor the route can guarantee: that the
 * detail is navigable rather than a 26-row wall, and that the half of the
 * diagnosis with no ratio attached — the variables a theme never defines — is
 * visible at all.
 */
// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { cleanup, render, screen, fireEvent, within } from "@testing-library/react";
import ThemeAuditPanel from "./ThemeAuditPanel";
import type { ThemeContrastReport } from "../../api";

afterEach(cleanup);

function failure(mode: "dark" | "light", id: string, ratio: number | null, where: string) {
  return { mode, id, where, fg: `var(--${id})`, bg: "var(--bg)", backdrop: "var(--bg)", required: 4.5, ratio, ...(ratio === null ? { unmeasurable: "var(--x) → goldenrod" } : {}) };
}

/** Golden Hour's shape: failures in both modes, and five variables it never names. */
const REPORT: ThemeContrastReport = {
  checked: 104,
  failures: [
    failure("light", "chatlist-badge-triggered", 2.62, "ChatListItem/FolderListItem triggered badge"),
    failure("dark", "warning-on-warning-bg-bg", 3.25, "CodeLoginModal warning box"),
    failure("dark", "danger-on-danger-bg-bg", 3.97, "DraftModal / MessageBubble error box"),
    failure("light", "accent-on-accent-bg-bg", 4.11, "PromptInput attachment chip"),
  ],
  undefinedVariables: {
    dark: ["bg-sidebar", "bg-popout", "info-bg", "status-green", "badge-provider-codex-bg"],
    light: ["bg-sidebar", "bg-popout", "info-bg", "status-green", "badge-provider-codex-bg"],
  },
};

const expand = () => fireEvent.click(screen.getByRole("button"));

describe("ThemeAuditPanel", () => {
  it("collapses to a summary naming both kinds of problem", () => {
    render(<ThemeAuditPanel report={REPORT} />);
    const chip = screen.getByRole("button");
    expect(chip.textContent).toContain("4 of 104 colour pairings fall below WCAG AA");
    expect(chip.textContent).toContain("5 variables not defined");
  });

  it("leads the detail with the worst pairing and the per-mode split", () => {
    render(<ThemeAuditPanel report={REPORT} />);
    expand();
    // Not "here are 26 rows, good luck" — the one line worth reading first.
    expect(screen.getByText(/2 dark \/ 2 light — worst: .*triggered badge 2\.62:1 \/ 4\.5/)).toBeTruthy();
  });

  it("groups the rows by mode instead of interleaving them", () => {
    render(<ThemeAuditPanel report={REPORT} />);
    expand();
    const darkHeading = screen.getByText(/^dark mode · 2$/);
    const lightHeading = screen.getByText(/^light mode · 2$/);
    // Each group holds only its own mode's rows — the six `where` strings that
    // appear in both modes are no longer told apart by a column alone.
    const darkGroup = darkHeading.parentElement!;
    expect(within(darkGroup).getByText("CodeLoginModal warning box")).toBeTruthy();
    expect(within(darkGroup).queryByText("PromptInput attachment chip")).toBeNull();
    expect(within(lightHeading.parentElement!).getByText("PromptInput attachment chip")).toBeTruthy();
  });

  it("surfaces the variables the theme never defines — the failures that have no ratio", () => {
    render(<ThemeAuditPanel report={REPORT} />);
    expand();
    expect(screen.getByText(/--bg-sidebar, --bg-popout, --info-bg, --status-green, --badge-provider-codex-bg/)).toBeTruthy();
    expect(screen.getByText(/fall back to the built-in palette/)).toBeTruthy();
  });

  it("shows up for a theme with perfect contrast but missing variables", () => {
    // The sidebar bug produces zero contrast failures. A panel gated on
    // `failures.length > 0` said nothing at all about it.
    render(<ThemeAuditPanel report={{ checked: 104, failures: [], undefinedVariables: { dark: ["status-green"], light: ["status-green"] } }} />);
    expect(screen.getByRole("button").textContent).toContain("1 variable not defined");
    expand();
    expect(screen.queryByText(/below WCAG AA/)).toBeNull();
    expect(screen.getByText("--status-green")).toBeTruthy();
  });

  it("names each mode separately when they disagree about what is missing", () => {
    render(<ThemeAuditPanel report={{ checked: 104, failures: [], undefinedVariables: { dark: ["status-green"], light: ["info-bg", "status-green"] } }} />);
    expand();
    expect(screen.getByText(/^dark: --status-green$/)).toBeTruthy();
    expect(screen.getByText(/^light: --info-bg, --status-green$/)).toBeTruthy();
  });

  it("renders nothing when a theme is clean on both counts", () => {
    const { container } = render(<ThemeAuditPanel report={{ checked: 104, failures: [], undefinedVariables: { dark: [], light: [] } }} />);
    expect(container.firstChild).toBeNull();
  });

  it("tolerates a report from a server that predates the undefined-variable half", () => {
    render(<ThemeAuditPanel report={{ checked: 104, failures: [failure("dark", "x", 2.1, "somewhere")] }} />);
    expect(screen.getByRole("button").textContent).toContain("1 of 104");
    expect(screen.getByRole("button").textContent).not.toContain("not defined");
  });
});
