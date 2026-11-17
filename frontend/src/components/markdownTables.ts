import type { Element, ElementContent, Root, RootContent } from 'hast';

/**
 * Prepares GFM tables for responsive layout (styles in MarkdownRenderer.css).
 *
 * Two problems this solves, both visible on a phone:
 *
 *  1. Chat bubbles set `word-break: break-word`, which lets a table cell's
 *     min-content width fall to a single character. The browser then crushes
 *     short columns ("Hours" rendered as H/o/u/rs) to give prose columns room.
 *     The CSS restores normal word breaking inside cells and scrolls the table
 *     sideways instead; this plugin marks which columns hold long text
 *     (`data-wide`) so they keep a readable minimum width, and which hold only
 *     short values (`data-nowrap`) so those never wrap.
 *
 *  2. A table whose cells are sentences cannot be readable at phone width as a
 *     grid, scrolling or not. Such tables get `data-stack`, and every body cell
 *     gets `data-label` (its column header), so at narrow chat widths the CSS
 *     re-flows each row into a card of label/value pairs. Short, numeric tables
 *     are left as grids — comparing down a column is the point of those.
 *
 * Stacking turns table parts into `display: block`, which drops their implicit
 * table semantics in some browsers, so stackable tables also carry explicit
 * ARIA roles.
 */

/**
 * A column whose longest cell reaches this many characters gets a readable
 * minimum width (`data-wide`). For stacking, a column is prose when at least
 * PROSE_CELL_SHARE of its non-empty body cells reach this many. A share, not
 * the max: one long test name must not turn a 30-row numeric comparison into
 * 30 cards. Not the mean either: a short row or a `—` placeholder must not
 * cancel out a column that is mostly sentences.
 */
export const WIDE_COLUMN_CHARS = 40;

/** Share of a column's non-empty body cells that must be long for it to be prose. */
export const PROSE_CELL_SHARE = 1 / 3;

/**
 * A column whose cells are all single tokens at most this long never wraps
 * (`data-nowrap`). Such values are atoms — `--dry-run`, `v1.2.3`, `~7.5` —
 * that read wrong split at a hyphen, and the wrapper scrolls if a row of them
 * overflows. Phrases ("Needs review") are excluded: they wrap at their spaces.
 */
export const NOWRAP_COLUMN_CHARS = 20;

function isElement(node: RootContent | ElementContent | Root): node is Element {
  return node.type === 'element';
}

function textOf(node: RootContent | ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

function childElements(node: Element, ...tags: string[]): Element[] {
  return node.children.filter((child): child is Element => isElement(child) && tags.includes(child.tagName));
}

function prepareTable(table: Element): void {
  const sections = childElements(table, 'thead', 'tbody');
  const head = sections.find((s) => s.tagName === 'thead');
  const bodies = sections.filter((s) => s.tagName === 'tbody');
  const headRows = head ? childElements(head, 'tr') : [];
  const bodyRows = bodies.flatMap((body) => childElements(body, 'tr'));
  const allRows = [...headRows, ...bodyRows];
  if (allRows.length === 0) return;

  const labels = (headRows[0] ? childElements(headRows[0], 'th', 'td') : []).map((cell) =>
    cell.children.map(textOf).join('').trim(),
  );

  const lengthOf = (cell: Element) => cell.children.map(textOf).join('').trim().length;
  const longest: number[] = [];
  // Whether a column is all short single tokens is a property of its VALUES:
  // a "CLI flag" header over `--dry-run` cells must not disqualify it.
  const bodyLongest: number[] = [];
  const bodyHasSpace: boolean[] = [];
  const bodyFilled: number[] = [];
  const bodyLong: number[] = [];
  for (const row of allRows) {
    childElements(row, 'th', 'td').forEach((cell, i) => {
      longest[i] = Math.max(longest[i] ?? 0, lengthOf(cell));
    });
  }
  for (const row of bodyRows) {
    childElements(row, 'th', 'td').forEach((cell, i) => {
      const length = lengthOf(cell);
      bodyLongest[i] = Math.max(bodyLongest[i] ?? 0, length);
      if (/\s/.test(cell.children.map(textOf).join('').trim())) bodyHasSpace[i] = true;
      if (length === 0) return;
      bodyFilled[i] = (bodyFilled[i] ?? 0) + 1;
      if (length >= WIDE_COLUMN_CHARS) bodyLong[i] = (bodyLong[i] ?? 0) + 1;
    });
  }
  const columns = longest.length;
  const wide = longest.map((length) => length >= WIDE_COLUMN_CHARS);
  const nowrap = longest.map((_, i) => bodyLongest[i] !== undefined && bodyLongest[i] <= NOWRAP_COLUMN_CHARS && !bodyHasSpace[i]);
  const proseCount = longest.filter((_, i) => (bodyLong[i] ?? 0) > 0 && (bodyLong[i] ?? 0) >= PROSE_CELL_SHARE * (bodyFilled[i] ?? 0)).length;
  // A header-only table must not stack: its header is hidden in the stacked
  // layout, so it would render as nothing (briefly true of every streamed table).
  const stack = bodyRows.length > 0 && (proseCount >= 2 || (proseCount >= 1 && columns >= 3));

  for (const row of allRows) {
    childElements(row, 'th', 'td').forEach((cell, i) => {
      if (wide[i]) cell.properties.dataWide = '';
    });
  }
  // Body cells only: a header wraps at its spaces like any other heading.
  for (const row of bodyRows) {
    childElements(row, 'th', 'td').forEach((cell, i) => {
      if (nowrap[i]) cell.properties.dataNowrap = '';
      cell.properties.dataLabel = labels[i] ?? '';
    });
  }

  if (!stack) return;
  table.properties.dataStack = '';
  table.properties.role = 'table';
  for (const section of sections) section.properties.role = 'rowgroup';
  for (const row of allRows) {
    row.properties.role = 'row';
    for (const cell of childElements(row, 'th', 'td')) {
      cell.properties.role = cell.tagName === 'th' ? 'columnheader' : 'cell';
    }
  }
}

function walk(node: Root | Element): void {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (child.tagName === 'table') prepareTable(child);
    else walk(child);
  }
}

export default function rehypeResponsiveTables() {
  return (tree: Root) => walk(tree);
}
