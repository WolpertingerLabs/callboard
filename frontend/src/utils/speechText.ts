import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * Turns a message's markdown into the plain text read aloud.
 *
 * Same parse as on screen (remark + GFM, as `markdownToHtml` uses), walked into
 * sentences a speech model reads well: code blocks become a short notice
 * rather than being spelled out symbol by symbol, links are spoken as their
 * text (a bare URL as "link to <host>"), images, raw HTML and footnotes are
 * dropped, and headings, list items and table rows each end as a sentence so
 * the voice pauses between them. Blocks are joined with a blank line.
 *
 * A message that is nothing but code comes back as `""` — there is nothing to
 * read, and "Code block omitted." on its own would be noise.
 *
 * Called on click, not per render: a long transcript should not parse every
 * reply twice to offer a button.
 */
const processor = unified().use(remarkParse).use(remarkGfm);

/**
 * The few mdast fields this walk reads. Structural rather than `mdast`'s own
 * types, which the frontend gets only transitively.
 */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
}

const CODE_NOTICE = "Code block omitted.";

export function markdownToSpeechText(markdown: string): string {
  if (!markdown.trim()) return "";
  const blocks: string[] = [];
  let spoken = false;
  const push = (text: string, isCode = false) => {
    const clean = collapse(text);
    if (!clean) return;
    if (!isCode) spoken = true;
    blocks.push(clean);
  };

  const walkBlock = (node: MdNode): void => {
    switch (node.type) {
      case "root":
      case "blockquote":
        node.children?.forEach(walkBlock);
        return;
      case "paragraph":
        push(inline(node));
        return;
      case "heading":
        push(sentence(inline(node)));
        return;
      case "code":
        push(CODE_NOTICE, true);
        return;
      case "list":
        node.children?.forEach(walkBlock);
        return;
      case "listItem": {
        // The item's own text is one sentence; a nested list follows it, in order.
        const own: string[] = [];
        const nested: MdNode[] = [];
        for (const child of node.children ?? []) {
          if (child.type === "paragraph" || child.type === "heading") own.push(inline(child));
          else nested.push(child);
        }
        push(sentence(own.join(" ")));
        nested.forEach(walkBlock);
        return;
      }
      case "table":
        for (const row of node.children ?? []) {
          const cells = (row.children ?? []).map((cell) => collapse(inline(cell))).filter(Boolean);
          if (cells.length) push(sentence(cells.join(", ")));
        }
        return;
      // thematicBreak: already a paragraph break. html, definition,
      // footnoteDefinition, yaml: nothing to say.
      default:
        return;
    }
  };

  walkBlock(processor.parse(markdown) as MdNode);
  return spoken ? blocks.join("\n\n") : "";
}

/** The spoken text of a node's inline content. */
function inline(node: MdNode): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value ?? "";
    case "break":
      return " ";
    case "link": {
      const text = (node.children ?? []).map(inline).join("");
      // An autolink (`<https://…>` or a bare URL) has its URL as its text; reading
      // that aloud character by character helps nobody.
      if (node.url && (text === node.url || `http://${text}` === node.url || `https://${text}` === node.url)) return linkTo(node.url);
      return text;
    }
    case "image":
    case "imageReference":
    case "html":
    case "footnoteReference":
      return "";
    default:
      // paragraph, heading, emphasis, strong, delete, linkReference, tableCell…
      return (node.children ?? []).map(inline).join("");
  }
}

function linkTo(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host) return `link to ${host}`;
  } catch {
    // Not a URL after all — say nothing rather than spell it.
  }
  return "link";
}

/** `text` ending in sentence punctuation, so the voice pauses after it. */
function sentence(text: string): string {
  const clean = collapse(text);
  if (!clean) return "";
  return /[.!?:;…]["'”’)\]]*$/.test(clean) ? clean : `${clean}.`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
