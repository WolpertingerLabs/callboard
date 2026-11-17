// @vitest-environment jsdom
/**
 * Guards responsive markdown tables.
 *
 * The plugin half (markdownTables.ts) is pinned through the rendered
 * attributes. The CSS half is pinned through the real cascade where jsdom
 * computes it (cell word breaking, the wide/nowrap hints), and through the
 * CSSOM for the container query, which jsdom parses but never evaluates.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import MarkdownRenderer from "./MarkdownRenderer";
import { injectCss, readCss } from "../testing/cssCascade";

afterEach(cleanup);

const LONG = "x".repeat(45);

const PROSE = [
  "| Window | Hours | What happened |",
  "|---|--:|---|",
  "| First PR opened (11-16 22:49Z) to first merge (11-17 13:37Z) | ~15 | Building and reviewing: two to four critique rounds per PR, plus Devin. |",
  "| First merge to last merge (21:13Z) | ~7.5 | Ten PRs merged in five batches. |",
].join("\n");

const NUMERIC = ["| Model | Score | Cost |", "|---|---|---|", "| a | 1 | $2 |", "| b | 3 | $4 |"].join("\n");

const table = (header: string[], ...rows: string[][]) =>
  [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

function renderTables(markdown: string) {
  const { container } = render(<MarkdownRenderer content={markdown} />);
  const tables = [...container.querySelectorAll("table")];
  return { container, tables, table: tables[0], wrap: container.querySelector(".md-table-wrap")! };
}

const labelsOf = (t: HTMLTableElement) => [...t.querySelectorAll("tbody tr:first-child td")].map((td) => td.getAttribute("data-label"));
const flagsOf = (t: HTMLTableElement, attr: string) => [...t.querySelectorAll("thead th")].map((th) => th.hasAttribute(attr));

describe("MarkdownRenderer table markup", () => {
  it("wraps every table in a focusable, named scroll region", () => {
    const { wrap, table } = renderTables(NUMERIC);
    expect(table.parentElement).toBe(wrap);
    expect(table.classList.contains("md-table")).toBe(true);
    expect(wrap.getAttribute("role")).toBe("region");
    expect(wrap.getAttribute("aria-label")).toBe("Table");
    expect(wrap.getAttribute("tabindex")).toBe("0");
  });

  it("captions each body cell with its column header as plain text", () => {
    expect(labelsOf(renderTables(PROSE).table)).toEqual(["Window", "Hours", "What happened"]);
    expect(labelsOf(renderTables(table(["**Name**", "`flag`"], ["a", "b"])).table)).toEqual(["Name", "flag"]);
  });

  it("gives an empty header cell an empty label, which the CSS shows no caption for", () => {
    expect(labelsOf(renderTables(table(["", "Value"], ["a", "b"])).table)).toEqual(["", "Value"]);
  });

  it("marks long columns wide and short-value columns nowrap", () => {
    const { table: t } = renderTables(PROSE);
    expect(flagsOf(t, "data-wide")).toEqual([true, false, true]);
    expect(flagsOf(t, "data-nowrap")).toEqual([false, true, false]);
  });

  it("counts visible text only: a link's href does not make a column wide", () => {
    const { table: t } = renderTables(table(["Doc", "Note"], [`[docs](https://example.com/${LONG})`, "ok"]));
    expect(flagsOf(t, "data-wide")).toEqual([false, false]);
  });

  it("makes prose-heavy tables stackable, with explicit roles", () => {
    const { wrap, table: t } = renderTables(PROSE);
    expect(t.hasAttribute("data-stack")).toBe(true);
    expect(wrap.hasAttribute("data-stack")).toBe(true);
    expect(t.getAttribute("role")).toBe("table");
    expect(t.querySelector("tbody")!.getAttribute("role")).toBe("rowgroup");
    expect(t.querySelector("tbody tr")!.getAttribute("role")).toBe("row");
    expect(t.querySelector("td")!.getAttribute("role")).toBe("cell");
    expect(t.querySelector("th")!.getAttribute("role")).toBe("columnheader");
  });

  it("keeps short tables as grids, without roles", () => {
    const { wrap, table: t } = renderTables(NUMERIC);
    expect(t.hasAttribute("data-stack")).toBe(false);
    expect(wrap.hasAttribute("data-stack")).toBe(false);
    expect(t.hasAttribute("role")).toBe(false);
  });

  describe("stack rule", () => {
    const stacks = (md: string) => renderTables(md).table.hasAttribute("data-stack");

    it("stacks two prose columns, even with only two columns", () => {
      expect(stacks(table(["A", "B"], [LONG, LONG]))).toBe(true);
    });

    it("keeps a two-column term/description table a grid", () => {
      expect(stacks(table(["Term", "Description"], ["a", LONG]))).toBe(false);
    });

    it("stacks one prose column among three or more", () => {
      expect(stacks(table(["A", "B", "C"], ["a", "b", LONG]))).toBe(true);
    });

    it("judges prose by the average body cell, at the 40-character boundary", () => {
      expect(stacks(table(["A", "B", "C"], ["a", "b", "y".repeat(40)]))).toBe(true);
      expect(stacks(table(["A", "B", "C"], ["a", "b", "y".repeat(39)]))).toBe(false);
    });

    it("does not stack a numeric comparison because one cell is long", () => {
      const rows = [[LONG, "1", "2"], ...Array.from({ length: 9 }, (_, i) => [`t${i}`, `${i}`, `${i}`])];
      const { table: t } = renderTables(table(["Test", "ms", "Δ"], ...rows));
      expect(t.hasAttribute("data-stack")).toBe(false);
      expect(flagsOf(t, "data-wide")).toEqual([true, false, false]);
    });

    it("never stacks a header-only table, whose header the stacked layout hides", () => {
      expect(stacks(table([LONG, LONG, "c"]))).toBe(false);
    });
  });

  it("classifies each table in a message independently, including nested ones", () => {
    const md = [NUMERIC, "", "> " + PROSE.split("\n").join("\n> "), "", "- item", "", "  " + PROSE.split("\n").join("\n  ")].join("\n");
    const { tables } = renderTables(md);
    expect(tables).toHaveLength(3);
    expect(tables.map((t) => t.hasAttribute("data-stack"))).toEqual([false, true, true]);
    expect(labelsOf(tables[1])).toEqual(["Window", "Hours", "What happened"]);
  });

  it("preserves GFM column alignment", () => {
    const { table: t } = renderTables(PROSE);
    expect((t.querySelector("tbody td:nth-child(2)") as HTMLElement).style.textAlign).toBe("right");
  });
});

describe("MarkdownRenderer table styles", () => {
  const css = readCss("components/MarkdownRenderer.css");

  function withStyles(markdown: string) {
    const { remove } = injectCss(css);
    const rendered = renderTables(markdown);
    return { ...rendered, remove };
  }

  it("undoes the bubble's break-word inside cells, so a column never shrinks below a word", () => {
    const { table: t, remove } = withStyles(PROSE);
    try {
      const outer = document.createElement("div");
      outer.style.wordBreak = "break-word";
      outer.appendChild(t.closest(".md-table-wrap")!);
      document.body.appendChild(outer);
      for (const cell of t.querySelectorAll("th, td")) {
        expect(getComputedStyle(cell).wordBreak).toBe("normal");
      }
      outer.remove();
    } finally {
      remove();
    }
  });

  it("lets wide cells break long tokens and keeps short-value cells on one line", () => {
    const { table: t, remove } = withStyles(PROSE);
    try {
      const [wide, short] = [t.querySelector("td[data-wide]")!, t.querySelector("td[data-nowrap]")!];
      expect(getComputedStyle(wide).overflowWrap).toBe("anywhere");
      expect(getComputedStyle(wide).minWidth).toBe("12em");
      expect(getComputedStyle(short).whiteSpace).toBe("nowrap");
    } finally {
      remove();
    }
  });

  it("stacks marked tables at the chat-layout breakpoint, with visual-only captions", () => {
    const { sheet, remove } = injectCss(css);
    try {
      // jsdom has no CSSContainerRule global; match on the rule text instead.
      const containers = [...sheet.cssRules].filter((rule) => rule.cssText.startsWith("@container")) as CSSContainerRule[];
      expect(containers.map((rule) => rule.conditionText)).toEqual(["chat-layout (max-width: 620px)"]);
      const inner = [...containers[0].cssRules] as CSSStyleRule[];
      // A selector can appear in several rules; find the one declaring `property`.
      const declared = (selector: string, property: string) =>
        inner.find((r) => r.selectorText.split(/,\s*/).includes(selector) && r.style.getPropertyValue(property))?.style.getPropertyValue(property);
      expect(declared(".md-table[data-stack] tr", "display")).toBe("block");
      expect(declared(".md-table[data-stack] td", "white-space")).toBe("normal");
      expect(declared(".md-table[data-stack] thead", "position")).toBe("absolute");
      // Read from the source: jsdom's CSSOM keeps only one of the two
      // `content` declarations, and which one is not what a browser does.
      expect(css).toMatch(/td:not\(\[data-label=""\]\)::before\s*\{[^}]*content:\s*attr\(data-label\)\s*\/\s*"";/);
    } finally {
      remove();
    }
  });
});
