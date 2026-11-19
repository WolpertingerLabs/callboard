/**
 * Where an aside's quoted passages are in the main transcript — what the
 * aside highlights paint (hooks/useAsideHighlights.ts).
 *
 * A quote is stored as the message's timestamp, its role and the selected
 * text (shared `AsideQuote`), not as DOM offsets: the transcript is re-rendered
 * from markdown on every load, so offsets would not survive. The passage is
 * found again by text inside the message's `[data-quote-content]` element.
 *
 * Text is matched with all whitespace removed on both sides. A quote is
 * `Selection.toString()` of rendered markdown, which puts `\n\n` between
 * paragraphs and list items where the DOM's text nodes have nothing at all, and
 * normalisation (utils/messageQuotes.ts) collapses blank lines and trims line
 * ends — every one of those is whitespace, and none of them is worth a miss.
 */
import type { AsideQuote } from "shared/types/index.js";
import type { ChatTreeNode, ChatTreeResponse, ParsedMessage } from "../api";
import { ASIDE_ROLE } from "./chatRewrite";
import { hasMarkerSlot } from "./forkMarkers";

/** One aside of the chat on screen, as the highlights and the aside list need it. */
export interface AsideEntry {
  chatId: string;
  title: string;
  status: ChatTreeNode["status"];
  provider: string;
  quotes: readonly AsideQuote[];
  createdAt: string;
  /** For its attention signals (utils/asideAttention.ts). */
  updatedAt: string;
  lastReadAt?: string;
  summon?: ChatTreeNode["summon"];
}

function findNode(node: ChatTreeNode, chatId: string): ChatTreeNode | null {
  if (node.chatId === chatId) return node;
  for (const child of node.children) {
    const hit = findNode(child, chatId);
    if (hit) return hit;
  }
  return null;
}

const NO_ASIDES: readonly AsideEntry[] = Object.freeze([]);

/**
 * The tree's target chat's direct asides, oldest first. Archived ones are
 * left out: archiving an aside is putting it away, and its highlights with it.
 */
export function asidesOf(tree: ChatTreeResponse | null): readonly AsideEntry[] {
  if (!tree) return NO_ASIDES;
  const children = findNode(tree.tree, tree.targetChatId)?.children ?? [];
  const asides = children
    .filter((child) => child.role === ASIDE_ROLE && !child.childArchived)
    .map((child) => ({
      chatId: child.chatId,
      title: child.title || "Aside",
      status: child.status,
      provider: child.provider,
      quotes: child.asideQuotes ?? [],
      createdAt: child.createdAt,
      updatedAt: child.updatedAt,
      ...(child.lastReadAt && { lastReadAt: child.lastReadAt }),
      ...(child.summon && { summon: child.summon }),
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return asides.length > 0 ? asides : NO_ASIDES;
}

/**
 * The transcript indices a quote may be in: the quotable messages with its
 * timestamp and role. Usually one; an engine turn split into several text
 * blocks shares one timestamp, and the passage may be in any of them.
 */
export function quoteCandidates(messages: readonly ParsedMessage[], quote: Pick<AsideQuote, "timestamp" | "role">): number[] {
  const out: number[] = [];
  messages.forEach((message, index) => {
    if (message.timestamp === quote.timestamp && message.role === quote.role && hasMarkerSlot(message)) out.push(index);
  });
  return out;
}

const WHITESPACE = /\s/;

/**
 * The range of `text` inside `root`'s text, matched ignoring whitespace, or
 * null when it is not there (the message was edited away, compressed, or the
 * quote predates a re-render that changed its text).
 */
export function findQuoteRange(root: Element, text: string): Range | null {
  const needle = text.replace(/\s+/g, "");
  if (!needle) return null;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  // The haystack, whitespace removed, with each kept character's node and offset.
  let haystack = "";
  const nodes: Text[] = [];
  const offsets: number[] = [];
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = node.data;
    for (let i = 0; i < value.length; i++) {
      const ch = value[i]!;
      if (WHITESPACE.test(ch)) continue;
      haystack += ch;
      nodes.push(node);
      offsets.push(i);
    }
  }
  const at = haystack.indexOf(needle);
  if (at < 0) return null;
  const end = at + needle.length - 1;
  const range = doc.createRange();
  range.setStart(nodes[at]!, offsets[at]!);
  range.setEnd(nodes[end]!, offsets[end]! + 1);
  return range;
}

/** Each aside's ranges in the transcript rendered under `container`. Quotes that cannot be found are skipped. */
export function locateAsideRanges(container: Element, messages: readonly ParsedMessage[], asides: readonly AsideEntry[]): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  for (const aside of asides) {
    const ranges: Range[] = [];
    for (const quote of aside.quotes) {
      for (const index of quoteCandidates(messages, quote)) {
        const content = container.querySelector(`[data-message-index="${index}"] [data-quote-content]`);
        const range = content && findQuoteRange(content, quote.text);
        if (range) {
          ranges.push(range);
          break;
        }
      }
    }
    if (ranges.length > 0) out.set(aside.chatId, ranges);
  }
  return out;
}
