import type { Nodes as HastNodes, Properties } from "hast";
import { find, html as htmlSchema } from "property-information";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/**
 * Renders markdown to a plain HTML fragment for the clipboard.
 *
 * Deliberately not MarkdownRenderer: that one carries inline `var(--…)` styles,
 * syntax-highlight spans and copy buttons, none of which mean anything once
 * pasted into Slack or a doc. Bare semantic tags (`<strong>`, `<ul>`, `<pre>`,
 * `<a>`, `<table>`) are what rich-paste targets map to their own formatting.
 *
 * Same parse as on screen (remark + GFM, raw HTML in the markdown dropped), but
 * serialized here rather than through `react-dom/server` or
 * `hast-util-to-html`: every package below already ships in the bundle via
 * react-markdown, and the alternatives added ~23 kB gzipped for one button.
 */
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype);

export function markdownToHtml(markdown: string): string {
  return serialize(processor.runSync(processor.parse(markdown)));
}

const VOID = new Set(["br", "hr", "img", "input"]);

function serialize(node: HastNodes): string {
  switch (node.type) {
    case "root":
      return node.children.map(serialize).join("");
    case "element": {
      const open = `<${node.tagName}${attributes(node.properties)}>`;
      return VOID.has(node.tagName) ? open : `${open}${node.children.map(serialize).join("")}</${node.tagName}>`;
    }
    case "text":
      return escape(node.value);
    default:
      // Comments, doctypes and `raw` (remark-rehype drops raw HTML unless
      // asked not to) have no place in a pasted message.
      return "";
  }
}

function attributes(props: Properties): string {
  let out = "";
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    const info = find(htmlSchema, key);
    if (value === true) {
      out += ` ${info.attribute}`;
      continue;
    }
    const text = Array.isArray(value) ? value.join(info.commaSeparated ? ", " : " ") : String(value);
    out += ` ${info.attribute}="${escape(text)}"`;
  }
  return out;
}

function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
