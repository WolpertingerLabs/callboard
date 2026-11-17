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
 *     sideways instead; this plugin marks which columns hold prose
 *     (`data-wide`) so they keep a readable minimum width.
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

/** A column whose longest cell reaches this many characters is "prose". */
export const WIDE_COLUMN_CHARS = 40;

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

  const longest: number[] = [];
  for (const row of allRows) {
    childElements(row, 'th', 'td').forEach((cell, i) => {
      const length = cell.children.map(textOf).join('').trim().length;
      longest[i] = Math.max(longest[i] ?? 0, length);
    });
  }
  const wide = longest.map((length) => length >= WIDE_COLUMN_CHARS);
  const wideCount = wide.filter(Boolean).length;
  const stack = wideCount >= 2 || (wideCount >= 1 && longest.length >= 3);

  for (const row of allRows) {
    childElements(row, 'th', 'td').forEach((cell, i) => {
      if (wide[i]) cell.properties.dataWide = '';
    });
  }
  for (const row of bodyRows) {
    childElements(row, 'th', 'td').forEach((cell, i) => {
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
