// @vitest-environment jsdom
/**
 * The section header's two folder-specific jobs: a glyph that tells a folder
 * named "Pinned" from the Pinned section, and a label that ellipsizes rather
 * than pushing the count out of a 300px sidebar. Layout itself is a browser
 * matter (jsdom has none); what is pinned here is the structure that produces
 * it — the label alone in a shrinkable, clipped span, the count in one that
 * never shrinks.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ChatSectionHeader from "./ChatSectionHeader";

afterEach(cleanup);

const LONG = "x".repeat(64);

describe("ChatSectionHeader", () => {
  it("keeps the accessible name 'Label (n)'", () => {
    render(<ChatSectionHeader label="Pinned" count={3} expanded onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: "Pinned (3)" })).toBeTruthy();
  });

  it("marks a folder with a glyph and its full name as the tooltip; built-ins get neither", () => {
    render(<ChatSectionHeader label="Pinned" count={1} expanded onToggle={() => {}} isFolder />);
    const folder = screen.getByRole("button");
    expect(folder.querySelectorAll("svg")).toHaveLength(2); // chevron + folder
    expect(folder.getAttribute("title")).toBe("Folder: Pinned");
    cleanup();

    render(<ChatSectionHeader label="Pinned" count={1} expanded onToggle={() => {}} />);
    const builtin = screen.getByRole("button");
    expect(builtin.querySelectorAll("svg")).toHaveLength(1);
    expect(builtin.getAttribute("title")).toBeNull();
  });

  it("ellipsizes a long label in its own span and never shrinks the count", () => {
    render(<ChatSectionHeader label={LONG} count={12} expanded onToggle={() => {}} isFolder />);
    const button = screen.getByRole("button");
    const label = [...button.querySelectorAll("span")].find((el) => el.textContent === LONG)!;
    const countSpan = [...button.querySelectorAll("span")].find((el) => el.textContent === " (12)")!;
    expect(label.style.overflow).toBe("hidden");
    expect(label.style.textOverflow).toBe("ellipsis");
    expect(label.style.whiteSpace).toBe("nowrap");
    expect(["0", "0px"]).toContain(label.style.minWidth);
    expect(countSpan.style.flexShrink).toBe("0");
    expect(button.getAttribute("title")).toBe(`Folder: ${LONG}`);
  });

  it("shows no running indicator at zero (the default)", () => {
    render(<ChatSectionHeader label="Work" count={2} runningCount={0} expanded onToggle={() => {}} isFolder />);
    expect(screen.getByRole("button", { name: "Work (2)" })).toBeTruthy();
    expect(screen.queryByTestId("section-running")).toBeNull();
  });

  it("shows a dot and the running count, named and titled 'n running'", () => {
    render(<ChatSectionHeader label="Work" count={12} runningCount={3} expanded onToggle={() => {}} isFolder />);
    expect(screen.getByRole("button", { name: "Work (12) 3 running" })).toBeTruthy();
    const indicator = screen.getByTestId("section-running");
    expect(indicator.getAttribute("title")).toBe("3 running");
    expect(indicator.style.color).toBe("var(--status-active)");
    const [dot, number] = [...indicator.children] as HTMLElement[];
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.style.background).toBe("var(--status-active)");
    expect(dot.style.width).toBe("7px");
    expect(number.textContent).toBe("3");
  });

  it("never shrinks the running indicator beside a long, ellipsizing label", () => {
    render(<ChatSectionHeader label={LONG} count={12} runningCount={2} expanded onToggle={() => {}} isFolder />);
    const button = screen.getByRole("button");
    const label = [...button.querySelectorAll("span")].find((el) => el.textContent === LONG)!;
    expect(label.style.textOverflow).toBe("ellipsis");
    expect(screen.getByTestId("section-running").style.flexShrink).toBe("0");
  });
});
