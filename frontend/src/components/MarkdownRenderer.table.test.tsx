// @vitest-environment jsdom
/**
 * Guards the responsive-table markup. jsdom applies no layout, so these pin
 * the attributes MarkdownRenderer.css keys on rather than computed widths.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import MarkdownRenderer from "./MarkdownRenderer";

afterEach(cleanup);

const PROSE = [
  "| Window | Hours | What happened |",
  "|---|--:|---|",
  "| First PR opened (11-16 22:49Z) to first merge (11-17 13:37Z) | ~15 | Building and reviewing: two to four critique rounds per PR, plus Devin. |",
  "| First merge to last merge (21:13Z) | ~7.5 | Ten PRs merged in five batches. |",
].join("\n");

const NUMERIC = ["| Model | Score | Cost |", "|---|---|---|", "| a | 1 | $2 |", "| b | 3 | $4 |"].join("\n");

function renderTable(markdown: string) {
  const { container } = render(<MarkdownRenderer content={markdown} />);
  return { wrap: container.querySelector(".md-table-wrap")!, table: container.querySelector("table")! };
}

describe("MarkdownRenderer tables", () => {
  it("wraps every table in a scroll container", () => {
    const { wrap, table } = renderTable(NUMERIC);
    expect(wrap).not.toBeNull();
    expect(table.parentElement).toBe(wrap);
    expect(table.classList.contains("md-table")).toBe(true);
  });

  it("captions each body cell with its column header", () => {
    const { table } = renderTable(PROSE);
    const labels = [...table.querySelectorAll("tbody tr:first-child td")].map((td) => td.getAttribute("data-label"));
    expect(labels).toEqual(["Window", "Hours", "What happened"]);
  });

  it("marks prose columns wide and leaves short ones alone", () => {
    const { table } = renderTable(PROSE);
    const wide = [...table.querySelectorAll("thead th")].map((th) => th.hasAttribute("data-wide"));
    expect(wide).toEqual([true, false, true]);
  });

  it("makes prose-heavy tables stackable, with explicit roles", () => {
    const { wrap, table } = renderTable(PROSE);
    expect(table.hasAttribute("data-stack")).toBe(true);
    expect(wrap.hasAttribute("data-stack")).toBe(true);
    expect(table.getAttribute("role")).toBe("table");
    expect(table.querySelector("tbody tr")!.getAttribute("role")).toBe("row");
    expect(table.querySelector("td")!.getAttribute("role")).toBe("cell");
    expect(table.querySelector("th")!.getAttribute("role")).toBe("columnheader");
  });

  it("keeps short tables as grids", () => {
    const { wrap, table } = renderTable(NUMERIC);
    expect(table.hasAttribute("data-stack")).toBe(false);
    expect(wrap.hasAttribute("data-stack")).toBe(false);
    expect(table.hasAttribute("role")).toBe(false);
  });

  it("preserves GFM column alignment", () => {
    const { table } = renderTable(PROSE);
    expect((table.querySelector("tbody td:nth-child(2)") as HTMLElement).style.textAlign).toBe("right");
  });
});
