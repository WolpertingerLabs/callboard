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
});
